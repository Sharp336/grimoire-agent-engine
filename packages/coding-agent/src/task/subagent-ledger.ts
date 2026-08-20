import type { AgentProgress } from "./types";

const PROVIDER_ABBREV: Record<string, string> = {
	"google-antigravity": "AGY",
	google: "GOOG",
	anthropic: "ANT",
	meta: "META",
	"openai-codex": "OAI",
	openai: "OAI",
	cursor: "CUR",
	zai: "ZAI",
	xai: "XAI",
};

const MODEL_ABBREV: Record<string, string> = {
	"gemini-3.7-flash": "G3.7F",
	"muse-spark-1.2-contributor": "MS1.2",
	"muse-spark-1.2": "MS1.2",
	"gpt-5.6-sol": "G5.6S",
	"gpt-5.6": "G5.6",
	"grok-4.6": "G4.6",
	"grok-4.6-high": "G4.6",
};

export function abbreviateProvider(provider: string): string {
	if (PROVIDER_ABBREV[provider]) return PROVIDER_ABBREV[provider];
	// fallback: first 3 upper chars of initials
	const parts = provider.split(/[-_/]/).filter(Boolean);
	if (parts.length > 1) return parts.map(p => p[0]?.toUpperCase() ?? "").join("").slice(0, 4);
	return provider.slice(0, 3).toUpperCase();
}

export function abbreviateModel(modelId: string): string {
	if (MODEL_ABBREV[modelId]) return MODEL_ABBREV[modelId];
	// heuristic: version + initials
	const versionMatch = modelId.match(/(\d+(?:\.\d+)+)/);
	const version = versionMatch ? versionMatch[1] : "";
	const tokens = modelId.split(/[-_]/).filter(t => !/^\d/.test(t) && t.length > 0);
	const initials = tokens.map(t => t[0]?.toUpperCase() ?? "").join("");
	if (version) {
		if (initials.length >= 2) return `${initials[0]}${version}${initials.slice(1)}`;
		return `${initials}${version}`;
	}
	return initials.slice(0, 4) || modelId.slice(0, 4).toUpperCase();
}

export function compactModelIdentity(resolved: string): string {
	// format: provider/model[:effort] -> PROV·MODEL·effort
	const slashIdx = resolved.indexOf("/");
	let provider = "";
	let rest = resolved;
	if (slashIdx >= 0) {
		provider = resolved.slice(0, slashIdx);
		rest = resolved.slice(slashIdx + 1);
	}
	const colonIdx = rest.lastIndexOf(":");
	let modelId = rest;
	let effort: string | undefined;
	if (colonIdx >= 0) {
		modelId = rest.slice(0, colonIdx);
		effort = rest.slice(colonIdx + 1);
	}
	const provAbbrev = provider ? abbreviateProvider(provider) : "";
	const modelAbbrev = abbreviateModel(modelId);
	const parts = [];
	if (provAbbrev) parts.push(provAbbrev);
	parts.push(modelAbbrev);
	if (effort) parts.push(effort);
	return parts.join("·");
}


let cachedOmpVersion: string | undefined;
export function getOmpVersion(): string {
	if (cachedOmpVersion) return cachedOmpVersion;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require("../../package.json") as { version?: string };
		if (pkg.version) {
			cachedOmpVersion = pkg.version;
			return cachedOmpVersion;
		}
	} catch {}
	cachedOmpVersion = "unknown";
	return cachedOmpVersion;
}

function extractEffort(model?: string): string | undefined {
	if (!model) return undefined;
	const idx = model.lastIndexOf(":");
	return idx > 0 ? model.slice(idx + 1) : undefined;
}

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
	routingIntent?: string;
	routingReroutes?: { from: string; to: string; reason: string }[];
	ompVersion?: string;
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
		routingIntent: p.routingIntent,
		routingReroutes: p.routingReroutes,
		ompVersion: p.ompVersion,
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
	const ver = p.ompVersion ?? opts?.ompVersion ?? getOmpVersion();
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

export function shouldAppendLedgerEntry(prev: LedgerEntry | undefined, next: LedgerEntry): boolean {
	if (!prev) return true;
	if (prev.selectedModel !== next.selectedModel) return true;
	if (prev.actualModel !== next.actualModel) return true;
	if (prev.fallback !== next.fallback) return true;
	if (prev.status !== next.status && (next.status === "completed" || next.status === "failed" || next.status === "aborted")) return true;
	const prevReroutes = prev.routingReroutes ?? [];
	const nextReroutes = next.routingReroutes ?? [];
	if (prevReroutes.length !== nextReroutes.length) return true;
	for (let i = 0; i < nextReroutes.length; i++) {
		if (prevReroutes[i]?.from !== nextReroutes[i]?.from || prevReroutes[i]?.to !== nextReroutes[i]?.to) return true;
	}
	if (prev.ompVersion !== next.ompVersion) return true;
	if (prev.parentModel !== next.parentModel) return true;
	if (prev.resourcePool !== next.resourcePool) return true;
	return false;
}

export function ledgerPathForSession(sessionFile: string): string {
	// e.g. /tmp/session.jsonl -> /tmp/session.ledger.jsonl
	if (sessionFile.endsWith(".jsonl")) return sessionFile.replace(/\.jsonl$/, ".ledger.jsonl");
	return `${sessionFile}.ledger.jsonl`;
}

export async function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): Promise<void> {
	const line = ledgerEntryToJsonl(entry) + "\n";
	const { mkdir, appendFile } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	await mkdir(dirname(ledgerPath), { recursive: true });
	await appendFile(ledgerPath, line, "utf-8");
}

export async function readLedgerEntries(ledgerPath: string): Promise<LedgerEntry[]> {
	try {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(ledgerPath, "utf-8");
		return content
			.split("\n")
			.filter(Boolean)
			.map(l => parseLedgerJsonl(l));
	} catch {
		return [];
	}
}
