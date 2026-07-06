import type { NikoflowState } from "./state";
import { gateMatches } from "./state";

export type NikoflowReviewerVerdict = "pass" | "block";

export interface ReviewerVerdict {
	gateId: string;
	verdict: NikoflowReviewerVerdict;
	score?: number;
	reason?: string;
}

export type ReviewerVerdictMatch =
	| { matched: true; verdict: ReviewerVerdict }
	| { matched: false; reason: "not_tool_result" | "missing_verdict" | "stale_gate" | "blocked" };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stripJsonFence(text: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	return (fenced?.[1] ?? text).trim();
}

function firstBalancedJsonObject(text: string): string | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (start === -1) {
			if (char === "{") {
				start = i;
				depth = 1;
			}
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	const trimmed = stripJsonFence(text);
	const balanced = firstBalancedJsonObject(trimmed);
	const candidates = balanced && balanced !== trimmed ? [trimmed, balanced] : [trimmed];
	for (const candidate of candidates) {
		try {
			const parsed = asRecord(JSON.parse(candidate));
			if (parsed) return parsed;
		} catch {}
	}
	return null;
}

function harnessGateId(toolResult: Record<string, unknown>): string | undefined {
	const details = asRecord(toolResult.details);
	return typeof details?.gateId === "string" && details.gateId.length > 0 ? details.gateId : undefined;
}

function contentGateId(rec: Record<string, unknown>, fallbackGateId?: string): string | null {
	if (fallbackGateId) return fallbackGateId;
	return typeof rec.gateId === "string" && rec.gateId.length > 0 ? rec.gateId : null;
}

export function parseReviewerVerdict(payload: unknown, fallbackGateId?: string): ReviewerVerdict | null {
	const rec = parseToolResultContent(payload);
	if (!rec) return null;
	const gateId = contentGateId(rec, fallbackGateId);
	if (!gateId) return null;
	if (rec.verdict !== "pass" && rec.verdict !== "block") return null;

	const verdict: ReviewerVerdict = { gateId, verdict: rec.verdict };
	if (typeof rec.score === "number" && Number.isFinite(rec.score)) {
		verdict.score = rec.score;
	}
	if (typeof rec.reason === "string") {
		verdict.reason = rec.reason;
	}
	return verdict;
}

function parseToolResultContent(content: unknown): Record<string, unknown> | null {
	const direct = asRecord(content);
	if (direct) return direct;
	if (typeof content === "string") return parseJsonObject(content);
	if (!Array.isArray(content)) return null;

	for (const part of content) {
		const rec = asRecord(part);
		if (!rec) continue;
		if (typeof rec.text === "string") {
			const parsed = parseJsonObject(rec.text);
			if (parsed) return parsed;
		}
		if (typeof rec.content === "string") {
			const parsed = parseJsonObject(rec.content);
			if (parsed) return parsed;
		}
	}
	return null;
}

export function detectReviewerVerdict(toolResult: unknown, state: NikoflowState): ReviewerVerdictMatch {
	const rec = asRecord(toolResult);
	if (!rec) return { matched: false, reason: "not_tool_result" };
	const isToolResult = rec.type === "tool_result" || rec.role === "toolResult";
	if (!isToolResult) return { matched: false, reason: "not_tool_result" };

	const verdict = parseReviewerVerdict(rec.content, harnessGateId(rec));
	if (!verdict) return { matched: false, reason: "missing_verdict" };
	if (!gateMatches(state, verdict.gateId)) return { matched: false, reason: "stale_gate" };
	if (verdict.verdict === "block") return { matched: false, reason: "blocked" };
	return { matched: true, verdict };
}

export function humanGateAccepted(
	gateMintedAt: number | null | undefined,
	userTurnAt: number | null | undefined,
): boolean {
	return gateMintedAt != null && userTurnAt != null && userTurnAt > gateMintedAt;
}
