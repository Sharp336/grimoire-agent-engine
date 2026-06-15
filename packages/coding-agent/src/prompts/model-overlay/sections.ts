import type { ModelOverlayFamily } from "./detect";

export const GPT5_OVERLAY_SECTION = `## Model overlay: GPT-5
- Prefer outcome-first work: name the destination, constraints, and stopping condition, then act without mechanical step-by-step narration.
- Default to modest reasoning and escalate only for subtle bugs, multi-constraint design, or root-cause uncertainty.
- For multi-step work, use concise structure; when a shape is required, state exact fields and order.
- Use read for inspection, edit for file changes, search/find for lookup, bash only for commands that compute or verify.
- Dig one layer past the first plausible symptom before settling on a fix.`;

export const CLAUDE_OPUS_OVERLAY_SECTION = `## Model overlay: Claude Opus
- Preserve the full requested scope: words like every, all, and for each apply to the complete set, not the first matching item.
- Follow ordered instructions in order; if asked to do X then Y, do not invert or merge the sequence.
- Maintain precise state across long tool workflows without drifting from the original goal.
- Use task for parallelizable multi-file work, and keep edits narrow and grounded in observed files.`;

export const KIMI_K2_OVERLAY_SECTION = `## Model overlay: Kimi K2
- Be restrained and outcome-first: choose one path, act, and reopen it only when new evidence contradicts it.
- Execute mechanical or already-specified work directly; reserve deeper reasoning for ambiguity, failure, or irreversible operations.
- Keep tool calls disciplined: read before editing, use edit/write/search/find rather than bash substitutes, and verify before claiming done.
- Write leanly; do not restate choices already made in the same turn.`;

export function getModelOverlaySection(family: ModelOverlayFamily): string {
	if (family === "gpt-5") {
		return GPT5_OVERLAY_SECTION;
	}
	if (family === "claude-opus") {
		return CLAUDE_OPUS_OVERLAY_SECTION;
	}

	return KIMI_K2_OVERLAY_SECTION;
}
