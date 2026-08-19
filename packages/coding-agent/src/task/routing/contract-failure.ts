import type { SingleResult } from "../types";

export interface ContractFailureClassification {
	isContractFailure: boolean;
	reason: string;
}

/**
 * Distinguish an output-contract failure (the route could not satisfy the
 * child's required structured output) from an ordinary task/business failure.
 *
 * Only the harness-owned channels are inspected — `structuredOutput` and the
 * failure text on `stderr`/`error`. The child's own `output` is deliberately
 * excluded: a subagent that merely *writes about* a schema violation in its
 * findings must not be misclassified as a broken route.
 */
export function classifyContractFailure(result: SingleResult): ContractFailureClassification {
	const structured = result.structuredOutput;
	if (structured?.status === "invalid") {
		return {
			isContractFailure: true,
			reason: `structured output invalid: ${structured.error ?? "schema violation"}`,
		};
	}
	const failureText = [result.stderr, result.error, structured?.error].filter(Boolean).join("\n");
	const lowered = failureText.toLowerCase();
	if (lowered.includes("schema_violation")) {
		return { isContractFailure: true, reason: firstLine(failureText, "schema_violation") };
	}
	if (lowered.includes("expected object") && lowered.includes("received string")) {
		return { isContractFailure: true, reason: firstLine(failureText, "expected object") };
	}
	return { isContractFailure: false, reason: "" };
}

/** Concise one-line reason: the matched line, clipped for UI use. */
function firstLine(text: string, needle: string): string {
	const line =
		text
			.split("\n")
			.find(candidate => candidate.toLowerCase().includes(needle.toLowerCase()))
			?.trim() ?? needle;
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
