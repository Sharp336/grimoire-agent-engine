import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec, SwarmSpec } from "@oh-my-pi/pi-catalog/types";

function swarmModelSpec(swarm: SwarmSpec): ModelSpec<"omp-swarm"> {
	return {
		id: "router-balanced",
		name: "Router Balanced",
		api: "omp-swarm",
		provider: "omp",
		baseUrl: "omp://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		swarm,
	};
}

function plainModelSpec(): ModelSpec<"openai-completions"> {
	return {
		id: "plain-model",
		name: "Plain Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("Model.swarm round-trip through buildModel", () => {
	it("preserves a router SwarmSpec deep-equal (spread carries it, no build step touches it)", () => {
		const swarm: SwarmSpec = {
			strategy: "router",
			members: [
				{ role: "weak", model: "openai/gpt-4o-mini", kind: "model" },
				{ role: "strong", model: "anthropic/claude-opus-4.6", kind: "model", surface: true },
			],
			selector: { kind: "classifier", model: "openai/gpt-4o-mini" },
			surface: "strong",
			maxMembers: 3,
			firstEventTimeoutMs: 30_000,
		};

		const model = buildModel(swarmModelSpec(swarm));

		expect(model.swarm).toEqual(swarm);
		expect(model.api).toBe("omp-swarm");
	});

	it("preserves a draft-refine sequence SwarmSpec deep-equal", () => {
		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "openai/gpt-4o-mini" },
				{ role: "refine", model: "anthropic/claude-opus-4.6", surface: true },
			],
		};

		const model = buildModel(swarmModelSpec(swarm));

		expect(model.swarm).toEqual(swarm);
		expect(model.swarm?.strategy).toBe("draft-refine");
		expect(model.swarm?.members[0]?.kind).toBeUndefined();
	});

	it("preserves a moa SwarmSpec with a subagent leaf member deep-equal", () => {
		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "openai/gpt-4o" },
				{ role: "proposer", model: "openai/gpt-4o" },
				{ role: "aggregator", model: "anthropic/claude-opus-4.6", surface: true },
				{ role: "reviewer", model: "task/reviewer", kind: "subagent" },
			],
		};

		const model = buildModel(swarmModelSpec(swarm));

		expect(model.swarm).toEqual(swarm);
		expect(model.swarm?.members.find(member => member.kind === "subagent")?.role).toBe("reviewer");
	});
});

describe("Model.swarm is absent on non-swarm models", () => {
	it("yields swarm === undefined for a normal model (no contamination)", () => {
		const model = buildModel(plainModelSpec());

		expect(model.swarm).toBeUndefined();
		expect("swarm" in model).toBe(false);
	});
});
