import { describe, expect, test } from "bun:test";
import { IntentClassifier } from "../src/intent-classifier";
import type { SessionTrace } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "test-session",
		cwd: "/tmp",
		userPrompt: overrides.userPrompt ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
		entries: overrides.entries ?? [],
	};
}

describe("IntentClassifier.ruleClassify", () => {
	test("classifies refactoring from ast_edit tool", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "refactor this function",
			entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "ast_edit", args: {} }],
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("refactoring");
		expect(result.confidence).toBeGreaterThanOrEqual(70);
		expect(result.source).toBe("rule");
	});

	test("classifies bugfix from errorCount > 0", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "fix the broken login",
			errorCount: 2,
			entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} }],
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("bugfix");
		expect(result.confidence).toBeGreaterThanOrEqual(70);
	});

	test("classifies feature-add from prompt keywords", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({
			userPrompt: "add a new OAuth provider",
		});
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("feature-add");
	});

	test("returns exploration when no signals", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({ userPrompt: "hello" });
		const result = classifier.ruleClassify(trace);
		expect(result.intent).toBe("exploration");
		expect(result.confidence).toBeLessThan(70);
	});

	test("allScores sums all intent categories", () => {
		const classifier = new IntentClassifier();
		const trace = makeTrace({ userPrompt: "test" });
		const result = classifier.ruleClassify(trace);
		const categories = [
			"refactoring",
			"bugfix",
			"feature-add",
			"testing",
			"documentation",
			"configuration",
			"exploration",
			"optimization",
			"integration",
		];
		for (const cat of categories) {
			expect(result.allScores[cat as keyof typeof result.allScores]).toBeDefined();
		}
	});
});
