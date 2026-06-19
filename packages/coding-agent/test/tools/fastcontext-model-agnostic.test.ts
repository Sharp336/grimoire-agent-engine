import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelLookupRegistry } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";

/**
 * Integration test proving the fastcontext subagent is model-agnostic:
 * its default model is a role (`pi/smol`), and runtime overrides resolve
 * to any provider's model — z.ai GLM, OpenAI GPT, etc.
 *
 * No network calls. Exercises the model-resolution pipeline only.
 */

function makeModel(provider: string, id: string, api: Api = "anthropic-messages"): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api,
		baseUrl: `https://${provider}.example.test`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function makeRegistry(models: Model<Api>[]): ModelLookupRegistry {
	return {
		getAvailable: () => models,
	} as unknown as ModelLookupRegistry;
}

describe("fastcontext subagent model-agnosticism", () => {
	it("uses pi/smol as default model (a role, not a hardcoded provider)", () => {
		const agents = loadBundledAgents();
		const fc = agents.find(a => a.name === "fastcontext");
		expect(fc).toBeDefined();
		expect(fc!.model).toEqual(["pi/smol"]);
		expect(fc!.model![0]).not.toMatch(/^(openai|zai|anthropic|google)\//);
	});

	it("is classified as read-only with verbatim reads", () => {
		const agents = loadBundledAgents();
		const fc = agents.find(a => a.name === "fastcontext")!;
		expect(isReadOnlyAgent(fc)).toBe(true);
		expect(fc.readSummarize).toBe(false);
		expect(fc.tools).toEqual(["read", "search", "find", "yield"]);
	});

	it("resolves z.ai GLM model override without error", () => {
		const zaiModel = makeModel("zai", "glm-5-turbo");
		const registry = makeRegistry([zaiModel]);
		const settings = Settings.isolated();

		const patterns = resolveAgentModelPatterns({
			settingsOverride: "zai/glm-5-turbo",
			agentModel: ["pi/smol"],
			settings,
			activeModelPattern: "zai/glm-5-turbo",
			fallbackModelPattern: "zai/glm-5-turbo",
		});
		expect(patterns).toEqual(["zai/glm-5-turbo"]);

		const result = resolveModelOverride(patterns, registry, settings);
		expect(result.model).toBeDefined();
		expect(result.model!.provider).toBe("zai");
		expect(result.model!.id).toBe("glm-5-turbo");
	});

	it("resolves OpenAI GPT model override without error", () => {
		const gptModel = makeModel("openai", "gpt-5.5", "openai-responses");
		const registry = makeRegistry([gptModel]);
		const settings = Settings.isolated();

		const patterns = resolveAgentModelPatterns({
			settingsOverride: "openai/gpt-5.5",
			agentModel: ["pi/smol"],
			settings,
			activeModelPattern: "openai/gpt-5.5",
			fallbackModelPattern: "openai/gpt-5.5",
		});
		expect(patterns).toEqual(["openai/gpt-5.5"]);

		const result = resolveModelOverride(patterns, registry, settings);
		expect(result.model).toBeDefined();
		expect(result.model!.provider).toBe("openai");
		expect(result.model!.id).toBe("gpt-5.5");
	});

	it("resolves openai-codex GPT model override without error", () => {
		const codexModel = makeModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const registry = makeRegistry([codexModel]);
		const settings = Settings.isolated();

		const patterns = resolveAgentModelPatterns({
			settingsOverride: "openai-codex/gpt-5.5",
			agentModel: ["pi/smol"],
			settings,
			activeModelPattern: "openai-codex/gpt-5.5",
			fallbackModelPattern: "openai-codex/gpt-5.5",
		});
		expect(patterns).toEqual(["openai-codex/gpt-5.5"]);

		const result = resolveModelOverride(patterns, registry, settings);
		expect(result.model).toBeDefined();
		expect(result.model!.provider).toBe("openai-codex");
		expect(result.model!.id).toBe("gpt-5.5");
	});

	it("falls back to agent model when no override is provided", () => {
		const settings = Settings.isolated();
		const patterns = resolveAgentModelPatterns({
			agentModel: ["pi/smol"],
			settings,
			activeModelPattern: "zai/glm-5-turbo",
			fallbackModelPattern: "zai/glm-5-turbo",
		});
		expect(patterns.length).toBeGreaterThan(0);
	});
});
