import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
	PrimeImportLoss,
	PrimeImportSourceDiscovery,
	PrimeJsonValue,
	PrimeNormalizedSession,
	PrimeNormalizedSessionEntry,
	PrimeNormalizedSessionHeader,
	PrimeSessionContent,
	PrimeSessionContentBlock,
	PrimeSessionJsonObject,
	PrimeSessionMessage,
	PrimeSessionParserResult,
	PrimeSourceFile,
} from "./types";

type ParsedRow = {
	readonly value: PrimeJsonValue;
	readonly line: number;
	readonly byteOffset: number;
	readonly byteLength: number;
};
function isRecord(value: PrimeJsonValue | undefined): value is PrimeSessionJsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}
type RawEntry = PrimeSessionJsonObject;

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function loss(
	code: PrimeImportLoss["code"],
	sourceRef: string,
	row?: Pick<ParsedRow, "line" | "byteOffset" | "byteLength">,
	path?: string,
): PrimeImportLoss {
	return {
		code,
		domain: "sessions",
		sourceRef,
		...(path === undefined ? {} : { path }),
		...(row === undefined ? {} : { line: row.line, byteOffset: row.byteOffset, byteLength: row.byteLength }),
	};
}

function stableLegacyId(sourceRef: string, physicalIndex: number): string {
	return createHash("sha256").update(`${sourceRef}\u0000${physicalIndex}`).digest("hex").slice(0, 8);
}

const PRIME_JSON_MAX_STRUCTURAL_DEPTH = 256;
const PRIME_JSON_MAX_NODES = 10_000;

type CloneJsonResult = {
	readonly value: PrimeJsonValue | undefined;
	readonly budgetExceeded: boolean;
};

type CloneFrame =
	| {
			readonly source: readonly unknown[];
			readonly target: PrimeJsonValue[];
			index: number;
			readonly depth: number;
			readonly array: true;
	  }
	| {
			readonly source: Record<string, unknown>;
			readonly target: Record<string, PrimeJsonValue>;
			readonly keys: Generator<string>;
			readonly depth: number;
			readonly array: false;
	  };

function* ownEnumerableKeys(source: object): Generator<string> {
	for (const key in source) {
		if (Object.hasOwn(source, key)) yield key;
	}
}

function cloneJson(value: unknown): CloneJsonResult {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return { value, budgetExceeded: false };
	}
	if (typeof value === "number") return { value: Number.isFinite(value) ? value : undefined, budgetExceeded: false };
	if (typeof value !== "object") return { value: undefined, budgetExceeded: false };

	const rootDepth = 0;
	if (rootDepth >= PRIME_JSON_MAX_STRUCTURAL_DEPTH) return { value: undefined, budgetExceeded: true };
	const root = Array.isArray(value)
		? ([] as PrimeJsonValue[])
		: (Object.create(null) as Record<string, PrimeJsonValue>);
	const frames: CloneFrame[] = Array.isArray(value)
		? [{ source: value, target: root as PrimeJsonValue[], index: 0, depth: rootDepth, array: true }]
		: [
				{
					source: value as Record<string, unknown>,
					target: root as Record<string, PrimeJsonValue>,
					keys: ownEnumerableKeys(value),
					depth: rootDepth,
					array: false,
				},
			];
	let nodes = 1;
	while (frames.length > 0) {
		const frame = frames[frames.length - 1]!;
		let key: string | number;
		let child: unknown;
		if (frame.array) {
			if (frame.index >= frame.source.length) {
				frames.pop();
				continue;
			}
			key = frame.index;
			child = frame.source[frame.index];
			frame.index += 1;
		} else {
			const next = frame.keys.next();
			if (next.done) {
				frames.pop();
				continue;
			}
			key = next.value;
			child = frame.source[key];
		}
		if (nodes >= PRIME_JSON_MAX_NODES) return { value: undefined, budgetExceeded: true };
		nodes += 1;
		const childDepth = frame.depth + 1;
		const assign = (cloned: PrimeJsonValue): void => {
			if (frame.array) frame.target[key as number] = cloned;
			else frame.target[key as string] = cloned;
		};
		if (child === null || typeof child === "string" || typeof child === "boolean") {
			assign(child);
			continue;
		}
		if (typeof child === "number") {
			if (!Number.isFinite(child)) return { value: undefined, budgetExceeded: false };
			assign(child);
			continue;
		}
		if (typeof child !== "object") return { value: undefined, budgetExceeded: false };
		if (childDepth >= PRIME_JSON_MAX_STRUCTURAL_DEPTH) return { value: undefined, budgetExceeded: true };
		if (Array.isArray(child)) {
			const childTarget: PrimeJsonValue[] = [];
			assign(childTarget);
			frames.push({ source: child, target: childTarget, index: 0, depth: childDepth, array: true });
		} else {
			const childTarget = Object.create(null) as Record<string, PrimeJsonValue>;
			assign(childTarget);
			frames.push({
				source: child as Record<string, unknown>,
				target: childTarget,
				keys: ownEnumerableKeys(child),
				depth: childDepth,
				array: false,
			});
		}
	}
	return { value: root, budgetExceeded: false };
}
function strictBase64(value: string): Buffer | undefined {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64") === value ? bytes : undefined;
}

function hasInvalidInlineImage(value: PrimeJsonValue | undefined): boolean {
	if (Array.isArray(value)) return value.some(item => hasInvalidInlineImage(item));
	if (!isRecord(value)) return false;
	if (value.type === "image") {
		return (
			typeof value.data !== "string" || typeof value.mimeType !== "string" || strictBase64(value.data) === undefined
		);
	}
	return Object.values(value).some(item => hasInvalidInlineImage(item));
}
function parseLine(value: Buffer): CloneJsonResult {
	try {
		const parsed: unknown = JSON.parse(value.toString("utf8").replace(/\r$/, ""));
		return cloneJson(parsed);
	} catch (error) {
		return { value: undefined, budgetExceeded: error instanceof RangeError };
	}
}

function likelyTruncatedTail(value: Buffer): boolean {
	const text = value.toString("utf8").trim();
	if (!text || text.includes("\u2028") || text.includes("\u2029")) return false;
	return text.startsWith("{") && !/[}\]]$/.test(text);
}

type ParsedRows = {
	readonly rows: ParsedRow[];
	readonly nonHeaderRows: number;
	readonly rowBudgetExceeded: boolean;
};

function parseJsonl(file: PrimeSourceFile, losses: PrimeImportLoss[], maxRows: number): ParsedRows {
	const bytes = Buffer.from(file.contentBase64, "base64");
	const rows: ParsedRow[] = [];
	let nonHeaderRows = 0;
	let rowBudgetExceeded = false;
	let nonblankRows = 0;
	let sawHeaderRow = false;
	let start = 0;
	let line = 1;
	while (start < bytes.length) {
		const found = bytes.indexOf(0x0a, start);
		const end = found < 0 ? bytes.length : found;
		const slice = bytes.subarray(start, end);
		const row = { line, byteOffset: start, byteLength: slice.length };
		if (slice.toString("utf8").trim()) {
			if (sawHeaderRow) nonHeaderRows += 1;
			sawHeaderRow = true;
			if (nonblankRows >= maxRows) {
				losses.push(loss("source-budget-exceeded", file.sourceRef, row));
				rowBudgetExceeded = true;
				break;
			}
			nonblankRows += 1;
			const parsed = parseLine(slice);
			if (parsed.value === undefined || !isRecord(parsed.value)) {
				losses.push(
					loss(
						parsed.budgetExceeded
							? "source-budget-exceeded"
							: found < 0 && likelyTruncatedTail(slice)
								? "sessions-truncated-tail"
								: "sessions-malformed",
						file.sourceRef,
						row,
					),
				);
				if (parsed.budgetExceeded) {
					rowBudgetExceeded = true;
					break;
				}
			} else rows.push({ value: parsed.value, ...row });
		}
		if (found < 0) break;
		start = end + 1;
		line += 1;
	}
	return { rows, nonHeaderRows, rowBudgetExceeded };
}

function isContentBlock(value: PrimeJsonValue | undefined): value is PrimeSessionContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "image")
		return (
			typeof value.data === "string" && typeof value.mimeType === "string" && strictBase64(value.data) !== undefined
		);
	return false;
}
function usesWindowsPathSemantics(sourcePath: string, outputPath: string): boolean {
	return (
		path.win32.isAbsolute(sourcePath) ||
		path.win32.isAbsolute(outputPath) ||
		sourcePath.includes("\\") ||
		outputPath.includes("\\")
	);
}

function resolveFullOutputPath(sourceFile: PrimeSourceFile, outputPath: string): { path: string; windows: boolean } {
	const windows = usesWindowsPathSemantics(sourceFile.canonicalPath, outputPath);
	if (windows) {
		const sourcePath = path.win32.normalize(sourceFile.canonicalPath);
		return {
			path: path.win32.resolve(path.win32.dirname(sourcePath), outputPath),
			windows,
		};
	}
	return {
		path: path.posix.resolve(path.posix.dirname(sourceFile.canonicalPath), outputPath),
		windows,
	};
}

function findFullOutputFile(
	sourceFile: PrimeSourceFile,
	outputPath: string,
	fullOutputFiles: readonly PrimeSourceFile[],
): { file: PrimeSourceFile | undefined; path: string } {
	const resolved = resolveFullOutputPath(sourceFile, outputPath);
	const resolvedPath = resolved.windows ? path.win32.normalize(resolved.path).toLowerCase() : resolved.path;
	const outputFile = fullOutputFiles.find(candidate => {
		const candidatePath = resolved.windows
			? path.win32.normalize(candidate.canonicalPath).toLowerCase()
			: path.posix.normalize(candidate.canonicalPath);
		return candidatePath === resolvedPath;
	});
	return { file: outputFile, path: resolved.path };
}

function requiredString(value: PrimeJsonValue | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function baseEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
): { id: string; parentId: string | null; timestamp: string } {
	return { id, parentId, timestamp };
}

function isContent(value: PrimeJsonValue | undefined): value is PrimeSessionContent {
	return typeof value === "string" || (Array.isArray(value) && value.every(item => isContentBlock(item)));
}

function isAssistantBlock(value: PrimeJsonValue): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (isContentBlock(value)) return true;
	if (value.type === "thinking") {
		if (value.redacted === true) return typeof value.thinkingSignature === "string";
		return typeof value.thinking === "string";
	}
	if (value.type === "redactedThinking") return typeof value.data === "string";
	if (value.type === "toolCall")
		return requiredString(value.id) && requiredString(value.name) && isRecord(value.arguments);
	return false;
}

function isUsage(value: PrimeJsonValue | undefined): value is PrimeSessionJsonObject {
	if (!isRecord(value)) return false;
	const cost = value.cost;
	if (!isRecord(cost)) return false;
	const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
	const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"];
	return (
		usageKeys.every(key => typeof value[key] === "number") && costKeys.every(key => typeof cost[key] === "number")
	);
}

function isStopReason(value: PrimeJsonValue | undefined): value is string {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function normalizeMessage(raw: PrimeSessionJsonObject): PrimeSessionMessage | undefined {
	const role = raw.role;
	if (role === "user") {
		if (!isContent(raw.content) || typeof raw.timestamp !== "number") return undefined;
		return { role: "user", content: raw.content, timestamp: raw.timestamp };
	}
	if (role === "assistant") {
		if (
			!Array.isArray(raw.content) ||
			!raw.content.every(isAssistantBlock) ||
			!requiredString(raw.api) ||
			!requiredString(raw.provider) ||
			!requiredString(raw.model) ||
			!isUsage(raw.usage) ||
			!isStopReason(raw.stopReason) ||
			typeof raw.timestamp !== "number"
		)
			return undefined;
		const content = raw.content.map(block => {
			if (
				isRecord(block) &&
				block.type === "thinking" &&
				block.redacted === true &&
				typeof block.thinkingSignature === "string"
			)
				return { type: "redactedThinking", data: block.thinkingSignature };
			return block;
		});
		return {
			role: "assistant",
			content,
			api: raw.api,
			provider: raw.provider,
			model: raw.model,
			usage: raw.usage,
			stopReason: raw.stopReason,
			timestamp: raw.timestamp,
			...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}),
			...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}),
		};
	}
	if (role === "toolResult") {
		if (
			!requiredString(raw.toolCallId) ||
			!requiredString(raw.toolName) ||
			!Array.isArray(raw.content) ||
			!raw.content.every(isContentBlock) ||
			typeof raw.isError !== "boolean" ||
			typeof raw.timestamp !== "number"
		)
			return undefined;
		const details = cloneJson(raw.details).value;
		return {
			role: "toolResult",
			toolCallId: raw.toolCallId,
			toolName: raw.toolName,
			content: raw.content,
			isError: raw.isError,
			...(details === undefined ? {} : { details }),
			timestamp: raw.timestamp,
		};
	}
	if (role === "bashExecution") {
		if (
			typeof raw.command !== "string" ||
			typeof raw.output !== "string" ||
			(raw.exitCode !== undefined && typeof raw.exitCode !== "number") ||
			typeof raw.cancelled !== "boolean" ||
			typeof raw.truncated !== "boolean" ||
			(raw.excludeFromContext !== undefined && typeof raw.excludeFromContext !== "boolean") ||
			typeof raw.timestamp !== "number"
		)
			return undefined;
		return {
			role: "bashExecution",
			command: raw.command,
			output: raw.output,
			exitCode: raw.exitCode,
			cancelled: raw.cancelled,
			truncated: raw.truncated,
			...(typeof raw.excludeFromContext === "boolean" ? { excludeFromContext: raw.excludeFromContext } : {}),
			timestamp: raw.timestamp,
		};
	}
	if (role === "custom") {
		if (
			!requiredString(raw.customType) ||
			!isContent(raw.content) ||
			typeof raw.display !== "boolean" ||
			typeof raw.timestamp !== "number"
		)
			return undefined;
		const details = cloneJson(raw.details).value;
		return {
			role: "custom",
			customType: raw.customType,
			content: raw.content,
			display: raw.display,
			...(details === undefined ? {} : { details }),
			timestamp: raw.timestamp,
		};
	}
	return undefined;
}

type MigratedEntry = {
	raw: RawEntry;
	id: string;
	readonly parentId: string | null;
	readonly row: ParsedRow;
	readonly physicalIndex: number;
	readonly valid: boolean;
	readonly duplicate: boolean;
};
function compactionDetails(raw: RawEntry): PrimeJsonValue | undefined {
	if (raw.details !== undefined && raw.customInstructions !== undefined) {
		const details = cloneJson(raw.details).value;
		const customInstructions = cloneJson(raw.customInstructions).value;
		if (details !== undefined && customInstructions !== undefined) return { details, customInstructions };
		return undefined;
	}
	return cloneJson(
		raw.details ??
			(raw.customInstructions === undefined ? undefined : { customInstructions: raw.customInstructions }),
	).value;
}

function normalizeEntry(
	entry: MigratedEntry,
	sourceRef: string,
	serviceFamily: "openai" | "anthropic" | "google" | undefined,
	sourceFile: PrimeSourceFile,
	fullOutputFiles: readonly PrimeSourceFile[],
	losses: PrimeImportLoss[],
): PrimeNormalizedSessionEntry | undefined {
	const { raw, id, parentId, row } = entry;
	const timestamp = requiredString(raw.timestamp) ? raw.timestamp : undefined;
	if (!timestamp) {
		losses.push(loss("sessions-invalid-entry", sourceRef, row));
		return undefined;
	}
	const base = baseEntry(id, parentId, timestamp);
	switch (raw.type) {
		case "message": {
			if (!isRecord(raw.message)) {
				losses.push(loss("sessions-invalid-entry", sourceRef, row));
				return undefined;
			}
			const messageRaw =
				raw.message.role === "hookMessage" ? { ...raw.message, role: "custom" as const } : raw.message;
			const invalidImage = hasInvalidInlineImage(messageRaw);
			const message = normalizeMessage(messageRaw);
			if (!message) {
				losses.push(loss(invalidImage ? "sessions-invalid-entry" : "sessions-unsupported-entry", sourceRef, row));
				return undefined;
			}
			if (message.role === "bashExecution" && message.truncated && typeof raw.message.fullOutputPath === "string") {
				const resolvedOutput = findFullOutputFile(sourceFile, raw.message.fullOutputPath, fullOutputFiles);
				const outputPath = resolvedOutput.path;
				const outputFile = resolvedOutput.file;
				if (!outputFile) losses.push(loss("sessions-missing-full-output", sourceRef, row, outputPath));
				if (outputFile) {
					const hydratedMessage = {
						...message,
						output: Buffer.from(outputFile.contentBase64, "base64").toString("utf8"),
						fullOutputSourceRef: outputFile.sourceRef,
						fullOutputSha256: outputFile.sha256,
					};
					return { ...base, type: "message", message: hydratedMessage };
				}
			} else if (message.role === "bashExecution" && message.truncated) {
				losses.push(loss("sessions-missing-full-output", sourceRef, row));
			}
			return { ...base, type: "message", message };
		}
		case "model_change":
			if (!requiredString(raw.provider) || !requiredString(raw.modelId)) break;
			return {
				...base,
				type: "model_change",
				model: `${raw.provider}/${raw.modelId}`,
				...(requiredString(raw.role) ? { role: raw.role } : {}),
			};
		case "thinking_level_change":
			if (raw.thinkingLevel !== null && !requiredString(raw.thinkingLevel)) break;
			return { ...base, type: "thinking_level_change", thinkingLevel: raw.thinkingLevel ?? null };
		case "service_tier_change": {
			if (
				(raw.serviceTier !== null &&
					raw.serviceTier !== "auto" &&
					raw.serviceTier !== "default" &&
					raw.serviceTier !== "flex" &&
					raw.serviceTier !== "scale" &&
					raw.serviceTier !== "priority") ||
				raw.serviceTier === undefined
			)
				break;
			if (raw.serviceTier === null) return { ...base, type: "service_tier_change", serviceTier: null };
			if (!serviceFamily) {
				losses.push(loss("sessions-unsupported-entry", sourceRef, row));
				return undefined;
			}
			return { ...base, type: "service_tier_change", serviceTier: { [serviceFamily]: raw.serviceTier } };
		}
		case "compaction": {
			if (
				!requiredString(raw.summary) ||
				!requiredString(raw.firstKeptEntryId) ||
				typeof raw.tokensBefore !== "number"
			)
				break;
			const details = compactionDetails(raw);
			return {
				...base,
				type: "compaction",
				summary: raw.summary,
				firstKeptEntryId: raw.firstKeptEntryId,
				tokensBefore: raw.tokensBefore,
				...(details === undefined ? {} : { details }),
				...(typeof raw.fromHook === "boolean" ? { fromExtension: raw.fromHook } : {}),
			};
		}
		case "branch_summary": {
			if (!requiredString(raw.fromId) || !requiredString(raw.summary)) break;
			const details = cloneJson(raw.details).value;
			return {
				...base,
				type: "branch_summary",
				fromId: raw.fromId,
				summary: raw.summary,
				...(details === undefined ? {} : { details }),
				...(typeof raw.fromHook === "boolean" ? { fromExtension: raw.fromHook } : {}),
			};
		}
		case "label":
			if (!requiredString(raw.targetId) || (raw.label !== undefined && typeof raw.label !== "string")) break;
			return {
				...base,
				type: "label",
				targetId: raw.targetId,
				...(typeof raw.label === "string" ? { label: raw.label } : {}),
			};
		case "child_usage_attributed":
		case "session_state":
		case "agent_status":
		case "git_state":
			losses.push(loss("sessions-excluded-state", sourceRef, row));
			return undefined;
		case "custom_message": {
			if (hasInvalidInlineImage(raw)) {
				losses.push(loss("sessions-invalid-entry", sourceRef, row));
				return undefined;
			}
			if (!requiredString(raw.customType) || !isContent(raw.content) || typeof raw.display !== "boolean") break;
			const details = cloneJson(raw.details).value;
			return {
				...base,
				type: "custom_message",
				customType: raw.customType,
				content: raw.content,
				display: raw.display,
				...(details === undefined ? {} : { details }),
			};
		}
		case "custom":
			losses.push(loss("sessions-opaque-record", sourceRef, row));
			return undefined;
	}
	losses.push(loss("sessions-unsupported-entry", sourceRef, row));
	return undefined;
}

function checkToolPairing(
	entries: readonly PrimeNormalizedSessionEntry[],
	sourceRef: string,
	rowById: ReadonlyMap<string, ParsedRow>,
	losses: PrimeImportLoss[],
	ancestorBudget: { steps: number; readonly max: number; exhausted: boolean },
): PrimeNormalizedSessionEntry[] {
	const callOwners = new Map<string, Map<string, number>>();
	const ownerCalls = new Map<string, Map<string, number>>();
	const results = new Map<string, string>();
	const children = new Map<string, string[]>();
	const entryById = new Map(entries.map(entry => [entry.id, entry] as const));
	for (const entry of entries) {
		if (entry.parentId !== null) {
			const descendants = children.get(entry.parentId) ?? [];
			descendants.push(entry.id);
			children.set(entry.parentId, descendants);
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (isRecord(block) && block.type === "toolCall" && requiredString(block.id)) {
					const owners = callOwners.get(block.id) ?? new Map<string, number>();
					owners.set(entry.id, (owners.get(entry.id) ?? 0) + 1);
					callOwners.set(block.id, owners);
					const calls = ownerCalls.get(entry.id) ?? new Map<string, number>();
					calls.set(block.id, (calls.get(block.id) ?? 0) + 1);
					ownerCalls.set(entry.id, calls);
				}
			}
		}
		if (entry.message.role === "toolResult") results.set(entry.id, entry.message.toolCallId);
	}
	const resultOwners = new Map<string, string[]>();
	for (const [entryId, toolCallId] of results) {
		const owners: string[] = [];
		let cursor: string | null = entryId;
		while (cursor !== null) {
			if (ancestorBudget.steps >= ancestorBudget.max) {
				ancestorBudget.exhausted = true;
				break;
			}
			ancestorBudget.steps += 1;
			if ((ownerCalls.get(cursor)?.get(toolCallId) ?? 0) > 0) owners.push(cursor);
			cursor = entryById.get(cursor)?.parentId ?? null;
		}
		resultOwners.set(entryId, owners);
	}
	const unmatchedResults = new Set<string>();
	const matchedPairResults = new Map<string, string>();
	const matchedPairs = new Set<string>();
	for (const [entryId, toolCallId] of results) {
		const owners = resultOwners.get(entryId) ?? [];
		const pair = owners.length === 1 ? `${owners[0]}\u0000${toolCallId}` : undefined;
		const occurrenceCount = pair === undefined ? 0 : (callOwners.get(toolCallId)?.get(owners[0]) ?? 0);
		if (pair === undefined || occurrenceCount !== 1 || matchedPairs.has(pair)) {
			losses.push(loss("sessions-unmatched-tool-result", sourceRef, rowById.get(entryId)));
			unmatchedResults.add(entryId);
			continue;
		}
		matchedPairs.add(pair);
		matchedPairResults.set(pair, entryId);
	}
	const removedEntries = new Set(unmatchedResults);
	const pending = [...unmatchedResults];
	for (let index = 0; index < pending.length; index += 1) {
		for (const childId of children.get(pending[index]!) ?? []) {
			if (removedEntries.has(childId)) continue;
			removedEntries.add(childId);
			pending.push(childId);
		}
	}
	for (const [entryId, toolCallId] of results) {
		if (!removedEntries.has(entryId)) continue;
		unmatchedResults.add(entryId);
		const owners = resultOwners.get(entryId) ?? [];
		if (owners.length === 1) {
			const pair = `${owners[0]}\u0000${toolCallId}`;
			if (matchedPairResults.get(pair) === entryId && matchedPairs.delete(pair)) {
				matchedPairResults.delete(pair);
				losses.push(loss("sessions-broken-parent", sourceRef, rowById.get(entryId)));
			}
		}
	}
	for (const [callId, owners] of callOwners) {
		for (const [ownerId, occurrenceCount] of owners) {
			if (occurrenceCount !== 1 || !matchedPairs.has(`${ownerId}\u0000${callId}`))
				losses.push(loss("sessions-unmatched-tool-call", sourceRef, rowById.get(ownerId)));
		}
	}
	const kept: PrimeNormalizedSessionEntry[] = [];
	const keptIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult" && unmatchedResults.has(entry.id)) continue;
		if (entry.parentId !== null && !keptIds.has(entry.parentId)) {
			losses.push(loss("sessions-broken-parent", sourceRef, rowById.get(entry.id)));
			continue;
		}
		kept.push(entry);
		keptIds.add(entry.id);
	}
	return kept;
}

function modelFamily(
	entry: MigratedEntry,
	entriesById: ReadonlyMap<string, MigratedEntry>,
	families: Map<string, "openai" | "anthropic" | "google" | undefined>,
	ancestorBudget: { steps: number; readonly max: number; exhausted: boolean },
): "openai" | "anthropic" | "google" | undefined {
	if (families.has(entry.id)) return families.get(entry.id);
	const trail: string[] = [];
	let cursor: MigratedEntry | undefined = entry;
	let family: "openai" | "anthropic" | "google" | undefined;
	while (cursor !== undefined && !families.has(cursor.id)) {
		if (ancestorBudget.steps >= ancestorBudget.max) {
			ancestorBudget.exhausted = true;
			break;
		}
		ancestorBudget.steps += 1;
		trail.push(cursor.id);
		if (
			cursor.raw.type === "model_change" &&
			requiredString(cursor.raw.provider) &&
			requiredString(cursor.raw.modelId)
		) {
			const provider = cursor.raw.provider.toLowerCase();
			const model = cursor.raw.modelId.toLowerCase();
			if (provider.includes("anthropic") || provider.includes("bedrock")) family = "anthropic";
			else if (provider.includes("google") || provider.includes("vertex") || provider.includes("gemini"))
				family = "google";
			else if (provider.includes("openai") || provider.includes("azure")) family = "openai";
			else if (provider === "openrouter") {
				if (model.includes("anthropic") || model.startsWith("claude")) family = "anthropic";
				else if (model.includes("google") || model.startsWith("gemini")) family = "google";
				else if (model.includes("openai") || model.startsWith("gpt")) family = "openai";
			}
			break;
		}
		cursor = cursor.parentId === null ? undefined : entriesById.get(cursor.parentId);
	}
	if (cursor !== undefined && families.has(cursor.id)) family = families.get(cursor.id);
	for (const id of trail) families.set(id, family);
	return family;
}

function parseSessionFile(
	file: PrimeSourceFile,
	losses: PrimeImportLoss[],
	discoveryFiles: readonly PrimeSourceFile[],
	requireChildLineage: boolean,
	maxRows: number,
): PrimeNormalizedSession | undefined {
	const parsedRows = parseJsonl(file, losses, maxRows);
	const rows = parsedRows.rows;
	const headerRow = rows[0];
	const headerValue = headerRow?.value;
	if (!isRecord(headerValue) || headerValue.type !== "session") {
		losses.push(loss("sessions-invalid-entry", file.sourceRef, headerRow));
		return undefined;
	}
	if (!requiredString(headerValue.id) || !requiredString(headerValue.timestamp) || !requiredString(headerValue.cwd)) {
		losses.push(loss("sessions-invalid-entry", file.sourceRef, headerRow));
		return undefined;
	}
	const versionValue = headerValue.version;
	if (requireChildLineage && !requiredString(headerValue.parentSession)) {
		losses.push(loss("sessions-excluded-state", file.sourceRef, headerRow));
		return undefined;
	}
	const version = typeof versionValue === "number" && Number.isSafeInteger(versionValue) ? versionValue : 1;
	const allowedHeaderFields = new Set([
		"type",
		"version",
		"id",
		"timestamp",
		"cwd",
		"title",
		"parentSession",
		"rlmDepth",
	]);
	for (const key of Object.keys(headerValue)) {
		if (!allowedHeaderFields.has(key)) losses.push(loss("sessions-header-extra", file.sourceRef, headerRow));
	}
	const rlmDepth = headerValue.rlmDepth;
	const validRlmDepth =
		typeof rlmDepth === "number" && Number.isSafeInteger(rlmDepth) && rlmDepth >= 0 ? rlmDepth : undefined;
	const header: PrimeNormalizedSessionHeader = {
		type: "session",
		version: 3,
		id: headerValue.id,
		timestamp: headerValue.timestamp,
		cwd: headerValue.cwd,
		...(requiredString(headerValue.title) ? { title: headerValue.title } : {}),
		...(requiredString(headerValue.parentSession) ? { parentSession: headerValue.parentSession } : {}),
		...(validRlmDepth === undefined ? {} : { rlmDepth: validRlmDepth }),
		lineage: {
			...(requiredString(headerValue.parentSession) ? { parentSession: headerValue.parentSession } : {}),
			...(validRlmDepth === undefined ? {} : { rlmDepth: validRlmDepth }),
			child: requiredString(headerValue.parentSession),
		},
	};
	const ownedOutputFiles = discoveryFiles.filter(
		candidate => candidate.domain === "artifacts" && candidate.sourceRef.startsWith(`artifacts/${header.id}/`),
	);
	const migrated: MigratedEntry[] = [];
	const migratedById = new Map<string, MigratedEntry>();
	let previousId: string | null = null;
	for (let index = 1; index < rows.length; index += 1) {
		const row = rows[index];
		const raw = row.value;
		if (!isRecord(raw)) continue;
		const rawId = raw.id;
		const hasId = requiredString(rawId);
		const id = hasId ? rawId : stableLegacyId(file.sourceRef, index);
		const parentValid = version < 2 || raw.parentId === null || requiredString(raw.parentId);
		let parentId: string | null;
		if (version < 2) parentId = previousId;
		else if (raw.parentId === null) parentId = null;
		else parentId = requiredString(raw.parentId) ? raw.parentId : null;
		const duplicate = migratedById.has(id);
		if (!hasId && version >= 2) losses.push(loss("sessions-invalid-entry", file.sourceRef, row));
		if (!parentValid) losses.push(loss("sessions-invalid-entry", file.sourceRef, row));
		if (duplicate) losses.push(loss("sessions-duplicate-id", file.sourceRef, row));
		if (version >= 2 && parentValid && parentId !== null && !migratedById.has(parentId))
			losses.push(loss("sessions-broken-parent", file.sourceRef, row));
		const migratedEntry = { raw, id, parentId, row, physicalIndex: index, valid: hasId || version < 2, duplicate };
		migrated.push(migratedEntry);
		if (!duplicate) migratedById.set(id, migratedEntry);
		previousId = id;
	}
	for (const entry of migrated) {
		if (version < 2 && entry.raw.type === "compaction" && typeof entry.raw.firstKeptEntryIndex === "number") {
			const targetIndex = entry.raw.firstKeptEntryIndex - 1;
			const target = targetIndex >= 0 ? migrated[targetIndex] : undefined;
			if (target) entry.raw = { ...entry.raw, firstKeptEntryId: target.id };
			else losses.push(loss("sessions-invalid-entry", file.sourceRef, entry.row));
		}
	}
	const ambiguousIds = new Set(migrated.filter(entry => entry.duplicate).map(entry => entry.id));
	const rejectedIds = new Set(ambiguousIds);
	for (const entry of migrated) {
		if (entry.parentId !== null && rejectedIds.has(entry.parentId)) {
			rejectedIds.add(entry.id);
			losses.push(loss("sessions-broken-parent", file.sourceRef, entry.row));
		}
	}
	const entries: PrimeNormalizedSessionEntry[] = [];
	const seen = new Set<string>();
	const ancestorBudget = { steps: 0, max: Math.max(1, maxRows), exhausted: parsedRows.rowBudgetExceeded };
	const families = new Map<string, "openai" | "anthropic" | "google" | undefined>();
	for (const entry of migrated) {
		if (!entry.valid || rejectedIds.has(entry.id) || seen.has(entry.id)) continue;
		const normalized = normalizeEntry(
			entry,
			file.sourceRef,
			modelFamily(entry, migratedById, families, ancestorBudget),
			file,
			ownedOutputFiles,
			losses,
		);
		if (!normalized) continue;
		entries.push(normalized);
		seen.add(entry.id);
	}
	if (ancestorBudget.exhausted && !parsedRows.rowBudgetExceeded) {
		losses.push(loss("source-budget-exceeded", file.sourceRef));
	}
	const rowById = new Map(migrated.map(entry => [entry.id, entry.row] as const));
	const pairedEntries = checkToolPairing(entries, file.sourceRef, rowById, losses, ancestorBudget);
	const entryIds = new Set(pairedEntries.map(entry => entry.id));
	const removedEntries = new Set<string>();
	const pendingRemovals: string[] = [];
	const dependentsByTarget = new Map<string, string[]>();
	for (const entry of pairedEntries) {
		const dependencies = entry.parentId === null ? [] : [entry.parentId];
		if (entry.type === "compaction") dependencies.push(entry.firstKeptEntryId);
		else if (entry.type === "branch_summary" && entry.fromId !== "root") dependencies.push(entry.fromId);
		else if (entry.type === "label") dependencies.push(entry.targetId);
		for (const dependency of dependencies) {
			const dependents = dependentsByTarget.get(dependency) ?? [];
			dependents.push(entry.id);
			dependentsByTarget.set(dependency, dependents);
			if (entryIds.has(dependency) || removedEntries.has(entry.id)) continue;
			removedEntries.add(entry.id);
			pendingRemovals.push(entry.id);
			losses.push(loss("sessions-invalid-entry", file.sourceRef, rowById.get(entry.id)));
		}
	}
	for (let index = 0; index < pendingRemovals.length; index += 1) {
		for (const dependentId of dependentsByTarget.get(pendingRemovals[index]!) ?? []) {
			if (removedEntries.has(dependentId)) continue;
			removedEntries.add(dependentId);
			pendingRemovals.push(dependentId);
			losses.push(loss("sessions-invalid-entry", file.sourceRef, rowById.get(dependentId)));
		}
	}
	const filteredEntries = pairedEntries.filter(entry => !removedEntries.has(entry.id));
	const fatalLossCodes =
		parsedRows.rowBudgetExceeded || ancestorBudget.exhausted
			? (["source-budget-exceeded"] as const)
			: parsedRows.nonHeaderRows > 0 && filteredEntries.length === 0
				? (["sessions-invalid-entry"] as const)
				: undefined;
	return {
		kind: "session",
		sourceRef: file.sourceRef,
		sourceSha256: file.sha256,
		header,
		entries: filteredEntries,
		...(fatalLossCodes === undefined ? {} : { fatalLossCodes }),
	};
}
function sortLosses(losses: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	return [...losses].sort((left, right) => {
		const source = compareStrings(left.sourceRef, right.sourceRef);
		if (source !== 0) return source;
		const line = (left.line ?? 0) - (right.line ?? 0);
		if (line !== 0) return line;
		return compareStrings(left.code, right.code);
	});
}

export function parsePrimeSessions(discovery: PrimeImportSourceDiscovery): PrimeSessionParserResult {
	const losses: PrimeImportLoss[] = [...discovery.losses];
	for (const excluded of discovery.inventory.excluded) {
		losses.push({
			code: "sessions-excluded-state",
			domain: "excluded-state",
			sourceRef: excluded.sourceRef,
			path: excluded.canonicalPath,
		});
	}
	const sessions: PrimeNormalizedSession[] = [];
	for (const file of discovery.inventory.files) {
		if (!file.sourceRef.endsWith(".jsonl") || (file.domain !== "sessions" && file.domain !== "artifacts")) continue;
		const session = parseSessionFile(
			file,
			losses,
			discovery.inventory.files,
			file.domain === "artifacts",
			discovery.snapshot.maxEntries,
		);
		if (session) sessions.push(session);
	}
	return { sessions, losses: sortLosses(losses) };
}
