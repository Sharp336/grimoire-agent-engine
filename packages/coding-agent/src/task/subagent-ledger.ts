import type { AgentProgress, SingleResult } from "./types";

export interface LedgerEntry {
	timestamp: string;
	id: string;
	agent: string;
	parentModel?: string;
	selectedModel?: string;
	actualModel?: string;
	effort?: string;
	resourcePool?: string;
	fallback?: boolean;
	status: string;
	routingReason?: string;
}

function extractEffort(model?: string): string | undefined {
	if (!model) return undefined;
	const idx = model.lastIndexOf(":");
	return idx > 0 ? model.slice(idx + 1) : undefined;
}

export function progressToLedgerEntry(p: AgentProgress): LedgerEntry {
	return {
		timestamp: new Date().toISOString(),
		id: p.id,
		agent: p.agent,
		parentModel: p.parentModel,
		selectedModel: p.selectedModel ?? p.resolvedModel,
		actualModel: p.resolvedModel,
		effort: extractEffort(p.resolvedModel),
		resourcePool: p.resourcePool,
		fallback: p.resolvedModelIsFallback,
		status: p.status,
		routingReason: p.routingReason,
	};
}

export function formatRuntimeModelUsage(entries: Array<{ id: string; resolvedModel?: string; actualModel?: string }>): string {
	const lines = ["RUNTIME_MODEL_USAGE"];
	for (const e of entries) {
		const model = (e as { actualModel?: string }).actualModel ?? e.resolvedModel ?? "unknown";
		lines.push(`- ${e.id} -> ${model}`);
	}
	return lines.join("\n");
}

export function detectModelAttributionMismatch(proseModel: string, runtimeModel: string): { mismatch: boolean; warning: string; authoritative: string } {
	const norm = (s: string) => s.trim().toLowerCase();
	const mismatch = norm(proseModel) !== norm(runtimeModel);
	return {
		mismatch,
		warning: mismatch ? `MODEL_ATTRIBUTION_MISMATCH: prose claims ${proseModel} but runtime is ${runtimeModel}` : "",
		authoritative: runtimeModel,
	};
}

export function formatExpandedDetail(p: AgentProgress & { ompVersion?: string }, opts?: { ompVersion?: string }): string {
	const lines: string[] = [];
	lines.push(p.id);
	lines.push(`agent: ${p.agent}`);
	lines.push(`selected: ${p.selectedModel ?? "unknown"}`);
	lines.push(`actual: ${p.resolvedModel ?? "unknown"}`);
	if (p.parentModel) lines.push(`parent: ${p.parentModel}`);
	if (p.resourcePool) lines.push(`pool: ${p.resourcePool}`);
	if (p.routingReroutes?.length) {
		lines.push(`fallbacks: ${p.routingReroutes.map(r => `${r.from} -> ${r.to}`).join(", ")}`);
	} else if (p.resolvedModelIsFallback) {
		lines.push(`fallbacks: fallback active`);
	}
	if (p.routingReason) lines.push(`routing: ${p.routingReason}`);
	lines.push(`revision: unavailable`);
	const ver = p.ompVersion ?? opts?.ompVersion ?? "unavailable";
	lines.push(`ompVersion: ${ver}`);
	return lines.join("\n");
}

// JSONL ledger helpers (machine-owned, never LLM-authored)
export function ledgerEntryToJsonl(entry: LedgerEntry): string {
	return JSON.stringify(entry);
}
export function parseLedgerJsonl(line: string): LedgerEntry {
	return JSON.parse(line) as LedgerEntry;
}
