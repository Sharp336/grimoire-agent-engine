import adversarialLens from "../prompts/council/lens-adversarial.md" with { type: "text" };
import architectureLens from "../prompts/council/lens-architecture.md" with { type: "text" };
import completenessLens from "../prompts/council/lens-completeness.md" with { type: "text" };
import correctnessLens from "../prompts/council/lens-correctness.md" with { type: "text" };
import genericLens from "../prompts/council/lens-generic.md" with { type: "text" };

export const COUNCIL_REVIEW_LENSES = [adversarialLens, architectureLens, correctnessLens, completenessLens] as const;

/** Return the independent review lens for a zero-based enabled-roster position. */
export function getCouncilLens(rosterPosition: number): string {
	if (!Number.isSafeInteger(rosterPosition) || rosterPosition < 0) {
		throw new RangeError(`Council roster position must be a non-negative safe integer, received ${rosterPosition}`);
	}
	return COUNCIL_REVIEW_LENSES[rosterPosition] ?? genericLens;
}
