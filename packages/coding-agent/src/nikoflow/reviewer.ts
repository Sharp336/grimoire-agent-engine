import type { ReviewerVerdict } from "./gates";
import type { NikoflowPhase } from "./state";

export interface ReviewerPromptInput {
	gateId: string;
	phase: Extract<NikoflowPhase, "execute" | "verify">;
	task: string;
	diff: string;
	acceptance: readonly string[];
	adr?: string;
	prd?: string;
	validation?: string;
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
	const acceptance = input.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)";
	return [
		"You are the independent Nikoflow reviewer. The primary agent did not author this prompt.",
		`Gate id: ${input.gateId}`,
		`Phase: ${input.phase}`,
		"",
		"Original task:",
		input.task.trim() || "(not supplied)",
		"",
		"Acceptance criteria:",
		acceptance,
		"",
		"ADR:",
		input.adr?.trim() || "(none)",
		"",
		"PRD:",
		input.prd?.trim() || "(none)",
		"",
		"Validation:",
		input.validation?.trim() || "(not supplied)",
		"",
		"Diff:",
		input.diff.trim() || "(empty)",
		"",
		'Return only JSON: {"gateId":"<same>","verdict":"pass|block","score":number,"reason":"short"}.',
		"Block if validation is red, acceptance is unmet, or the diff contradicts ADR/PRD.",
	].join("\n");
}

export function reviewerPass(gateId: string, score: number, reason = "passed"): ReviewerVerdict {
	return { gateId, verdict: "pass", score, reason };
}

export function reviewerBlock(gateId: string, reason: string, score?: number): ReviewerVerdict {
	return score === undefined ? { gateId, verdict: "block", reason } : { gateId, verdict: "block", score, reason };
}
