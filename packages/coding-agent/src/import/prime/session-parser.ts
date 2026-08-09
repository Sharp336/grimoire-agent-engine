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
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

function cloneJson(value: unknown): PrimeJsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const out: PrimeJsonValue[] = [];
		for (const item of value) {
			const cloned = cloneJson(item);
			if (cloned === undefined && item !== null) return undefined;
			out.push(cloned ?? null);
		}
		return out;
	}
	if (typeof value !== "object") return undefined;
	const out: Record<string, PrimeJsonValue> = {};
	for (const [key, item] of Object.entries(value)) {
		const cloned = cloneJson(item);
		if (cloned === undefined && item !== null) return undefined;
		out[key] = cloned ?? null;
	}
	return out;
}

function parseLine(value: Buffer): PrimeJsonValue | undefined {
	try {
		const parsed: unknown = JSON.parse(value.toString("utf8").replace(/\r$/, ""));
		return cloneJson(parsed);
	} catch {
		return undefined;
	}
}

function likelyTruncatedTail(value: Buffer): boolean {
	const text = value.toString("utf8").trim();
	if (!text || text.includes("\u2028") || text.includes("\u2029")) return false;
	return text.startsWith("{") && !/[}\]]$/.test(text);
}

function parseJsonl(file: PrimeSourceFile, losses: PrimeImportLoss[]): ParsedRow[] {
	const bytes = Buffer.from(file.contentBase64, "base64");
	const values: ParsedRow[] = [];
	let start = 0;
	let line = 1;
	while (start < bytes.length) {
		const found = bytes.indexOf(0x0a, start);
		const end = found < 0 ? bytes.length : found;
		const slice = bytes.subarray(start, end);
		const row = { line, byteOffset: start, byteLength: slice.length };
		if (slice.toString("utf8").trim()) {
			const parsed = parseLine(slice);
			if (parsed === undefined || !isRecord(parsed)) {
				losses.push(
					loss(
						found < 0 && likelyTruncatedTail(slice) ? "sessions-truncated-tail" : "sessions-malformed",
						file.sourceRef,
						row,
					),
				);
			} else values.push({ value: parsed, ...row });
		}
		if (found < 0) break;
		start = end + 1;
		line += 1;
	}
	return values;
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

function isContentBlock(value: PrimeJsonValue | undefined): value is PrimeSessionContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
	return false;
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
		return {
			role: "toolResult",
			toolCallId: raw.toolCallId,
			toolName: raw.toolName,
			content: raw.content,
			isError: raw.isError,
			...(cloneJson(raw.details) === undefined ? {} : { details: cloneJson(raw.details) }),
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
		const details = cloneJson(raw.details);
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
		const details = cloneJson(raw.details);
		const customInstructions = cloneJson(raw.customInstructions);
		if (details !== undefined && customInstructions !== undefined) return { details, customInstructions };
		return undefined;
	}
	return cloneJson(
		raw.details ??
			(raw.customInstructions === undefined ? undefined : { customInstructions: raw.customInstructions }),
	);
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
			const message = normalizeMessage(messageRaw);
			if (!message) {
				losses.push(loss("sessions-unsupported-entry", sourceRef, row));
				return undefined;
			}
			if (message.role === "bashExecution" && message.truncated && typeof raw.message.fullOutputPath === "string") {
				const outputPath = path.posix.resolve(
					path.posix.dirname(sourceFile.canonicalPath),
					raw.message.fullOutputPath,
				);
				const outputFile = fullOutputFiles.find(candidate => candidate.canonicalPath === outputPath);
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
			const details = cloneJson(raw.details);
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
			if (!requiredString(raw.customType) || !isContent(raw.content) || typeof raw.display !== "boolean") break;
			const details = cloneJson(raw.details);
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
): PrimeNormalizedSessionEntry[] {
	const entryById = new Map(entries.map(entry => [entry.id, entry] as const));
	const callOwners = new Map<string, Map<string, number>>();
	const results = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (isRecord(block) && block.type === "toolCall" && requiredString(block.id)) {
					const owners = callOwners.get(block.id) ?? new Map<string, number>();
					owners.set(entry.id, (owners.get(entry.id) ?? 0) + 1);
					callOwners.set(block.id, owners);
				}
			}
		}
		if (entry.message.role === "toolResult") results.set(entry.id, entry.message.toolCallId);
	}
	const hasAncestor = (entryId: string, targetId: string): boolean => {
		let cursor: string | null = entryId;
		while (cursor !== null) {
			if (cursor === targetId) return true;
			cursor = entryById.get(cursor)?.parentId ?? null;
		}
		return false;
	};
	const unmatchedResults = new Set<string>();
	const matchedPairResults = new Map<string, string>();
	const matchedPairs = new Set<string>();
	for (const [entryId, toolCallId] of results) {
		const owners = [...(callOwners.get(toolCallId)?.keys() ?? [])].filter(ownerId => hasAncestor(entryId, ownerId));
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
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const entry of entries) {
			if (entry.parentId !== null && removedEntries.has(entry.parentId) && !removedEntries.has(entry.id)) {
				removedEntries.add(entry.id);
				expanded = true;
			}
		}
	}
	for (const [entryId, toolCallId] of results) {
		if (!removedEntries.has(entryId)) continue;
		unmatchedResults.add(entryId);
		const owners = [...(callOwners.get(toolCallId)?.keys() ?? [])].filter(ownerId => hasAncestor(entryId, ownerId));
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
	allEntries: readonly MigratedEntry[],
): "openai" | "anthropic" | "google" | undefined {
	let cursor: MigratedEntry | undefined = entry;
	while (cursor) {
		if (
			cursor.raw.type === "model_change" &&
			requiredString(cursor.raw.provider) &&
			requiredString(cursor.raw.modelId)
		) {
			const provider = cursor.raw.provider.toLowerCase();
			const model = cursor.raw.modelId.toLowerCase();
			if (provider.includes("anthropic") || provider.includes("bedrock")) return "anthropic";
			if (provider.includes("google") || provider.includes("vertex") || provider.includes("gemini")) return "google";
			if (provider.includes("openai") || provider.includes("azure")) return "openai";
			if (provider === "openrouter") {
				if (model.includes("anthropic") || model.startsWith("claude")) return "anthropic";
				if (model.includes("google") || model.startsWith("gemini")) return "google";
				if (model.includes("openai") || model.startsWith("gpt")) return "openai";
			}
			return undefined;
		}
		const parentId: string | null = cursor.parentId;
		cursor = parentId === null ? undefined : allEntries.find(candidate => candidate.id === parentId);
	}
	return undefined;
}

function parseSessionFile(
	file: PrimeSourceFile,
	losses: PrimeImportLoss[],
	discoveryFiles: readonly PrimeSourceFile[],
	requireChildLineage: boolean,
): PrimeNormalizedSession | undefined {
	const rows = parseJsonl(file, losses);
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
	const allowedHeaderFields = new Set(["type", "version", "id", "timestamp", "cwd", "parentSession", "rlmDepth"]);
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
	let previousId: string | null = null;
	for (let index = 1; index < rows.length; index += 1) {
		const row = rows[index];
		const raw = row.value;
		if (!isRecord(raw)) continue;
		const hasId = requiredString(raw.id);
		const id = requiredString(raw.id) ? raw.id : stableLegacyId(file.sourceRef, index);
		const parentValid = version < 2 || raw.parentId === null || requiredString(raw.parentId);
		let parentId: string | null;
		if (version < 2) parentId = previousId;
		else if (raw.parentId === null) parentId = null;
		else parentId = requiredString(raw.parentId) ? raw.parentId : null;
		const duplicate = migrated.some(entry => entry.id === id);
		if (!hasId && version >= 2) losses.push(loss("sessions-invalid-entry", file.sourceRef, row));
		if (!parentValid) losses.push(loss("sessions-invalid-entry", file.sourceRef, row));
		if (duplicate) losses.push(loss("sessions-duplicate-id", file.sourceRef, row));
		if (version >= 2 && parentValid && parentId !== null && !migrated.some(entry => entry.id === parentId))
			losses.push(loss("sessions-broken-parent", file.sourceRef, row));
		migrated.push({ raw, id, parentId, row, physicalIndex: index, valid: hasId || version < 2, duplicate });
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
	for (const entry of migrated) {
		if (!entry.valid || rejectedIds.has(entry.id) || seen.has(entry.id)) continue;
		const normalized = normalizeEntry(
			entry,
			file.sourceRef,
			modelFamily(entry, migrated),
			file,
			ownedOutputFiles,
			losses,
		);
		if (!normalized) continue;
		entries.push(normalized);
		seen.add(entry.id);
	}
	const rowById = new Map(migrated.map(entry => [entry.id, entry.row] as const));
	const pairedEntries = checkToolPairing(entries, file.sourceRef, rowById, losses);
	let filteredEntries = pairedEntries;
	let changed = true;
	while (changed) {
		const entryIds = new Set(filteredEntries.map(entry => entry.id));
		const nextEntries = filteredEntries.filter(entry => {
			if (entry.type !== "label" || entryIds.has(entry.targetId)) return true;
			losses.push(loss("sessions-invalid-entry", file.sourceRef, rowById.get(entry.id)));
			return false;
		});
		changed = nextEntries.length !== filteredEntries.length;
		filteredEntries = nextEntries;
	}
	return { kind: "session", sourceRef: file.sourceRef, sourceSha256: file.sha256, header, entries: filteredEntries };
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
		const session = parseSessionFile(file, losses, discovery.inventory.files, file.domain === "artifacts");
		if (session) sessions.push(session);
	}
	return { sessions, losses: sortLosses(losses) };
}
