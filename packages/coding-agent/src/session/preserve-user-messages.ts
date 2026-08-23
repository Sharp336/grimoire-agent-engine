/** Transient preservation of selected user-authored turns across compaction. */

import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionSettings as EngineCompactionSettings,
	remotePreserveReusable,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { ImageContent, Message, Model, TextContent, UserMessage } from "@oh-my-pi/pi-ai";
import type { CompactionSettings as ConfiguredCompactionSettings } from "../config/settings-schema";
import truncatedUserMessageMarker from "../prompts/system/preserved-user-message-truncated.md" with { type: "text" };
import { wrapSteeringForModel } from "./messages";
import type { PreserveUserMessagesFilter, PruneLongUserMessageMode } from "./preserve-user-messages-settings";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./session-entries";

export * from "./preserve-user-messages-settings";

const TRUNCATED_USER_MESSAGE_MARKER = truncatedUserMessageMarker.trim();

/** Persisted pin marker written by `/pin-message` and `/unpin-message`. */
export const PIN_MARKER_CUSTOM_TYPE = "com.omp.compaction-preserved";

/** Versioned preserve-data slot containing durable LLM classification verdicts. */
export const PRESERVED_USER_MESSAGES_PRESERVE_KEY = "com.omp.compaction.preserved-user-messages.v1";

export interface PinMarkerData {
	messageId: string;
	pinned?: boolean;
}

export interface PreservedUserMessagesStoreV1 {
	version: 1;
	preservedIds: string[];
	classifiedIds: string[];
}

export interface UserMessageCandidate {
	id: string;
	text: string;
	/** Non-text provider content is retained without asking the classifier. */
	mechanicallyPreserved?: boolean;
}

export interface PreservedUserMessagePolicy {
	filter: PreserveUserMessagesFilter;
	keepFirstNMessages: number;
	keepLastNMessages: number;
	pruneLongUserMessages: PruneLongUserMessageMode;
	maxTokensPerUserMessage: number;
	tokenizer: Tokenizer;
}

export interface PreservedUserMessageSelection {
	/** Fresh transient copies, ordered as authored in the folded region. */
	messages: UserMessage[];
	/** Unpruned source copies parallel to {@link messages}, used for native-history deduplication. */
	sourceMessages: UserMessage[];
	selectedIds: ReadonlySet<string>;
	tokenCount: number;
	sourceTokenCount: number;
	/** Sum of the larger transformed/source cost for each selected message. */
	remoteTokenCount: number;
}

/** SDK-owned state needed to compare overlays with active provider-native history. */
export interface PreservedUserMessageProviderContext {
	activeModel: Model | undefined;
	compactionSettings: EngineCompactionSettings;
	normalizeSourceUserMessage(message: UserMessage): Message | undefined;
}

export interface PreservedUserMessageBoundary {
	id?: string;
	firstKeptEntryId: string;
	preserveData?: Record<string, unknown>;
}

type PreservationSettings = Pick<
	ConfiguredCompactionSettings,
	| "keepUserMessages"
	| "keepUserMessagesFilter"
	| "keepFirstNMessages"
	| "keepLastNMessages"
	| "pruneLongUserMessages"
	| "maxTokensPerUserMessage"
>;

/** Resolve the six settings into one complete policy, or disable the overlay. */
export function resolvePreservedUserMessagePolicy(
	settings: PreservationSettings,
	tokenizer: Tokenizer,
): PreservedUserMessagePolicy | undefined {
	if (!settings.keepUserMessages) return undefined;
	return {
		filter: settings.keepUserMessagesFilter,
		keepFirstNMessages: settings.keepFirstNMessages,
		keepLastNMessages: settings.keepLastNMessages,
		pruneLongUserMessages: settings.pruneLongUserMessages,
		maxTokensPerUserMessage: settings.maxTokensPerUserMessage,
		tokenizer,
	};
}

/** Index of the latest durable `/clear` marker, or `-1`. */
export function findLatestResetBoundaryIdx(path: readonly SessionEntry[]): number {
	return path.findLastIndex(entry => entry.type === "reset_boundary");
}

/** A persisted user turn authored by the user, not a synthetic/agent injection. */
export function isRealUserMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: UserMessage } {
	return (
		entry.type === "message" &&
		entry.message.role === "user" &&
		entry.message.synthetic !== true &&
		entry.message.attribution !== "agent"
	);
}

const PURE_ACKNOWLEDGMENT =
	/^(?:ok(ay)?|k|kk|yep|yeah|yup|yea|sounds? (?:good|great|fine)|looks? (?:good|great|fine)|lgtm|lgbtm|tbgm|thx|thanks|thank (?:you|u)|ty|tysm|perfect|great|nice|cool|awesome|excellent|amazing|brilliant|good|fine|alright|all (?:good|set)|sure(?: thing)?|of course|absolutely|definitely|indeed|exactly|right|correct|got it|gotcha|understood|noted|roger|copy (?:that|cat)?|affirmative|ack(?:s)?|on it|will do|no problem|np|no worries)\s*[!.]?\s*$/i;

export function userMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}

export function heuristicPreservesUserMessage(message: UserMessage): boolean {
	if (typeof message.content !== "string" && message.content.some(block => block.type !== "text")) return true;
	const text = userMessageText(message);
	return text.length > 0 && !PURE_ACKNOWLEDGMENT.test(text);
}

function cloneUserMessage(message: UserMessage): UserMessage {
	const content =
		typeof message.content === "string"
			? message.content
			: (message.content.map(block => ({ ...block })) as Array<TextContent | ImageContent>);
	return { ...message, content, providerPayload: undefined };
}

export function countPreservedUserMessageTokens(message: UserMessage, tokenizer: Tokenizer): number {
	return tokenizer.countMessage(message);
}

function exactUserMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
}

function safePrefixEnd(text: string, length: number): number {
	let end = Math.min(length, text.length);
	if (
		end > 0 &&
		end < text.length &&
		text.charCodeAt(end - 1) >= 0xd800 &&
		text.charCodeAt(end - 1) <= 0xdbff &&
		text.charCodeAt(end) >= 0xdc00 &&
		text.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return end;
}

function safeSuffixStart(text: string, length: number): number {
	let start = Math.max(0, text.length - length);
	if (
		start > 0 &&
		start < text.length &&
		text.charCodeAt(start - 1) >= 0xd800 &&
		text.charCodeAt(start - 1) <= 0xdbff &&
		text.charCodeAt(start) >= 0xdc00 &&
		text.charCodeAt(start) <= 0xdfff
	) {
		start++;
	}
	return start;
}

function truncationGap(
	text: string,
	retainedCharacters: number,
	mode: PruneLongUserMessageMode,
): { start: number; end: number } {
	if (retainedCharacters <= 0) return { start: 0, end: text.length };
	if (mode === "head-only") return { start: safePrefixEnd(text, retainedCharacters), end: text.length };
	if (mode === "tail-only") return { start: 0, end: safeSuffixStart(text, retainedCharacters) };
	const headLength = Math.ceil(retainedCharacters / 2);
	const tailLength = Math.floor(retainedCharacters / 2);
	return {
		start: safePrefixEnd(text, headLength),
		end: safeSuffixStart(text, tailLength),
	};
}

function textAtTruncationBoundary(before: string, after: string, hasHead: boolean, hasTail: boolean): string {
	const head = hasHead && !before.endsWith("\n") ? `${before}\n` : before;
	const tail = hasTail && !after.startsWith("\n") ? `\n${after}` : after;
	return `${head}${TRUNCATED_USER_MESSAGE_MARKER}${tail}`;
}

function withTruncatedUserMessageText(
	message: UserMessage,
	exactText: string,
	retainedCharacters: number,
	mode: PruneLongUserMessageMode,
): UserMessage {
	const gap = truncationGap(exactText, retainedCharacters, mode);
	const hasHead = gap.start > 0;
	const hasTail = gap.end < exactText.length;
	if (typeof message.content === "string") {
		return {
			...message,
			content: textAtTruncationBoundary(
				message.content.slice(0, gap.start),
				message.content.slice(gap.end),
				hasHead,
				hasTail,
			),
		};
	}

	const content: Array<ImageContent | TextContent> = [];
	let textOffset = 0;
	let markerInserted = false;
	for (const block of message.content) {
		if (block.type === "image") {
			content.push({ ...block });
			continue;
		}
		const blockStart = textOffset;
		const blockEnd = blockStart + block.text.length;
		textOffset = blockEnd;
		const beforeEnd = Math.min(blockEnd, gap.start);
		let transformed = beforeEnd > blockStart ? block.text.slice(0, beforeEnd - blockStart) : "";
		const afterStart = Math.max(blockStart, gap.end);
		const after = blockEnd > afterStart ? block.text.slice(afterStart - blockStart) : "";
		if (!markerInserted && gap.start >= blockStart && gap.start <= blockEnd) {
			transformed = textAtTruncationBoundary(transformed, after, hasHead, hasTail);
			markerInserted = true;
		} else {
			transformed += after;
		}
		if (transformed) content.push({ type: "text", text: transformed });
	}
	return { ...message, content };
}

/** Return a transient bounded copy, leaving persisted input untouched. */
export function pruneLongUserMessage(
	message: UserMessage,
	mode: PruneLongUserMessageMode,
	maxTokens: number,
	tokenizer: Tokenizer,
): UserMessage | undefined {
	const source = cloneUserMessage(message);
	if (mode === "no") return source;
	const limit = Math.max(1, Math.floor(maxTokens));
	if (countPreservedUserMessageTokens(source, tokenizer) <= limit) return source;
	if (mode === "exclude") return undefined;
	const text = exactUserMessageText(source);
	if (!text) return undefined;

	const markerOnly = withTruncatedUserMessageText(source, text, 0, mode);
	if (countPreservedUserMessageTokens(markerOnly, tokenizer) > limit) return undefined;
	let lower = 0;
	let upper = text.length;
	let best = markerOnly;
	while (lower <= upper) {
		const middle = Math.floor((lower + upper) / 2);
		const candidate = withTruncatedUserMessageText(source, text, middle, mode);
		if (countPreservedUserMessageTokens(candidate, tokenizer) <= limit) {
			best = candidate;
			lower = middle + 1;
		} else {
			upper = middle - 1;
		}
	}
	return best;
}

/** Entries summarized by a boundary: after the latest reset, before its kept tail. */
export function foldedRegion(
	path: readonly SessionEntry[],
	resetBoundaryIdx: number,
	firstKeptEntryId: string,
): SessionEntry[] {
	const firstKeptIdx = path.findIndex(entry => entry.id === firstKeptEntryId);
	const end = firstKeptIdx >= 0 ? firstKeptIdx : path.length;
	const start = resetBoundaryIdx + 1;
	return end > start ? path.slice(start, end) : [];
}

export function userMessageCandidates(region: readonly SessionEntry[]): UserMessageCandidate[] {
	return region.filter(isRealUserMessageEntry).map(entry => ({
		id: entry.id,
		text: userMessageText(entry.message),
		mechanicallyPreserved:
			typeof entry.message.content !== "string" && entry.message.content.some(block => block.type !== "text"),
	}));
}

export function pinnedUserMessageIds(
	entries: readonly SessionEntry[],
	candidateIds?: ReadonlySet<string>,
): Set<string> {
	const pinned = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PIN_MARKER_CUSTOM_TYPE) continue;
		const data = entry.data as PinMarkerData | undefined;
		if (typeof data?.messageId !== "string" || (candidateIds && !candidateIds.has(data.messageId))) continue;
		if (data.pinned === false) pinned.delete(data.messageId);
		else pinned.add(data.messageId);
	}
	return pinned;
}

export function readPreservedUserMessagesStore(
	preserveData: Record<string, unknown> | undefined,
): PreservedUserMessagesStoreV1 | undefined {
	const value = preserveData?.[PRESERVED_USER_MESSAGES_PRESERVE_KEY];
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const store = value as Partial<PreservedUserMessagesStoreV1>;
		if (
			store.version === 1 &&
			Array.isArray(store.preservedIds) &&
			store.preservedIds.every(id => typeof id === "string") &&
			Array.isArray(store.classifiedIds) &&
			store.classifiedIds.every(id => typeof id === "string")
		) {
			return {
				version: 1,
				preservedIds: [...store.preservedIds],
				classifiedIds: [...store.classifiedIds],
			};
		}
	}
	const legacyPreserved = preserveData?.preservedUserMessageIds;
	const legacyClassified = preserveData?.classifiedUserMessageIds;
	const preservedIds =
		Array.isArray(legacyPreserved) && legacyPreserved.every(id => typeof id === "string")
			? legacyPreserved
			: undefined;
	const classifiedIds =
		Array.isArray(legacyClassified) && legacyClassified.every(id => typeof id === "string")
			? legacyClassified
			: undefined;
	if (!preservedIds && !classifiedIds) return undefined;
	return {
		version: 1,
		preservedIds: [...(preservedIds ?? [])],
		classifiedIds: [...(classifiedIds ?? [])],
	};
}

export function writePreservedUserMessagesStore(
	preserveData: Record<string, unknown> | undefined,
	store: PreservedUserMessagesStoreV1,
): Record<string, unknown> {
	return { ...preserveData, [PRESERVED_USER_MESSAGES_PRESERVE_KEY]: store };
}

function boundarySelectionPath(
	path: readonly SessionEntry[],
	boundary: PreservedUserMessageBoundary,
): { path: readonly SessionEntry[]; resetBoundaryIdx: number } | undefined {
	const boundaryIdx = boundary.id
		? path.findIndex(entry => entry.id === boundary.id && entry.type === "compaction")
		: -1;
	const resetBoundaryIdx = findLatestResetBoundaryIdx(path);
	if (boundaryIdx >= 0) {
		if (boundaryIdx <= resetBoundaryIdx) return undefined;
		const selectionPath = path.slice(0, boundaryIdx);
		if (!selectionPath.some(entry => entry.id === boundary.firstKeptEntryId)) return undefined;
		return { path: selectionPath, resetBoundaryIdx };
	}
	if (!path.some(entry => entry.id === boundary.firstKeptEntryId)) return undefined;
	return { path, resetBoundaryIdx };
}

function eligibleIds(
	selectionPath: readonly SessionEntry[],
	fullPath: readonly SessionEntry[],
	resetBoundaryIdx: number,
	boundary: Pick<CompactionEntry, "preserveData" | "firstKeptEntryId">,
	filter: PreserveUserMessagesFilter,
	prospective: boolean,
): Set<string> {
	const region = foldedRegion(selectionPath, resetBoundaryIdx, boundary.firstKeptEntryId);
	const users = region.filter(isRealUserMessageEntry);
	const userIds = new Set(users.map(entry => entry.id));
	const heuristic = () =>
		new Set(users.filter(entry => heuristicPreservesUserMessage(entry.message)).map(entry => entry.id));
	if (filter === "all") return userIds;
	if (filter === "heuristic") return heuristic();
	if (filter === "pinned") return pinnedUserMessageIds(fullPath.slice(resetBoundaryIdx + 1), userIds);
	const store = readPreservedUserMessagesStore(boundary.preserveData);
	const preserved = new Set((store?.preservedIds ?? []).filter(id => userIds.has(id)));
	const classified = new Set((store?.classifiedIds ?? []).filter(id => userIds.has(id)));
	for (const entry of users) {
		if (classified.has(entry.id)) continue;
		if (prospective || heuristicPreservesUserMessage(entry.message)) preserved.add(entry.id);
	}
	return preserved;
}

/** Select real user messages for one stored or prospective compaction boundary. */
export function selectPreservedUserMessages(
	path: readonly SessionEntry[],
	boundary: PreservedUserMessageBoundary,
	policy: PreservedUserMessagePolicy,
	options?: { prospective?: boolean },
): PreservedUserMessageSelection {
	const scoped = boundarySelectionPath(path, boundary);
	if (!scoped) {
		return {
			messages: [],
			sourceMessages: [],
			selectedIds: new Set(),
			tokenCount: 0,
			sourceTokenCount: 0,
			remoteTokenCount: 0,
		};
	}
	const region = foldedRegion(scoped.path, scoped.resetBoundaryIdx, boundary.firstKeptEntryId);
	const ids = eligibleIds(
		scoped.path,
		path,
		scoped.resetBoundaryIdx,
		boundary,
		policy.filter,
		options?.prospective === true,
	);
	const eligible: Array<{ id: string; message: UserMessage; sourceMessage: UserMessage }> = [];
	for (const entry of region) {
		if (!isRealUserMessageEntry(entry) || !ids.has(entry.id)) continue;
		const message = pruneLongUserMessage(
			entry.message,
			policy.pruneLongUserMessages,
			policy.maxTokensPerUserMessage,
			policy.tokenizer,
		);
		if (message) eligible.push({ id: entry.id, message, sourceMessage: cloneUserMessage(entry.message) });
	}

	const keepFirst = Math.max(0, Math.floor(policy.keepFirstNMessages));
	const keepLast = Math.max(0, Math.floor(policy.keepLastNMessages));
	const messages: UserMessage[] = [];
	const sourceMessages: UserMessage[] = [];
	const selectedIds = new Set<string>();
	let tokenCount = 0;
	let sourceTokenCount = 0;
	let remoteTokenCount = 0;
	for (let index = 0; index < eligible.length; index++) {
		const position = index + 1;
		if ((keepFirst !== 0 || keepLast !== 0) && position > keepFirst && position <= eligible.length - keepLast) {
			continue;
		}
		const selected = eligible[index];
		messages.push(selected.message);
		sourceMessages.push(selected.sourceMessage);
		selectedIds.add(selected.id);
		const transformedTokens = policy.tokenizer.countMessages(wrapSteeringForModel([selected.message]));
		const sourceTokens = policy.tokenizer.countMessage(selected.sourceMessage);
		tokenCount += transformedTokens;
		sourceTokenCount += sourceTokens;
		remoteTokenCount += Math.max(transformedTokens, sourceTokens);
	}
	return {
		messages,
		sourceMessages,
		selectedIds,
		tokenCount,
		sourceTokenCount,
		remoteTokenCount,
	};
}

/** Conservative request cost for a selected overlay at one compaction boundary. */
export function resolvePreservedUserMessageContextTokens(
	selection: PreservedUserMessageSelection,
	boundary: PreservedUserMessageBoundary,
	activeModel: Model | undefined,
	settings: EngineCompactionSettings,
): number {
	if (activeModel && remotePreserveReusable(boundary.preserveData, activeModel, settings)) {
		return selection.remoteTokenCount;
	}
	return selection.tokenCount;
}

function matchesCompactionSummary(entry: CompactionEntry, message: CompactionSummaryMessage): boolean {
	return (
		new Date(entry.timestamp).getTime() === message.timestamp &&
		entry.tokensBefore === message.tokensBefore &&
		entry.tokensAfter === message.tokensAfter &&
		entry.method === message.method
	);
}

function userContentFingerprint(content: unknown): string | undefined {
	if (typeof content === "string") return JSON.stringify([{ type: "text", text: content }]);
	if (!Array.isArray(content)) return undefined;
	const normalized: Array<Record<string, string>> = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
		const block = part as Record<string, unknown>;
		if ((block.type === "text" || block.type === "input_text") && typeof block.text === "string") {
			normalized.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			normalized.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		if (block.type === "input_image" && typeof block.image_url === "string") {
			const match = /^data:([^;,]+);base64,(.*)$/.exec(block.image_url);
			if (!match) return undefined;
			normalized.push({ type: "image", data: match[2], mimeType: match[1] });
			continue;
		}
		return undefined;
	}
	return JSON.stringify(normalized);
}

function overlayMessagesMissingFromNativeHistory(
	message: CompactionSummaryMessage,
	compaction: CompactionEntry,
	selection: PreservedUserMessageSelection,
	providerContext: PreservedUserMessageProviderContext,
): UserMessage[] {
	const { activeModel, compactionSettings, normalizeSourceUserMessage } = providerContext;
	const payload = message.providerPayload;
	if (
		!activeModel ||
		payload?.type !== "openaiResponsesHistory" ||
		!remotePreserveReusable(compaction.preserveData, activeModel, compactionSettings)
	) {
		return selection.messages;
	}
	const nativeCounts = new Map<string, number>();
	for (const item of payload.items) {
		if (item.type !== "message" || item.role !== "user") continue;
		const fingerprint = userContentFingerprint(item.content);
		if (fingerprint) nativeCounts.set(fingerprint, (nativeCounts.get(fingerprint) ?? 0) + 1);
	}
	return selection.messages.filter((_user, index) => {
		const normalized = normalizeSourceUserMessage(selection.sourceMessages[index]);
		if (normalized?.role !== "user") return true;
		const fingerprint = userContentFingerprint(normalized.content);
		if (!fingerprint) return true;
		const count = nativeCounts.get(fingerprint) ?? 0;
		if (count === 0) return true;
		nativeCounts.set(fingerprint, count - 1);
		return false;
	});
}

/**
 * Add the overlay to one loop-local provider context. The summary must exactly
 * match a compaction on the active branch; stale side-request snapshots are left
 * unchanged. A selected turn already present in reusable provider-native
 * history is suppressed from the overlay by a content-fingerprint multiset.
 */
export function applyPreservedUserMessageOverlay(
	messages: AgentMessage[],
	branch: readonly SessionEntry[],
	policy: PreservedUserMessagePolicy,
	providerContext: PreservedUserMessageProviderContext,
): AgentMessage[] {
	const resetBoundaryIdx = findLatestResetBoundaryIdx(branch);
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role !== "compactionSummary") continue;
		let compaction: CompactionEntry | undefined;
		for (let entryIndex = branch.length - 1; entryIndex > resetBoundaryIdx; entryIndex--) {
			const entry = branch[entryIndex];
			if (entry.type === "compaction" && matchesCompactionSummary(entry, message)) {
				compaction = entry;
				break;
			}
		}
		if (!compaction) continue;
		const selection = selectPreservedUserMessages(branch, compaction, policy);
		if (selection.messages.length === 0) return messages;
		const overlay = overlayMessagesMissingFromNativeHistory(message, compaction, selection, providerContext);
		if (overlay.length === 0) return messages;
		return [...messages.slice(0, messageIndex + 1), ...overlay, ...messages.slice(messageIndex + 1)];
	}
	return messages;
}
