import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { clampMaxTokensToContext, estimatePromptTokens } from "@oh-my-pi/pi-ai/utils/output-budget";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

// ─── clampMaxTokensToContext ─────────────────────────────────────────────────

describe("clampMaxTokensToContext", () => {
	it("passes through when contextWindow is undefined", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: undefined,
				estimatedPromptTokens: 100000,
			}),
		).toBe(16384);
	});

	it("passes through when contextWindow is zero", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 0,
				estimatedPromptTokens: 100,
			}),
		).toBe(8192);
	});

	it("passes through when contextWindow is negative", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: -1,
				estimatedPromptTokens: 100,
			}),
		).toBe(8192);
	});

	it("is a no-op when the request already fits", () => {
		// window=200000, prompt=10000, reserve=4000 → budget=186000; requested 8192 fits
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 200_000,
				estimatedPromptTokens: 10_000,
			}),
		).toBe(8192);
	});

	it("reduces when prompt + requested exceeds the window", () => {
		// window=200000, prompt=195000, reserve=4000 → budget=max(1, 1000)=1000
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: 200_000,
				estimatedPromptTokens: 195_000,
			}),
		).toBe(1000);
	});

	it("floors at 1 when the budget would be non-positive", () => {
		// window=100, prompt=200, reserve=4000 → budget=max(1, -4100)=1
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 100,
				estimatedPromptTokens: 200,
			}),
		).toBe(1);
	});

	it("respects a custom reserveTokens", () => {
		// window=200000, prompt=190000, reserve=8000 → budget=max(1, 2000)=2000
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: 200_000,
				estimatedPromptTokens: 190_000,
				reserveTokens: 8000,
			}),
		).toBe(2000);
	});
});

// ─── estimatePromptTokens ────────────────────────────────────────────────────

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { ...EMPTY_USAGE },
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("estimatePromptTokens", () => {
	it("returns 0 for empty inputs", () => {
		expect(estimatePromptTokens(undefined, [])).toBe(0);
	});

	it("counts system prompt text", () => {
		const text = "Hello world"; // 11 bytes → (11+3)>>2 = 3
		expect(estimatePromptTokens(text, [])).toBe((Buffer.byteLength(text, "utf-8") + 3) >> 2);
	});

	it("counts string message content", () => {
		const msg: UserMessage = { role: "user", content: "test message", timestamp: 0 };
		const expected = (Buffer.byteLength("test message", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts text blocks in array content", () => {
		const msg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 0,
		};
		const expected = (Buffer.byteLength("hello", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("adds IMAGE_TOKEN_ESTIMATE per image block", () => {
		const msg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "describe" },
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "image", data: "def", mimeType: "image/jpeg" },
			],
			timestamp: 0,
		};
		const textTokens = (Buffer.byteLength("describe", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(textTokens + 1200 + 1200);
	});

	it("counts thinking blocks in array content", () => {
		const thinking = "Let me reason about this step by step.";
		const msg = assistantMessage([{ type: "thinking", thinking }]);
		const expected = (Buffer.byteLength(thinking, "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});
	it("counts redactedThinking blocks in array content", () => {
		const data = "x".repeat(100_000);
		const msg = assistantMessage([{ type: "redactedThinking", data }]);
		const expected = (Buffer.byteLength(data, "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts toolCall blocks in array content", () => {
		const arguments_ = { command: "ls -la /workspace", cwd: "/home" };
		const msg = assistantMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: arguments_ }]);
		const expected = (Buffer.byteLength(JSON.stringify({ name: "bash", arguments: arguments_ }), "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts anthropicServerTool blocks (web-search replay) in array content", () => {
		const block = {
			type: "web_search_tool_result" as const,
			tool_use_id: "srv_1",
			content: [{ type: "text", text: "x".repeat(40_000) }],
		};
		const msg = assistantMessage([{ type: "anthropicServerTool", block }]);
		const expected = (Buffer.byteLength(JSON.stringify(block), "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("excludes an anthropicServerTool block a foreign target provider will drop", () => {
		// transformMessages drops native server-tool blocks for every target that
		// isn't the anthropic-messages provider that produced them, so a Bedrock
		// turn after an Anthropic web-search replays nothing for the block. The
		// estimate must not charge bytes that never reach the wire.
		const block = {
			type: "web_search_tool_result" as const,
			tool_use_id: "srv_1",
			content: [{ type: "text", text: "x".repeat(100_000) }],
		};
		const msg = assistantMessage([{ type: "anthropicServerTool", block }]);
		const bedrockTarget = makeBedrockModel(200_000, 8_192);
		expect(estimatePromptTokens(undefined, [msg], undefined, bedrockTarget)).toBe(0);
	});

	it("counts an anthropicServerTool block for its originating anthropic target", () => {
		const block = {
			type: "web_search_tool_result" as const,
			tool_use_id: "srv_1",
			content: [{ type: "text", text: "x".repeat(100_000) }],
		};
		const msg = assistantMessage([{ type: "anthropicServerTool", block }]);
		const sameProvider = makeModel(200_000, 8_192);
		const expected = (Buffer.byteLength(JSON.stringify(block), "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg], undefined, sameProvider)).toBe(expected);
	});

	it("counts serialized tools", () => {
		const tools = [{ name: "read", description: "Read a file" }];
		const toolJson = JSON.stringify(tools);
		const expected = (Buffer.byteLength(toolJson, "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [], tools)).toBe(expected);
	});

	it("combines system prompt, messages, and tools", () => {
		const system = "Be concise.";
		const msg: UserMessage = { role: "user", content: "hi", timestamp: 0 };
		const tools = [{ name: "bash" }];
		const expected =
			((Buffer.byteLength(system, "utf-8") + 3) >> 2) +
			((Buffer.byteLength("hi", "utf-8") + 3) >> 2) +
			((Buffer.byteLength(JSON.stringify(tools), "utf-8") + 3) >> 2);
		expect(estimatePromptTokens(system, [msg], tools)).toBe(expected);
	});
});

// ─── Anthropic request-building integration ──────────────────────────────────

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function makeModel(contextWindow: number, maxTokens: number): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	});
}

/** Reasoning-capable variant so extended-thinking params are built on the wire. */
function makeThinkingModel(
	contextWindow: number,
	maxTokens: number,
	requiresThinkingEnabled = false,
	supportsSamplingParams = false,
	requiresEffort = false,
): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		...(requiresEffort && {
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High], requiresEffort: true },
		}),
		compat: {
			...(requiresThinkingEnabled && { requiresThinkingEnabled: true }),
			...(supportsSamplingParams && { supportsSamplingParams: true }),
		},
	});
}

type CapturePayloadOptions = {
	temperature?: number;
	topP?: number;
	topK?: number;
};

function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	maxTokens?: number,
	thinking?: { enabled: boolean; budgetTokens?: number },
	payloadOptions?: CapturePayloadOptions,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-test",
		signal: createAbortedSignal(),
		maxTokens,
		...(thinking && { thinkingEnabled: thinking.enabled, thinkingBudgetTokens: thinking.budgetTokens }),
		...(payloadOptions?.temperature !== undefined && { temperature: payloadOptions.temperature }),
		...(payloadOptions?.topP !== undefined && { topP: payloadOptions.topP }),
		...(payloadOptions?.topK !== undefined && { topK: payloadOptions.topK }),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("anthropic output-budget clamp integration", () => {
	it("shrinks an oversized declared max_tokens to fit the context window", async () => {
		// contextWindow=10000, maxTokens(model)=8192, requested=8192
		// A large prompt (~6000 tokens estimated) leaves little room.
		const model = makeModel(10_000, 8_192);
		// Build a prompt that estimates to ~6000 tokens: 24000 bytes → (24000+3)>>2 = 6000
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192);
		// budget = max(1, 10000 - 6000 - 4000) = max(1, 0) = 1
		// clamp: min(8192, 1) = 1
		expect(payload.max_tokens).toBe(1);
	});

	it("leaves a fitting max_tokens untouched", async () => {
		const model = makeModel(200_000, 8_192);
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 4096);
		// prompt estimate is tiny; budget >> 4096, so no clamp
		expect(payload.max_tokens).toBe(4096);
	});

	it("keeps max_tokens above thinking.budget_tokens after clamping a near-full window", async () => {
		// contextWindow=16000, prompt≈6000 tokens, requested=8192, thinkingBudget=4000.
		// clamp budget = max(1, 16000 - 6000 - 4000) = 6000 → max_tokens = min(8192, 6000) = 6000.
		// reconcile: 4000 + OUTPUT_FALLBACK_BUFFER(4000) = 8000 > 6000 → budget = 6000 - 4000 = 2000.
		const model = makeThinkingModel(16_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192, { enabled: true, budgetTokens: 4000 });
		expect(payload.max_tokens).toBe(6000);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 2000 });
		const thinking = payload.thinking as { budget_tokens: number } | undefined;
		expect((payload.max_tokens as number) > (thinking?.budget_tokens ?? 0)).toBe(true);
	});

	it("keeps mandatory thinking enabled with a sub-floor clamped budget", async () => {
		// contextWindow=14596, prompt≈6000 tokens, requested=8192.
		// clamp: min(8192, max(1, 14596 - 6000 - 4000)) = 4596.
		// Mandatory thinking retains the positive clamped budget: 4596 - 4000 = 596.
		const model = makeThinkingModel(14_596, 8_192, true);
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(24_000), timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192);
		expect(payload.max_tokens).toBe(4596);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 596 });
	});

	it("preserves thinking for requiresEffort models with a sub-floor clamped budget", async () => {
		// Same window as the compat.requiresThinkingEnabled case, but reasoning is
		// mandatory via thinking.requiresEffort. A sub-floor budget (< MIN) is
		// retained instead of disabling thinking, since the endpoint rejects
		// omitted reasoning. clamp to 4596; budget = 4596 - 4000 = 596.
		const model = makeThinkingModel(14_596, 8_192, false, false, true);
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(24_000), timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192, { enabled: true, budgetTokens: 4000 });
		expect(payload.max_tokens).toBe(4596);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 596 });
	});

	it("disables thinking when the window is too tight for a viable budget", async () => {
		// contextWindow=10000, prompt≈6000 tokens, requested=8192, thinkingBudget=4000.
		// clamp budget = max(1, 10000 - 6000 - 4000) = 1 → max_tokens = 1.
		// reconcile: clampedBudget = 1 - 4000 < 1024 (MIN) → thinking disabled.
		const model = makeThinkingModel(10_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192, { enabled: true, budgetTokens: 4000 });
		expect(payload.max_tokens).toBe(1);
		expect(payload.thinking).toBeUndefined();
	});

	it("restores supported sampling parameters after a tight clamp disables optional thinking", async () => {
		const model = makeThinkingModel(10_000, 8_192, false, true);
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(24_000), timestamp: Date.now() }],
		};
		const payload = await capturePayload(
			model,
			context,
			8192,
			{ enabled: true, budgetTokens: 4000 },
			{ temperature: 0.7, topP: 0.9, topK: 42 },
		);
		expect(payload).toMatchObject({
			max_tokens: 1,
			temperature: 0.7,
			top_p: 0.9,
			top_k: 42,
		});
		expect(payload.thinking).toBeUndefined();
	});
});

// ─── Bedrock request-building integration ────────────────────────────────────

function makeBedrockModel(
	contextWindow: number,
	maxTokens: number,
	requiresEffort = false,
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Bedrock)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		...(requiresEffort && {
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High], requiresEffort: true },
		}),
	});
}

function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: { maxTokens?: number; reasoning?: "medium"; interleavedThinking?: boolean; toolChoice?: "auto" | "none" },
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	// The stream is only observed for its onPayload snapshot and then abandoned.
	// A bearer token keeps the abandoned continuation off the AWS-credentials
	// path (see bedrock-prompt-cache.test.ts for the unhandled-rejection trap).
	void streamBedrock(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		...options,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("bedrock output-budget clamp integration", () => {
	it("keeps a viable thinking budget with Bedrock's output reserve", async () => {
		// contextWindow=14096, prompt≈6000 tokens, requested=8192, effort medium (budget 8192).
		// clamp: min(8192, max(1, 14096 - 6000 - 4000)) = 4096.
		// Bedrock reserves 1024 output tokens, so budget becomes 4096 - 1024 = 3072.
		// Anthropic's 4000-token buffer would instead drop thinking entirely.
		const model = makeBedrockModel(14_096, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await captureBedrockPayload(model, context, { maxTokens: 8192, reasoning: "medium" });
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 4096 });
		expect(payload.additionalModelRequestFields).toMatchObject({
			thinking: { type: "enabled", budget_tokens: 3072 },
		});
	});

	it("drops thinking and the interleaved beta when the window is too tight", async () => {
		// contextWindow=10000, prompt≈6000 tokens → clamp to 1.
		// reconcile: 1 - 1024 < 1024 → thinking dropped; the interleaved beta must
		// not survive without it, leaving no additional fields at all.
		const model = makeBedrockModel(10_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await captureBedrockPayload(model, context, {
			maxTokens: 8192,
			reasoning: "medium",
			interleavedThinking: true,
		});
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 1 });
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("retains thinking for mandatory-reasoning Bedrock models with a sub-floor budget", async () => {
		// contextWindow=11500, prompt≈6000 → clamp budget = max(1, 11500-6000-4000)=1500.
		// reconcile: clampedBudget = 1500 - 1024 = 476 (< MIN_BEDROCK 1024). A
		// mandatory (requiresEffort) model keeps the largest valid split (476)
		// instead of dropping thinking, which those endpoints would reject.
		const model = makeBedrockModel(11_500, 8_192, true);
		const context: Context = {
			messages: [{ role: "user", content: "x".repeat(24_000), timestamp: Date.now() }],
		};
		const payload = await captureBedrockPayload(model, context, { maxTokens: 8192, reasoning: "medium" });
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 1500 });
		expect(payload.additionalModelRequestFields).toMatchObject({
			thinking: { type: "enabled", budget_tokens: 476 },
		});
	});

	it("excludes unsent tools from the prompt estimate (toolChoice none, no tool history)", async () => {
		// toolChoice "none" with no tool-use history → planToolConfig returns no
		// toolConfig, so the large tool schema is NOT serialized for the estimate.
		// contextWindow=10000, prompt "hi" (~1 token), requested 8192:
		// budget = max(1, 10000 - 1 - 4000) = 5999 → maxTokens 5999.
		// (Counting the 30KB schema would clamp maxTokens to 1.)
		const model = makeBedrockModel(10_000, 8_192);
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [
				{
					name: "big_tool",
					description: "x".repeat(30_000),
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		};
		const payload = await captureBedrockPayload(model, context, { maxTokens: 8192, toolChoice: "none" });
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 5999 });
		expect(payload.toolConfig).toBeUndefined();
	});
});
