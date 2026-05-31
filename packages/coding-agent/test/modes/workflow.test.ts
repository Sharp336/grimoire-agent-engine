import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { containsWorkflow, highlightWorkflow, WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow command detection", () => {
	it("matches only the explicit /workflow command prefix", () => {
		expect(containsWorkflow("/workflow")).toBe(true);
		expect(containsWorkflow("/workflow audit src/session")).toBe(true);
		expect(containsWorkflow("  /workflow audit src/session")).toBe(true);
	});

	it("ignores prose mentions, casing, inflections, punctuation-adjacent, and path-embedded forms", () => {
		expect(containsWorkflow("workflow")).toBe(false);
		expect(containsWorkflow("please workflow this rollout")).toBe(false);
		expect(containsWorkflow("run these workflows")).toBe(false);
		expect(containsWorkflow("design the workflow")).toBe(false);
		expect(containsWorkflow("why is the workflow keyword active?")).toBe(false);
		expect(containsWorkflow("/Workflow")).toBe(false);
		expect(containsWorkflow("/workflowed the build")).toBe(false);
		expect(containsWorkflow("reworkflow everything")).toBe(false);
		expect(containsWorkflow("packages/coding-agent/test/modes/workflow.test.ts")).toBe(false);
		expect(containsWorkflow("do it. /workflow")).toBe(false);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});

	it("ignores /workflow inside code spans, fenced blocks, and XML sections", () => {
		expect(containsWorkflow("`/workflow audit`")).toBe(false);
		expect(containsWorkflow("```\n/workflow audit\n```")).toBe(false);
		expect(containsWorkflow("<x>/workflow audit</x>")).toBe(false);
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the command prefix with zero-width escapes, preserving visible text", () => {
		const input = "/workflow audit this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the command prefix untouched", () => {
		expect(highlightWorkflow("workflowed builds")).toBe("workflowed builds");
		expect(highlightWorkflow("Workflow this")).toBe("Workflow this");
		expect(highlightWorkflow("please workflow this")).toBe("please workflow this");
		expect(highlightWorkflow("do it. /workflow")).toBe("do it. /workflow");
		const filePath = "packages/coding-agent/test/modes/workflow.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});

describe("workflow mode setting", () => {
	it("is disabled by default", () => {
		expect(Settings.isolated().get("modes.workflow.enabled")).toBe(false);
	});
});

describe("workflow notice", () => {
	it("is a non-empty system notice carrying the eval-fan-out contract", () => {
		expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0);
		expect(WORKFLOW_NOTICE).toContain("explicitly requested `/workflow`");
		expect(WORKFLOW_NOTICE).toContain("parallel(");
	});
});
