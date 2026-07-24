import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { collectToolCallsById } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { ContextDropRecord, MessageTagRecord } from "./types";

export interface SmartCleanupCandidate {
	readonly targetTag: number;
	readonly entryId: string;
	readonly replacementText: string;
}

interface ToolResultCandidate {
	readonly entryId: string;
	readonly tagOrdinal: number;
	readonly toolName: string;
	readonly isError: boolean;
	readonly useless: boolean;
	readonly args: Readonly<Record<string, unknown>>;
}

function toolArguments(value: unknown): Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function editPlaceholder(candidate: ToolResultCandidate): string {
	const input = typeof candidate.args.input === "string" ? candidate.args.input : undefined;
	const headerPath = input?.match(/^\[([^#\]\n]+)#[0-9A-F]{4}\]/m)?.[1];
	const path = typeof candidate.args.path === "string" ? candidate.args.path : (headerPath ?? "unknown path");
	const explicitRegion =
		typeof candidate.args.startLine === "number"
			? `${candidate.args.startLine}-${typeof candidate.args.endLine === "number" ? candidate.args.endLine : candidate.args.startLine}`
			: undefined;
	const operation = input?.match(/^(SWAP(?:\.BLK)?|DEL(?:\.BLK)?|INS\.[A-Z.]+)\s+([^:\n]+)/m);
	const region = explicitRegion ?? operation?.[2]?.trim() ?? "unspecified region";
	return `[Edit evidence elided: ${path}; ${region}; ${candidate.isError ? "failed" : "applied"}]`;
}

export function planSmartCleanup(
	entries: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	existingDrops: readonly ContextDropRecord[],
	protectedEntryIds: ReadonlySet<string>,
): SmartCleanupCandidate[] {
	const tagByEntry = new Map(
		tags
			.filter(tag => tag.entryId !== undefined && tag.supersededAt === undefined)
			.map(tag => [tag.entryId!, tag.tagOrdinal]),
	);
	const blockedTags = new Set(existingDrops.flatMap(drop => drop.expandedTags));
	const calls = collectToolCallsById(entries);
	const results: ToolResultCandidate[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || protectedEntryIds.has(entry.id)) continue;
		const tagOrdinal = tagByEntry.get(entry.id);
		const call = calls.get(entry.message.toolCallId);
		if (tagOrdinal === undefined || !call || blockedTags.has(tagOrdinal)) continue;
		results.push({
			entryId: entry.id,
			tagOrdinal,
			toolName: call.name,
			isError: entry.message.isError === true,
			useless: entry.message.useless === true,
			args: toolArguments(call.arguments),
		});
	}

	const latestTodoTag = results.reduce(
		(latest, result) => (result.toolName === "todo" ? Math.max(latest, result.tagOrdinal) : latest),
		0,
	);
	const reduceTags = results.filter(result => result.toolName === "ctx_reduce").map(result => result.tagOrdinal);
	const retainedReduceTags = new Set(reduceTags.slice(-5));
	const candidates: SmartCleanupCandidate[] = [];
	for (const result of results) {
		let replacementText: string | undefined;
		if (result.toolName === "todo" && result.tagOrdinal !== latestTodoTag) {
			replacementText = "[Older todo snapshot elided]";
		} else if (result.toolName === "ctx_reduce" && !retainedReduceTags.has(result.tagOrdinal)) {
			replacementText = "[Older ctx_reduce result elided]";
		} else if (result.toolName === "ctx_note") {
			const action = result.args.action;
			if (action === "read" || action === "dismiss") replacementText = `[ctx_note ${action} result elided]`;
		} else if (result.useless) {
			const operation = result.args.op;
			if (
				result.toolName === "status" ||
				result.toolName === "kill" ||
				(result.toolName === "hub" && (operation === "jobs" || operation === "ps" || operation === "cancel"))
			) {
				replacementText = "[Uneventful status result elided]";
			}
		} else if (result.toolName === "edit") {
			replacementText = editPlaceholder(result);
		}
		if (!replacementText) continue;
		candidates.push({
			targetTag: result.tagOrdinal,
			entryId: result.entryId,
			replacementText,
		});
	}
	return candidates;
}
