import { describe, expect, it } from "bun:test";
import { applyOpenAIExtraBody, applyChatCompletionsCompatPolicy, resolveOpenAICompatPolicy } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { OpenAICompletionsParams } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/**
 * These tests exercise the pure request-shaping functions directly,
 * avoiding the streaming provider chain (and its native-addon dependency).
 */
function createModel(
	effortBudgets?: Partial<Record<Effort, number>>,
	extraCompat?: Partial<NonNullable<ModelSpec<"openai-completions">["compat"]>>,
): Model<"openai-completions"> {
	return buildModel({
		id: "glm-5.2-v2",
		name: "GLM-5.2 v2",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			...(effortBudgets ? { effortBudgets } : {}),
		},
		compat: {
			thinkingFormat: "sglang-strict",
			supportsReasoningParams: true,
			...extraCompat,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 20_000,
	} as ModelSpec<"openai-completions">);
}

function buildParams(): OpenAICompletionsParams {
	return {
		model: "glm-5.2-v2",
		messages: [],
		stream: true,
	};
}

describe("sglang-strict thinking format — resolver", () => {
	it("maps thinkingFormat sglang-strict to disableMode sglang-template-false", () => {
		const model = createModel();
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			reasoning: "high",
		});
		expect(policy.reasoning.dialect).toBe("sglang-strict");
		expect(policy.reasoning.disableMode).toBe("sglang-template-false");
	});
});

describe("sglang-strict thinking format — enabled reasoning", () => {
	const budgets: Partial<Record<Effort, number>> = {
		[Effort.Minimal]: 256,
		[Effort.Low]: 512,
		[Effort.Medium]: 1024,
		[Effort.High]: 2048,
		[Effort.XHigh]: 4096,
	};

	for (const [effort, expected] of [
		["minimal", 256],
		["low", 512],
		["medium", 1024],
		["high", 2048],
		["xhigh", 4096],
	] as const) {
		it(`injects thinking_budget=${expected} for ${effort} effort`, () => {
			const model = createModel(budgets);
			const policy = resolveOpenAICompatPolicy(model, {
				endpoint: "chat-completions",
				reasoning: effort,
			});
			const params = buildParams();
			applyChatCompletionsCompatPolicy(params, policy);
			expect(params.custom_params).toEqual({ thinking_budget: expected });
			expect(params.reasoning_effort).toBeUndefined();
		});
	}

	it("omits custom_params when effortBudgets has no entry for the requested effort", () => {
		const model = createModel({ [Effort.High]: 2048 });
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			reasoning: "medium",
		});
		const params = buildParams();
		applyChatCompletionsCompatPolicy(params, policy);
		expect(params.custom_params).toBeUndefined();
	});
});

describe("sglang-strict thinking format — disabled reasoning", () => {
	it("sends chat_template_kwargs.enable_thinking=false when reasoning is disabled", () => {
		const model = createModel();
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		const params = buildParams();
		applyChatCompletionsCompatPolicy(params, policy);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(params.custom_params).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});
});

describe("sglang-strict thinking format — extraBody deep-merge", () => {
	it("preserves dynamic thinking_budget over static extraBody custom_params", () => {
		const model = createModel(
			{ [Effort.Medium]: 1024 },
			{
				extraBody: {
					custom_params: { thinking_budget: 99999, unrelated_param: "keep-me" },
				},
			},
		);
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			reasoning: "medium",
		});
		const params = buildParams();
		applyChatCompletionsCompatPolicy(params, policy);
		applyOpenAIExtraBody(params, model.compat!.extraBody);
		expect(params.custom_params).toEqual({ thinking_budget: 1024, unrelated_param: "keep-me" });
	});

	it("preserves dynamic enable_thinking=false over static extraBody chat_template_kwargs", () => {
		const model = createModel(
			undefined,
			{
				extraBody: {
					chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
				},
			},
		);
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		const params = buildParams();
		applyChatCompletionsCompatPolicy(params, policy);
		applyOpenAIExtraBody(params, model.compat!.extraBody);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, enable_thinking: false });
	});

	it("preserves unrelated static extraBody top-level fields", () => {
		const model = createModel(
			{ [Effort.High]: 2048 },
			{
				extraBody: {
					top_level_field: "survive",
					custom_params: { thinking_budget: 99999 },
				},
			},
		);
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			reasoning: "high",
		});
		const params = buildParams();
		applyChatCompletionsCompatPolicy(params, policy);
		applyOpenAIExtraBody(params, model.compat!.extraBody);
		expect((params as Record<string, unknown>).top_level_field).toBe("survive");
		expect(params.custom_params).toEqual({ thinking_budget: 2048 });
	});
});
