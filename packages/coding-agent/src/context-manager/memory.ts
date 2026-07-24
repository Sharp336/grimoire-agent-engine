import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import memoryBlockTemplate from "../prompts/context-manager/memory-block.md" with { type: "text" };

const renderMemoryBlock = prompt.compile(memoryBlockTemplate);

export type ContextMemoryScope = "project" | "user";

export interface ContextMemoryRecord {
	readonly id: string;
	readonly bank: string;
	readonly scope: ContextMemoryScope;
	readonly content: string;
	readonly source?: string;
	readonly timestamp?: string;
	readonly score: number;
	readonly importance?: number;
	readonly recallCount?: number;
}

export interface ContextMemoryRecallResult {
	readonly query: string;
	readonly project: readonly ContextMemoryRecord[];
	readonly user: readonly ContextMemoryRecord[];
}

export interface ContextMemoryRememberInput {
	readonly content: string;
	readonly source: string;
	readonly importance?: number;
	readonly memoryType?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextMemoryReadResult {
	readonly id: string;
	readonly bank: string;
	readonly scope: ContextMemoryScope;
	readonly content: string;
	readonly source?: string;
	readonly importance?: number;
	readonly memoryType?: string;
	readonly metadata?: unknown;
	readonly editable: boolean;
}

export interface ContextMemoryMaintenanceRecord extends ContextMemoryReadResult {
	readonly recallCount: number;
	readonly lastRecalled?: string;
	readonly validUntil?: string;
	readonly createdAt?: string;
}

export interface ContextMemoryPatchInput extends ContextMemoryEditInput {
	readonly memoryType?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly source?: string;
}

export type ContextMemoryEditOperation = "update" | "invalidate" | "forget";

export interface ContextMemoryEditInput {
	readonly content?: string;
	readonly importance?: number;
	readonly replacementId?: string;
}

export interface ContextMemoryEditResult {
	readonly status: "updated" | "invalidated" | "deleted" | "not_found" | "not_editable";
	readonly id: string;
	readonly bank?: string;
	readonly scope?: ContextMemoryScope;
}

export interface ContextMemoryEmbeddingIdentity {
	readonly enabled: boolean;
	readonly provider: string;
	readonly model: string;
}

export interface ContextMemoryAdapter {
	readonly available: boolean;
	readonly autoRecall: boolean;
	readonly projectBank: string;
	readonly userBank: string;
	readonly embeddingIdentity: ContextMemoryEmbeddingIdentity;
	recall(query: string, limit: number, signal?: AbortSignal): Promise<ContextMemoryRecallResult>;
	read(id: string): ContextMemoryReadResult | undefined;
	remember(scope: ContextMemoryScope, input: ContextMemoryRememberInput): Promise<string | undefined>;
	edit(operation: ContextMemoryEditOperation, id: string, input?: ContextMemoryEditInput): ContextMemoryEditResult;
	merge(scope: ContextMemoryScope, ids: readonly string[]): Promise<string | undefined>;
	list(scope?: ContextMemoryScope): readonly ContextMemoryMaintenanceRecord[];
	patch(id: string, input: ContextMemoryPatchInput): ContextMemoryEditResult;
	embedBatch(texts: readonly string[]): Promise<readonly Float32Array[] | undefined>;
	cosineSimilarity(left: Float32Array, right: Float32Array): number;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
}

export function latestContextMemoryQuery(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		const text = messageText(message);
		if (text) return text;
	}
	return undefined;
}

interface MemoryTemplateRecord {
	readonly id: string;
	readonly score: string;
	readonly source?: string;
	readonly content: string;
}

interface MemoryTemplateGroup {
	readonly bank?: string;
	readonly records: readonly MemoryTemplateRecord[];
}

function memoryTemplateGroup(records: readonly ContextMemoryRecord[]): MemoryTemplateGroup | undefined {
	if (records.length === 0) return undefined;
	const bank = records[0]?.bank;
	return {
		...(bank ? { bank: escapeXmlAttribute(bank) } : {}),
		records: records.map(record => ({
			id: escapeXmlAttribute(record.id),
			score: record.score.toFixed(4),
			...(record.source ? { source: escapeXmlAttribute(record.source) } : {}),
			content: escapeXmlText(record.content),
		})),
	};
}

function renderSelection(records: readonly ContextMemoryRecord[]): string {
	return renderMemoryBlock({
		project: memoryTemplateGroup(records.filter(record => record.scope === "project")),
		user: memoryTemplateGroup(records.filter(record => record.scope === "user")),
	}).replace(/\n$/, "");
}

export function renderContextMemory(
	result: ContextMemoryRecallResult,
	budgetTokens: number,
): { readonly block?: string; readonly records: readonly ContextMemoryRecord[]; readonly tokens: number } {
	const candidates = [...result.project, ...result.user].sort(
		(left, right) =>
			right.score - left.score ||
			left.scope.localeCompare(right.scope) ||
			left.bank.localeCompare(right.bank) ||
			left.id.localeCompare(right.id),
	);
	const selected: ContextMemoryRecord[] = [];
	let block = "";
	let tokens = 0;
	for (const candidate of candidates) {
		const next = [...selected, candidate];
		const rendered = renderSelection(next);
		const nextTokens = countTokens(rendered);
		if (nextTokens > budgetTokens) continue;
		selected.push(candidate);
		block = rendered;
		tokens = nextTokens;
	}
	return { block: block || undefined, records: selected, tokens };
}
