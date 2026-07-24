import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
} from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { MessageTagRecord } from "./types";

export type ReductionProtectionReason =
	| "latest-turn"
	| "protected-tail"
	| "incomplete-tool-batch"
	| "untagged-message"
	| "skill-output";

export interface ReductionUnit {
	readonly id: string;
	readonly entryIds: readonly string[];
	readonly tagOrdinals: readonly number[];
	readonly protectionReasons: readonly ReductionProtectionReason[];
}

export interface ReductionTargetRejection {
	readonly tagOrdinal: number;
	readonly reasons: readonly ReductionProtectionReason[] | readonly ["unknown-tag"];
}

export interface ReductionTargetPlan {
	readonly requestedTags: readonly number[];
	readonly expandedTags: readonly number[];
	readonly units: readonly ReductionUnit[];
	readonly rejected: readonly ReductionTargetRejection[];
}

interface MutableReductionUnit {
	entryIds: string[];
	tagOrdinals: number[];
	protectionReasons: Set<ReductionProtectionReason>;
}

function finishUnit(unit: MutableReductionUnit, index: number): ReductionUnit {
	return {
		id: `turn-${index + 1}`,
		entryIds: unit.entryIds,
		tagOrdinals: unit.tagOrdinals,
		protectionReasons: [...unit.protectionReasons],
	};
}

/** Build user-turn units while preserving every assistant tool-call/result batch. */
export function buildReductionUnits(
	entries: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	protectedTagCount: number,
): ReductionUnit[] {
	const activeTagByEntry = new Map(
		tags.filter(tag => tag.entryId !== undefined && tag.supersededAt === undefined).map(tag => [tag.entryId!, tag]),
	);
	const toolCallsById = collectToolCallsById(entries);
	const units: ReductionUnit[] = [];
	let current: MutableReductionUnit | undefined;
	let currentToolCallIds = new Set<string>();
	let currentToolResultIds = new Set<string>();

	const flush = (): void => {
		if (!current) return;
		for (const callId of currentToolCallIds) {
			if (!currentToolResultIds.has(callId)) current.protectionReasons.add("incomplete-tool-batch");
		}
		for (const resultId of currentToolResultIds) {
			if (!currentToolCallIds.has(resultId)) current.protectionReasons.add("incomplete-tool-batch");
		}
		units.push(finishUnit(current, units.length));
		current = undefined;
		currentToolCallIds = new Set<string>();
		currentToolResultIds = new Set<string>();
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") flush();
		current ??= { entryIds: [], tagOrdinals: [], protectionReasons: new Set() };
		current.entryIds.push(entry.id);
		const tag = activeTagByEntry.get(entry.id);
		if (tag) current.tagOrdinals.push(tag.tagOrdinal);
		else current.protectionReasons.add("untagged-message");

		if (entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type === "toolCall") currentToolCallIds.add(part.id);
			}
		} else if (entry.message.role === "toolResult") {
			currentToolResultIds.add(entry.message.toolCallId);
			if (
				isProtectedToolResult(entry.message as ToolResultMessage, toolCallsById.get(entry.message.toolCallId), [
					"skill",
					isSkillReadToolResult,
				])
			) {
				current.protectionReasons.add("skill-output");
			}
		}
	}
	flush();

	if (units.length > 0) {
		const latest = units[units.length - 1];
		units[units.length - 1] = {
			...latest,
			protectionReasons: [...new Set([...latest.protectionReasons, "latest-turn" as const])],
		};
	}
	const protectedOrdinals = new Set(
		tags
			.filter(tag => tag.supersededAt === undefined)
			.sort((left, right) => right.tagOrdinal - left.tagOrdinal)
			.slice(0, Math.max(0, protectedTagCount))
			.map(tag => tag.tagOrdinal),
	);
	return units.map(unit => {
		const insideProtectionWindow = unit.tagOrdinals.some(tag => protectedOrdinals.has(tag));
		const protectionReasons = unit.protectionReasons.filter(
			reason => reason !== "skill-output" || insideProtectionWindow,
		);
		return insideProtectionWindow
			? {
					...unit,
					protectionReasons: [...new Set([...protectionReasons, "protected-tail" as const])],
				}
			: { ...unit, protectionReasons };
	});
}

export function planReductionTargets(
	units: readonly ReductionUnit[],
	requestedTags: readonly number[],
): ReductionTargetPlan {
	const normalizedRequested = [...new Set(requestedTags.filter(Number.isSafeInteger))];
	const unitByTag = new Map<number, ReductionUnit>();
	for (const unit of units) {
		for (const tag of unit.tagOrdinals) unitByTag.set(tag, unit);
	}
	const selectedUnits = new Map<string, ReductionUnit>();
	const rejected: ReductionTargetRejection[] = [];
	for (const tagOrdinal of normalizedRequested) {
		const unit = unitByTag.get(tagOrdinal);
		if (!unit) {
			rejected.push({ tagOrdinal, reasons: ["unknown-tag"] });
		} else if (unit.protectionReasons.length > 0) {
			rejected.push({ tagOrdinal, reasons: unit.protectionReasons });
		} else {
			selectedUnits.set(unit.id, unit);
		}
	}
	const selected = [...selectedUnits.values()];
	const expandedTags = [...new Set(selected.flatMap(unit => unit.tagOrdinals))].sort((left, right) => left - right);
	return { requestedTags: normalizedRequested, expandedTags, units: selected, rejected };
}
