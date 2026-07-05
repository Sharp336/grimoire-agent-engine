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

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return null;
	}
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

export function parseReviewerVerdict(payload: unknown): ReviewerVerdict | null {
	const rec = parseToolResultContent(payload);
	if (!rec) return null;
	if (typeof rec.gateId !== "string" || rec.gateId.length === 0) return null;
	if (rec.verdict !== "pass" && rec.verdict !== "block") return null;

	const verdict: ReviewerVerdict = { gateId: rec.gateId, verdict: rec.verdict };
	if (typeof rec.score === "number" && Number.isFinite(rec.score)) {
		verdict.score = rec.score;
	}
	if (typeof rec.reason === "string") {
		verdict.reason = rec.reason;
	}
	return verdict;
}

export function detectReviewerVerdict(toolResult: unknown, state: NikoflowState): ReviewerVerdictMatch {
	const rec = asRecord(toolResult);
	if (!rec) return { matched: false, reason: "not_tool_result" };
	const isToolResult = rec.type === "tool_result" || rec.role === "toolResult";
	if (!isToolResult) return { matched: false, reason: "not_tool_result" };

	const verdict = parseReviewerVerdict(rec.content);
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
