import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { DEFAULT_MAX_BYTES, truncateHeadBytes } from "../session/streaming-output";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { formatOutputNotice, type OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

/** Maximum independent targets accepted by one native read array, shared by schema and runtime validation. */
export const MAX_READ_PATHS = 32;
const READ_PATH_CONCURRENCY = 4;
const READ_BATCH_MAX_TEXT_BYTES = DEFAULT_MAX_BYTES;
const READ_BATCH_MAX_IMAGE_BYTES = MAX_IMAGE_INPUT_BYTES;
const READ_BATCH_MAX_COMPLETED_RESULTS = 16;
const READ_BATCH_MAX_COMPLETED_BYTES =
	2 * (READ_BATCH_MAX_TEXT_BYTES + Math.ceil((READ_BATCH_MAX_IMAGE_BYTES * 4) / 3));

/** Per-target severity used to aggregate batch status and render outcome icons. */
export type ReadTargetStatus = "success" | "warning" | "error";

/** Stable metadata for one target in a batched or delimiter-recovered read. */
export interface ReadTargetOutcome {
	/** Path shown in the grouped read UI, including any inline selector. */
	path: string;
	status: ReadTargetStatus;
	/**
	 * False when batch budgeting omitted or truncated any of this target's payload.
	 * Absent (or true) means complete, preserving compatibility with older producers.
	 */
	payloadComplete?: boolean;
	/** Original path when suffix recovery corrected it to {@link path}. */
	requestedPath?: string;
	/** Resolved filesystem path used for clickable terminal/ACP locations. */
	resolvedPath?: string;
	conflictCount?: number;
	message?: string;
}

/** Aggregate metadata exposed to renderers and protocol consumers for a multi-target read. */
export interface ReadBatchDetails {
	notes?: string[];
	meta?: OutputMeta;
	/** Paths in a batched or delimiter-recovered read; retained for simple result consumers. */
	displayReadTargets?: string[];
	/** Per-target batch outcomes, including partial failures and warnings. */
	readTargetOutcomes?: ReadTargetOutcome[];
}

/** Minimum per-part details the batch consumer needs to preserve resolution and warning metadata. */
export interface ReadBatchPartDetails extends ReadBatchDetails {
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	conflictCount?: number;
}

interface LimitedBatchPartResult<TDetails extends ReadBatchPartDetails> {
	result: AgentToolResult<TDetails>;
	budgetNotes: string[];
	textBytes: number;
	imageBytes: number;
}

interface BufferedBatchPartResult<TDetails extends ReadBatchPartDetails> {
	settled: PromiseSettledResult<LimitedBatchPartResult<TDetails>>;
	bufferBytes: number;
}

type ContentOwner = number | readonly number[] | undefined;

/** Inputs for the ordered, bounded executor used by native arrays and recovered path lists. */
export interface ExecuteReadBatchOptions<TDetails extends ReadBatchPartDetails> {
	parts: string[];
	notice: string;
	enforceAggregateBudget: boolean;
	signal?: AbortSignal;
	readPart: (part: string, signal: AbortSignal) => Promise<AgentToolResult<TDetails>>;
}

function limitBatchPartResult<TDetails extends ReadBatchPartDetails>(
	result: AgentToolResult<TDetails>,
	part: string,
	textBudget: number,
	imageBudget: number,
): LimitedBatchPartResult<TDetails> {
	let remainingTextBytes = textBudget;
	let remainingImageBytes = imageBudget;
	let textTruncated = false;
	let imageOmitted = false;
	const content: Array<TextContent | ImageContent> = [];

	for (const block of result.content) {
		if (block.type === "text") {
			if (textTruncated) continue;
			const blockBytes = Buffer.byteLength(block.text, "utf8");
			if (blockBytes <= remainingTextBytes) {
				content.push(block);
				remainingTextBytes -= blockBytes;
				continue;
			}
			const truncated = truncateHeadBytes(block.text, remainingTextBytes);
			if (truncated.text.length > 0) content.push({ type: "text", text: truncated.text });
			remainingTextBytes = 0;
			textTruncated = true;
			continue;
		}

		const blockBytes = Buffer.byteLength(block.data, "base64");
		if (blockBytes <= remainingImageBytes) {
			content.push(block);
			remainingImageBytes -= blockBytes;
		} else {
			imageOmitted = true;
		}
	}

	const budgetNotes: string[] = [];
	if (textTruncated) {
		budgetNotes.push(
			`The batch text budget was exhausted while reading ${part}; read it separately or use a narrower selector for the omitted content.`,
		);
	}
	if (imageOmitted) {
		budgetNotes.push(
			`The batch image budget was exhausted while reading ${part}; read it separately to inspect the omitted image.`,
		);
	}
	return {
		result: budgetNotes.length === 0 ? result : { ...result, content },
		budgetNotes,
		textBytes: textBudget - remainingTextBytes,
		imageBytes: imageBudget - remainingImageBytes,
	};
}

function batchResultBufferBytes(result: AgentToolResult<ReadBatchPartDetails>): number {
	let bytes = 0;
	for (const block of result.content) {
		bytes += Buffer.byteLength(block.type === "text" ? block.text : block.data, "utf8");
	}
	return bytes;
}

function capBatchTextContent(
	content: Array<TextContent | ImageContent>,
	contentOwners: ContentOwner[],
	contentProtected: boolean[],
	outcomes: ReadTargetOutcome[],
	notes: string[],
): Array<TextContent | ImageContent> {
	const totalBytes = content.reduce(
		(total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text, "utf8") : 0),
		0,
	);
	if (totalBytes <= READ_BATCH_MAX_TEXT_BYTES) return content;

	const finalCapWarning =
		"The aggregate batch text cap omitted trailing output; read affected targets separately for complete content.";
	const marker = `\n\n[Batch text output capped at ${READ_BATCH_MAX_TEXT_BYTES} bytes; see per-target outcomes.]`;
	const availableBytes = Math.max(0, READ_BATCH_MAX_TEXT_BYTES - Buffer.byteLength(marker, "utf8"));
	const protectedBytes = content.reduce(
		(total, block, index) =>
			total + (block.type === "text" && contentProtected[index] ? Buffer.byteLength(block.text, "utf8") : 0),
		0,
	);
	let protectedRemaining = Math.min(protectedBytes, availableBytes);
	let regularRemaining = Math.max(0, availableBytes - protectedBytes);
	const limited: Array<TextContent | ImageContent> = [];
	const affectedOutcomes = new Set<number>();

	for (const [index, block] of content.entries()) {
		if (block.type !== "text") {
			limited.push(block);
			continue;
		}
		const owner = contentOwners[index];
		const protectedBlock = contentProtected[index] === true;
		const remainingBytes = protectedBlock ? protectedRemaining : regularRemaining;
		const blockBytes = Buffer.byteLength(block.text, "utf8");
		const truncated = truncateHeadBytes(block.text, remainingBytes);
		if (truncated.text.length > 0) limited.push({ type: "text", text: truncated.text });
		if (protectedBlock) {
			protectedRemaining -= truncated.bytes;
		} else {
			regularRemaining -= truncated.bytes;
		}
		if (truncated.bytes < blockBytes) {
			if (typeof owner === "number") {
				affectedOutcomes.add(owner);
			} else {
				for (const outcomeIndex of owner ?? []) affectedOutcomes.add(outcomeIndex);
			}
		}
	}

	for (const index of affectedOutcomes) {
		const outcome = outcomes[index];
		if (!outcome) continue;
		outcome.payloadComplete = false;
		if (outcome.status === "error") continue;
		outcome.status = "warning";
		outcome.message = outcome.message ? `${outcome.message} ${finalCapWarning}` : finalCapWarning;
	}
	if (!notes.includes(finalCapWarning)) notes.push(finalCapWarning);
	limited.push({ type: "text", text: marker });
	return limited;
}

function coalesceBatchTextContent(content: Array<TextContent | ImageContent>): Array<TextContent | ImageContent> {
	const merged: Array<TextContent | ImageContent> = [];
	for (const block of content) {
		const previous = merged.at(-1);
		if (block.type === "text" && previous?.type === "text") {
			merged[merged.length - 1] = { type: "text", text: previous.text + block.text };
		} else {
			merged.push(block);
		}
	}
	return merged;
}

/**
 * Read independent targets with four workers while an input-ordered consumer
 * incorporates their results. A count- and byte-bounded completion queue lets
 * workers continue behind a slow earlier target without retaining the full
 * batch. Native arrays also receive strict aggregate text and image budgets;
 * legacy scalar-delimited recovery opts out to preserve its existing output.
 */
export async function executeReadBatch<TDetails extends ReadBatchPartDetails>(
	options: ExecuteReadBatchOptions<TDetails>,
): Promise<AgentToolResult<ReadBatchDetails>> {
	const { parts, notice, enforceAggregateBudget, signal, readPart } = options;
	const notes = [notice];
	const content: Array<TextContent | ImageContent> = [];
	const contentProtected: boolean[] = [];
	const contentOwners: ContentOwner[] = [];
	const readTargetOutcomes: ReadTargetOutcome[] = [];
	let remainingTextBytes = enforceAggregateBudget
		? Math.max(0, READ_BATCH_MAX_TEXT_BYTES - Buffer.byteLength(notice, "utf8"))
		: Number.MAX_SAFE_INTEGER;
	let remainingImageBytes = enforceAggregateBudget ? READ_BATCH_MAX_IMAGE_BYTES : Number.MAX_SAFE_INTEGER;
	let pendingText = notice;
	let pendingTextOwner: ContentOwner;
	let pendingTextProtected = true;
	let deferredFatal: { reason: unknown } | undefined;

	const flushText = () => {
		if (pendingText.length === 0) return;
		content.push({ type: "text", text: pendingText });
		contentOwners.push(pendingTextOwner);
		contentProtected.push(pendingTextProtected);
		pendingText = "";
		pendingTextOwner = undefined;
		pendingTextProtected = false;
	};
	const appendText = (text: string, owner?: number | readonly number[], protectedText = false) => {
		const groupChanged =
			pendingText.length > 0 && (pendingTextOwner !== owner || pendingTextProtected !== protectedText);
		if (groupChanged) flushText();
		pendingText = pendingText.length > 0 ? `${pendingText}\n\n${text}` : groupChanged ? `\n\n${text}` : text;
		pendingTextOwner = owner;
		pendingTextProtected = protectedText;
	};
	const appendTargetHeader = (part: string, index: number, owner: number | readonly number[]) => {
		if (parts.length < 2) return;
		appendText(`[Read target ${index + 1}/${parts.length}: ${JSON.stringify(part)}]`, owner, true);
	};
	const consumeSettledResult = (index: number, settled: PromiseSettledResult<LimitedBatchPartResult<TDetails>>) => {
		const part = parts[index];
		if (part === undefined) throw new ToolError(`Read batch did not execute slot ${index}`);
		if (settled.status === "rejected") {
			const error = settled.reason;
			if (error instanceof ToolAbortError) throw error;
			throwIfAborted(signal);
			const message = error instanceof Error ? error.message : String(error);
			const errorNote = `Could not read ${part}: ${message}`;
			notes.push(errorNote);
			const owner = readTargetOutcomes.length;
			readTargetOutcomes.push({ path: part, status: "error", message });
			appendTargetHeader(part, index, owner);
			appendText(`[${errorNote}]`, owner, true);
			return;
		}

		const prepared = settled.value;
		const limited = limitBatchPartResult(prepared.result, part, remainingTextBytes, remainingImageBytes);
		if (enforceAggregateBudget) {
			remainingTextBytes -= limited.textBytes;
			remainingImageBytes -= limited.imageBytes;
		}
		const budgetNotes = [...new Set([...prepared.budgetNotes, ...limited.budgetNotes])];
		const { result } = limited;
		const outputNotice = formatOutputNotice(result.details?.meta);
		const targetWarnings = outputNotice ? [...budgetNotes, outputNotice.trim()] : budgetNotes;
		for (const nestedNote of result.details?.notes ?? []) {
			if (!notes.includes(nestedNote)) notes.push(nestedNote);
		}
		const nestedOutcomes = result.details?.readTargetOutcomes;
		let owner: number | readonly number[];
		if (nestedOutcomes?.length) {
			const firstOwner = readTargetOutcomes.length;
			for (const outcome of nestedOutcomes) {
				let combinedOutcome: ReadTargetOutcome =
					targetWarnings.length > 0 && outcome.status === "success"
						? { ...outcome, status: "warning" as const, message: targetWarnings.join(" ") }
						: outcome;
				if (budgetNotes.length > 0) combinedOutcome = { ...combinedOutcome, payloadComplete: false };
				readTargetOutcomes.push(combinedOutcome);
			}
			owner = Array.from({ length: nestedOutcomes.length }, (_, nestedIndex) => firstOwner + nestedIndex);
		} else {
			const suffixResolution = result.details?.suffixResolution;
			const status: ReadTargetStatus = result.isError
				? "error"
				: targetWarnings.length > 0 || suffixResolution !== undefined || (result.details?.conflictCount ?? 0) > 0
					? "warning"
					: "success";
			const source = result.details?.meta?.source;
			const correctedPath =
				suffixResolution && part.startsWith(suffixResolution.from)
					? `${suffixResolution.to}${part.slice(suffixResolution.from.length)}`
					: (suffixResolution?.to ?? part);
			owner = readTargetOutcomes.length;
			readTargetOutcomes.push({
				path: correctedPath,
				status,
				requestedPath: suffixResolution?.from,
				resolvedPath: result.details?.resolvedPath ?? (source?.type === "path" ? source.value : undefined),
				conflictCount: result.details?.conflictCount,
				message: targetWarnings.length > 0 ? targetWarnings.join(" ") : undefined,
				...(budgetNotes.length > 0 ? { payloadComplete: false } : {}),
			});
		}
		appendTargetHeader(part, index, owner);
		for (const block of result.content) {
			if (block.type === "text") {
				appendText(block.text, owner);
				continue;
			}
			flushText();
			content.push(block);
			contentOwners.push(owner);
			contentProtected.push(false);
		}
		if (outputNotice) appendText(outputNotice.trim(), owner, true);
		for (const budgetNote of budgetNotes) {
			notes.push(budgetNote);
			appendText(`[${budgetNote}]`, owner, true);
		}
	};

	const slots: Array<PromiseWithResolvers<BufferedBatchPartResult<TDetails> | undefined> | undefined> = Array.from(
		{ length: parts.length },
		() => Promise.withResolvers<BufferedBatchPartResult<TDetails> | undefined>(),
	);
	const resolvedSlots = new Array<boolean>(parts.length).fill(false);
	const workerSignal = signal ?? new AbortController().signal;
	const bufferWaiters = new Set<() => void>();
	let nextIndex = 0;
	let consumeIndex = 0;
	let completedResults = 0;
	let completedBytes = 0;

	const wakeBufferWaiters = () => {
		for (const wake of bufferWaiters) wake();
		bufferWaiters.clear();
	};
	const reserveCompletedBuffer = async (index: number, bytes: number) => {
		while (
			index !== consumeIndex &&
			(completedResults >= READ_BATCH_MAX_COMPLETED_RESULTS ||
				(completedBytes > 0 && completedBytes + bytes > READ_BATCH_MAX_COMPLETED_BYTES))
		) {
			throwIfAborted(workerSignal);
			const waiter = Promise.withResolvers<void>();
			const onAbort = () => waiter.resolve();
			bufferWaiters.add(waiter.resolve);
			workerSignal.addEventListener("abort", onAbort, { once: true });
			if (workerSignal.aborted) waiter.resolve();
			await waiter.promise;
			workerSignal.removeEventListener("abort", onAbort);
			bufferWaiters.delete(waiter.resolve);
		}
		throwIfAborted(workerSignal);
		completedResults++;
		completedBytes += bytes;
	};
	const releaseCompletedBuffer = (bytes: number) => {
		completedResults--;
		completedBytes -= bytes;
		consumeIndex++;
		wakeBufferWaiters();
	};

	const worker = async () => {
		while (!workerSignal.aborted) {
			const index = nextIndex++;
			if (index >= parts.length) return;
			const part = parts[index];
			if (part === undefined) return;
			let settled: PromiseSettledResult<LimitedBatchPartResult<TDetails>>;
			let bufferBytes = 0;
			try {
				const result = await readPart(part, workerSignal);
				const prepared = limitBatchPartResult(
					result,
					part,
					enforceAggregateBudget ? READ_BATCH_MAX_TEXT_BYTES : Number.MAX_SAFE_INTEGER,
					enforceAggregateBudget ? READ_BATCH_MAX_IMAGE_BYTES : Number.MAX_SAFE_INTEGER,
				);
				settled = { status: "fulfilled", value: prepared };
				bufferBytes = batchResultBufferBytes(prepared.result);
			} catch (reason) {
				settled = { status: "rejected", reason };
			}
			try {
				await reserveCompletedBuffer(index, bufferBytes);
			} catch {
				return;
			}
			resolvedSlots[index] = true;
			slots[index]?.resolve({ settled, bufferBytes });
		}
	};
	const workersDone = Promise.all(
		Array.from({ length: Math.min(READ_PATH_CONCURRENCY, parts.length) }, () => worker()),
	).then(() => {
		for (const [index, slot] of slots.entries()) {
			if (!resolvedSlots[index]) slot?.resolve(undefined);
		}
	});

	for (const [index, slot] of slots.entries()) {
		if (!slot) {
			deferredFatal ??= { reason: new ToolError(`Read batch lost result slot ${index}`) };
			consumeIndex++;
			wakeBufferWaiters();
			continue;
		}
		const buffered = await slot.promise;
		slots[index] = undefined;
		if (!buffered) {
			if (!workerSignal.aborted) {
				deferredFatal ??= {
					reason: new ToolError(`Read batch did not execute path '${parts[index] ?? ""}'`),
				};
			}
			consumeIndex++;
			wakeBufferWaiters();
			continue;
		}
		try {
			consumeSettledResult(index, buffered.settled);
		} catch (reason) {
			deferredFatal ??= { reason };
		} finally {
			releaseCompletedBuffer(buffered.bufferBytes);
		}
	}
	await workersDone;
	throwIfAborted(signal);
	if (deferredFatal) throw deferredFatal.reason;
	flushText();

	const cappedContent = enforceAggregateBudget
		? capBatchTextContent(content, contentOwners, contentProtected, readTargetOutcomes, notes)
		: content;
	const resultBuilder = toolResult<ReadBatchDetails>({
		notes,
		displayReadTargets: readTargetOutcomes.map(outcome => outcome.path),
		readTargetOutcomes,
	}).content(coalesceBatchTextContent(cappedContent));
	if (
		enforceAggregateBudget &&
		readTargetOutcomes.length > 0 &&
		readTargetOutcomes.every(outcome => outcome.status === "error")
	) {
		resultBuilder.error();
	}
	return resultBuilder.done();
}
