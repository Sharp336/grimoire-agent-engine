/**
 * Regression: the plan-mode active prompt MUST lead with the writable plan
 * file (the deliverable), not with an absolute "READ-ONLY" framing. The
 * advisor (and any other reviewer of the primary's `plan-mode-context`)
 * misreads a leading absolute clause and raises false blockers against the
 * primary writing the prescribed plan file — see issue #3152.
 */
import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../src/prompts/system/plan-mode-active.md" with { type: "text" };
import planModeSubagentPrompt from "../src/prompts/system/plan-mode-subagent.md" with { type: "text" };

function render(extra: Record<string, unknown> = {}): string {
	return prompt.render(planModeActivePrompt, {
		planFilePath: "local://demo-plan.md",
		planExists: false,
		askToolName: "ask",
		writeToolName: "write",
		editToolName: "edit",
		reentry: false,
		iterative: false,
		...extra,
	});
}

describe("plan-mode-active prompt", () => {
	it("leads the critical block with the writable plan-file deliverable, not READ-ONLY", () => {
		const rendered = render();
		const open = rendered.indexOf("<critical>");
		const close = rendered.indexOf("</critical>");
		expect(open).toBeGreaterThanOrEqual(0);
		expect(close).toBeGreaterThan(open);
		const critical = rendered.slice(open, close);

		const deliverable = critical.indexOf("deliverable is the plan file");
		const constraint = critical.indexOf("NEVER create, edit, or delete");
		expect(deliverable).toBeGreaterThanOrEqual(0);
		expect(constraint).toBeGreaterThan(deliverable);

		// The exact framing the advisor latched onto. Reintroducing it loses the
		// "you may write the plan file" signal in the first 120 chars of the
		// truncated one-liner the advisor sees before plan-mode-context expansion.
		expect(critical).not.toMatch(/MUST perform READ-ONLY work only/);
	});

	it("pairs the no-other-writes constraint with its plan-file exception in the same clause", () => {
		const rendered = render();
		// One sentence carries both the constraint AND its exception; a reviewer
		// reading the constraint cannot drop the exception by truncating after a
		// period or a paragraph break.
		expect(rendered).toMatch(/NEVER create, edit, or delete any file other than the plan file/);
	});
});

describe("plan-mode-subagent prompt", () => {
	it("scopes its read-only rule to the subagent and preserves the main plan-file owner", () => {
		expect(planModeSubagentPrompt).toContain("These rules apply to you, the subagent");
		expect(planModeSubagentPrompt).toContain("They do NOT restrict the main agent");
		expect(planModeSubagentPrompt).toContain("the main agent owns and updates the plan file");
	});
});
