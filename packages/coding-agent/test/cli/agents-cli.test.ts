import { describe, expect, it } from "bun:test";
import { serializeAgent, toFrontmatter } from "../../src/cli/agents-cli";
import { loadBundledAgents, parseAgent } from "../../src/task/agents";
import type { AgentDefinition } from "../../src/task/types";

function makeAgent(overrides: Partial<AgentDefinition>): AgentDefinition {
	return {
		name: "test",
		description: "desc",
		systemPrompt: "body",
		tools: ["read", "search"],
		source: "user",
		readOnly: false,
		...overrides,
	};
}

describe("toFrontmatter", () => {
	it.each([
		["author opted in", { explicitReadOnly: true, readOnly: true }, true],
		["author opted out", { explicitReadOnly: false, readOnly: false }, false],
		// Inferred readOnly must NOT be baked into the file — re-parsing should re-infer.
		["inferred only", { explicitReadOnly: undefined, readOnly: true }, undefined],
	])("emits explicit readOnly (%s)", (_label, overrides, expected) => {
		expect(toFrontmatter(makeAgent(overrides)).readOnly).toBe(expected);
	});
});

describe("serializeAgent round-trip", () => {
	it("preserves explicit readOnly through serialize → parse", () => {
		const explore = loadBundledAgents().find(a => a.name === "explore")!;
		const reparsed = parseAgent("test:explore.md", serializeAgent(explore), "user");
		expect(reparsed.explicitReadOnly).toBe(true);
		expect(reparsed.readOnly).toBe(true);
	});

	it("does not freeze inferred readOnly into the on-disk file", () => {
		const inferred = makeAgent({ tools: ["read", "search", "find"], readOnly: true, explicitReadOnly: undefined });
		const serialized = serializeAgent(inferred);
		expect(serialized).not.toMatch(/^readOnly:/m);
		const reparsed = parseAgent("test:scout.md", serialized, "user");
		expect(reparsed.explicitReadOnly).toBeUndefined();
		expect(reparsed.readOnly).toBe(true);
	});
});
