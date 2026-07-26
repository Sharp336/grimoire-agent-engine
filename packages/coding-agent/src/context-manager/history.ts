import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import historyBlockTemplate from "../prompts/context-manager/history-block.md" with { type: "text" };
import historyCompartmentTemplate from "../prompts/context-manager/history-compartment.md" with { type: "text" };

const renderHistoryBlock = prompt.compile(historyBlockTemplate);
const renderHistoryCompartment = prompt.compile(historyCompartmentTemplate);

import type { ContextCompartmentRecord } from "./types";

export type ContextHistoryTier = 1 | 2 | 3;

export interface RenderedHistoryCompartment {
	readonly id: string;
	readonly tier: ContextHistoryTier;
	readonly text: string;
}

export interface TieredHistoryRenderResult {
	readonly block: string;
	readonly tokens: number;
	readonly budgetTokens: number;
	readonly compartments: readonly RenderedHistoryCompartment[];
	readonly omittedCompartmentIds: readonly string[];
	readonly mergeSuggested: boolean;
}

function tierText(compartment: ContextCompartmentRecord, tier: ContextHistoryTier): string {
	if (tier === 3) return compartment.p3;
	if (tier === 2) return compartment.p2;
	return compartment.p1;
}

function renderCompartment(
	compartment: ContextCompartmentRecord,
	tier: ContextHistoryTier,
	temporalAwareness: boolean,
): string {
	const includeDates = temporalAwareness && compartment.startDate && compartment.endDate;
	return renderHistoryCompartment({
		startTag: compartment.startTag,
		endTag: compartment.endTag,
		tier,
		title: escapeXmlAttribute(compartment.title),
		...(includeDates
			? {
					startDate: escapeXmlAttribute(compartment.startDate!),
					endDate: escapeXmlAttribute(compartment.endDate!),
				}
			: {}),
		content: escapeXmlText(tierText(compartment, tier)),
	}).replace(/\n$/, "");
}

function wrapHistory(compartments: readonly string[]): string {
	if (compartments.length === 0) return "";
	return renderHistoryBlock({ compartments: compartments.map(text => ({ text })) }).replace(/\n$/, "");
}

/** Render newest history at P3, then decay oldest P3→P2→P1 and finally omit only whole oldest blocks. */
export function renderTieredHistory(
	compartments: readonly ContextCompartmentRecord[],
	budgetTokens: number,
	temporalAwareness: boolean,
): TieredHistoryRenderResult {
	const ordered = [...compartments].sort(
		(left, right) => left.startTag - right.startTag || left.endTag - right.endTag || left.id.localeCompare(right.id),
	);
	const tiers = new Map(ordered.map(compartment => [compartment.id, 3 as ContextHistoryTier]));
	const omitted = new Set<string>();
	const renderCurrent = (): {
		block: string;
		tokens: number;
		items: RenderedHistoryCompartment[];
	} => {
		const items = ordered
			.filter(compartment => !omitted.has(compartment.id))
			.map(compartment => {
				const tier = tiers.get(compartment.id) ?? 1;
				return {
					id: compartment.id,
					tier,
					text: renderCompartment(compartment, tier, temporalAwareness),
				};
			});
		const block = wrapHistory(items.map(item => item.text));
		return { block, tokens: block ? countTokens(block) : 0, items };
	};
	const budget = Math.max(0, Math.floor(budgetTokens));
	let rendered = renderCurrent();
	for (const compartment of ordered) {
		while (rendered.tokens > budget) {
			const tier = tiers.get(compartment.id) ?? 1;
			if (tier <= 1) break;
			tiers.set(compartment.id, (tier - 1) as ContextHistoryTier);
			rendered = renderCurrent();
		}
		if (rendered.tokens <= budget) break;
	}
	for (const compartment of ordered) {
		if (rendered.tokens <= budget) break;
		omitted.add(compartment.id);
		rendered = renderCurrent();
	}
	return {
		block: rendered.block,
		tokens: rendered.tokens,
		budgetTokens: budget,
		compartments: rendered.items,
		omittedCompartmentIds: ordered
			.filter(compartment => omitted.has(compartment.id))
			.map(compartment => compartment.id),
		mergeSuggested: omitted.size > 0,
	};
}

/** Prepend a stable synthetic history message before the remaining raw protected tail. */
export function injectTieredHistory(messages: AgentMessage[], historyBlock: string): AgentMessage[] {
	if (!historyBlock) return messages;
	return [
		{
			role: "user",
			content: [{ type: "text", text: historyBlock }],
			timestamp: 0,
		},
		...messages,
	];
}
