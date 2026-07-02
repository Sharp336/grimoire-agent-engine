import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "test-rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "body",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		astCondition: partial.astCondition,
		scope: partial.scope,
		interruptMode: partial.interruptMode,
		_source: partial._source ?? {
			provider: "test-provider",
			providerName: "test-provider",
			path: "/tmp/rule.md",
			level: "user",
		},
	};
}

describe("TtsrManager stream-scope isolation", () => {
	it("text-scoped rules do not match thinking deltas", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "text-only",
			condition: ["FORBIDDEN"],
			scope: ["text"],
		});
		expect(manager.addRule(rule)).toBe(true);

		const matches = manager.checkDelta("FORBIDDEN", { source: "thinking" });
		expect(matches).toEqual([]);
	});

	it("thinking-scoped rules match thinking", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "thinking-only",
			condition: ["FORBIDDEN"],
			scope: ["thinking"],
		});
		expect(manager.addRule(rule)).toBe(true);

		const matches = manager.checkDelta("FORBIDDEN", { source: "thinking" });
		expect(matches).toContainEqual(rule);
	});

	it("thinking-scoped rules do not match text deltas", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "thinking-only",
			condition: ["FORBIDDEN"],
			scope: ["thinking"],
		});
		expect(manager.addRule(rule)).toBe(true);

		const matches = manager.checkDelta("FORBIDDEN", { source: "text" });
		expect(matches).toEqual([]);
	});

	it("two different buffer keys (different toolNames) do not concatenate into each other", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "tool-rule",
			condition: ["FORBIDDEN"],
			scope: ["tool"],
		});
		expect(manager.addRule(rule)).toBe(true);

		// Send prefix to "edit" tool stream
		const matchesEdit1 = manager.checkDelta("FORB", {
			source: "tool",
			toolName: "edit",
		});
		expect(matchesEdit1).toEqual([]);

		// Send suffix to "write" tool stream - should not concatenate with edit's prefix
		const matchesWrite1 = manager.checkDelta("IDDEN", {
			source: "tool",
			toolName: "write",
		});
		expect(matchesWrite1).toEqual([]);

		// Send suffix to "edit" tool stream - should concatenate with edit's prefix and match
		const matchesEdit2 = manager.checkDelta("IDDEN", {
			source: "tool",
			toolName: "edit",
		});
		expect(matchesEdit2).toContainEqual(rule);
	});

	it("two different buffer keys (different streamKeys) do not concatenate into each other", () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "tool-rule",
			condition: ["FORBIDDEN"],
			scope: ["tool"],
		});
		expect(manager.addRule(rule)).toBe(true);

		// Send prefix on streamKey "stream1"
		const matchesStream1_1 = manager.checkDelta("FORB", {
			source: "tool",
			toolName: "edit",
			streamKey: "stream1",
		});
		expect(matchesStream1_1).toEqual([]);

		// Send suffix on streamKey "stream2" - should not concatenate with stream1
		const matchesStream2_1 = manager.checkDelta("IDDEN", {
			source: "tool",
			toolName: "edit",
			streamKey: "stream2",
		});
		expect(matchesStream2_1).toEqual([]);

		// Send suffix on streamKey "stream1" - should concatenate and match
		const matchesStream1_2 = manager.checkDelta("IDDEN", {
			source: "tool",
			toolName: "edit",
			streamKey: "stream1",
		});
		expect(matchesStream1_2).toContainEqual(rule);
	});
});
