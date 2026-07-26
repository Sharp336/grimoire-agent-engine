import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import {
	DEFAULT_PRUNE_CONFIG,
	planToolOutputPruning,
	readToolSupersedeKey,
} from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { planCavemanCompression } from "./caveman";
import { buildReductionUnits } from "./reduction-units";
import { planSmartCleanup } from "./smart-cleanup";
import type { ContextDropRecord, ContextDropSource, MessageTagRecord } from "./types";

export interface AutomaticCleanupCandidate {
	readonly targetTag: number;
	readonly entryId: string;
	readonly source: ContextDropSource;
	readonly replacementText?: string;
	readonly clearReasoning?: boolean;
	readonly reason?: string;
}

export function shouldScheduleAutomaticCleanup(
	tags: readonly MessageTagRecord[],
	protectedTagCount: number,
	cleanupWatermarkTag: number,
): boolean {
	let activeTags = 0;
	let newestTag = 0;
	for (const tag of tags) {
		if (tag.supersededAt !== undefined) continue;
		activeTags++;
		newestTag = Math.max(newestTag, tag.tagOrdinal);
	}
	return activeTags > Math.max(0, protectedTagCount) && newestTag > cleanupWatermarkTag;
}

/** Select cleanup victims only at an execute boundary; callers persist the returned immutable plan. */
export function planAutomaticCleanup(
	entries: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	existingDrops: readonly ContextDropRecord[],
	options: {
		readonly protectedTagCount: number;
		readonly clearReasoningAge: number;
		readonly smartDrops: boolean;
		readonly cavemanEnabled: boolean;
		readonly cavemanMinChars: number;
	},
): AutomaticCleanupCandidate[] {
	const activeTags = tags.filter(tag => tag.supersededAt === undefined);
	const tagByEntry = new Map(activeTags.filter(tag => tag.entryId !== undefined).map(tag => [tag.entryId!, tag]));
	const protectedEntryIds = new Set(
		activeTags
			.slice()
			.sort((left, right) => right.tagOrdinal - left.tagOrdinal)
			.slice(0, Math.max(0, options.protectedTagCount))
			.flatMap(tag => (tag.entryId ? [tag.entryId] : [])),
	);
	for (const unit of buildReductionUnits(entries, tags, options.protectedTagCount)) {
		if (unit.protectionReasons.length === 0) continue;
		for (const entryId of unit.entryIds) protectedEntryIds.add(entryId);
	}

	const alreadyRemoved = new Set(
		existingDrops
			.filter(drop => drop.replacementText === undefined && !drop.clearReasoning)
			.flatMap(drop => drop.expandedTags),
	);
	const alreadyReplaced = new Set(
		existingDrops.filter(drop => drop.replacementText !== undefined).map(drop => drop.targetTag),
	);
	const alreadyCleared = new Set(existingDrops.filter(drop => drop.clearReasoning).map(drop => drop.targetTag));
	const candidates: AutomaticCleanupCandidate[] = [];
	const toolPlan = planToolOutputPruning(entries, {
		...DEFAULT_PRUNE_CONFIG,
		protectTokens: 0,
		protectedEntryIds,
		supersedeKey: readToolSupersedeKey,
	});
	for (const candidate of toolPlan.candidates) {
		const tag = tagByEntry.get(candidate.entry.id);
		if (!tag || alreadyRemoved.has(tag.tagOrdinal) || alreadyReplaced.has(tag.tagOrdinal)) continue;
		candidates.push({
			targetTag: tag.tagOrdinal,
			entryId: candidate.entry.id,
			source: candidate.reason,
			replacementText: candidate.notice,
		});
	}

	const newestTag = activeTags.reduce((maximum, tag) => Math.max(maximum, tag.tagOrdinal), 0);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const tag = tagByEntry.get(entry.id);
		if (
			!tag ||
			newestTag - tag.tagOrdinal < options.clearReasoningAge ||
			protectedEntryIds.has(entry.id) ||
			alreadyRemoved.has(tag.tagOrdinal) ||
			alreadyCleared.has(tag.tagOrdinal)
		) {
			continue;
		}
		const hasUnsignedReasoning = entry.message.content.some(
			part => part.type === "thinking" && !part.thinkingSignature,
		);
		if (!hasUnsignedReasoning) continue;
		candidates.push({
			targetTag: tag.tagOrdinal,
			entryId: entry.id,
			source: "reasoning",
			clearReasoning: true,
		});
	}
	if (options.smartDrops) {
		const plannedTags = new Set(candidates.map(candidate => candidate.targetTag));
		for (const candidate of planSmartCleanup(entries, tags, existingDrops, protectedEntryIds)) {
			if (plannedTags.has(candidate.targetTag)) continue;
			plannedTags.add(candidate.targetTag);
			candidates.push({ ...candidate, source: "smart" });
		}
	}
	if (options.cavemanEnabled) {
		for (const candidate of planCavemanCompression(entries, tags, existingDrops, {
			protectedTagCount: options.protectedTagCount,
			minChars: options.cavemanMinChars,
		})) {
			candidates.push({
				targetTag: candidate.targetTag,
				entryId: candidate.entryId,
				source: "caveman",
				reason: `caveman:${candidate.depth}`,
				replacementText: candidate.replacementText,
			});
		}
	}
	return candidates;
}
