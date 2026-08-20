import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { applyDeepSeekV4TimeWindowCost } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";

const flashModel = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
const proModel = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
const proxyProModel = {
	...proModel,
	baseUrl: "https://proxy.example/v1",
} satisfies Model<"openai-completions">;
const unknownDirectModel = {
	...proModel,
	id: "deepseek-v5",
} satisfies Model<"openai-completions">;
const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function millionTokenUsage(): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 0,
		totalTokens: 3_000_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function expectCost(usage: Usage, expected: Omit<Usage["cost"], "total">): void {
	expect(usage.cost.input).toBeCloseTo(expected.input, 10);
	expect(usage.cost.output).toBeCloseTo(expected.output, 10);
	expect(usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 10);
	expect(usage.cost.cacheWrite).toBeCloseTo(expected.cacheWrite, 10);
	expect(usage.cost.total).toBeCloseTo(
		expected.input + expected.output + expected.cacheRead + expected.cacheWrite,
		10,
	);
}

async function streamWithUsage(model: Model<"openai-completions">): Promise<Usage> {
	const fetch: FetchImpl = async () => {
		const chunk = {
			id: "chatcmpl-pricing",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 2_000_000,
				completion_tokens: 1_000_000,
				total_tokens: 3_000_000,
				prompt_cache_hit_tokens: 1_000_000,
				prompt_cache_miss_tokens: 1_000_000,
			},
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch }).result();
	expect(result.stopReason).toBe("stop");
	return result.usage;
}

describe("DeepSeek V4 time-window pricing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["2026-08-20T00:59:59.999Z", false],
		["2026-08-20T01:00:00.000Z", true],
		["2026-08-20T03:59:59.999Z", true],
		["2026-08-20T04:00:00.000Z", false],
		["2026-08-20T05:59:59.999Z", false],
		["2026-08-20T06:00:00.000Z", true],
		["2026-08-20T09:59:59.999Z", true],
		["2026-08-20T10:00:00.000Z", false],
	] as const)("uses the documented UTC window at %s", (timestamp, peak) => {
		const usage = millionTokenUsage();
		expect(applyDeepSeekV4TimeWindowCost(flashModel, flashModel.baseUrl, usage, Date.parse(timestamp))).toBe(true);
		const multiplier = peak ? 1 : 0.5;
		expectCost(usage, {
			input: 0.44 * multiplier,
			output: 1.32 * multiplier,
			cacheRead: 0.014 * multiplier,
			cacheWrite: 0,
		});
	});

	it("uses Pro rates and includes orchestration and cache-write tokens", () => {
		const usage = millionTokenUsage();
		usage.input = 900_000;
		usage.output = 800_000;
		usage.cacheRead = 750_000;
		usage.cacheWrite = 1_000_000;
		usage.orchestration = { input: 100_000, output: 200_000, cacheRead: 250_000 };

		expect(
			applyDeepSeekV4TimeWindowCost(proModel, proModel.baseUrl, usage, Date.parse("2026-08-20T01:00:00.000Z")),
		).toBe(true);
		expectCost(usage, { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 });
	});

	it("leaves unknown first-party models on catalog cost", () => {
		const usage = millionTokenUsage();
		calculateCost(unknownDirectModel, usage);
		const catalogCost = { ...usage.cost };

		expect(
			applyDeepSeekV4TimeWindowCost(
				unknownDirectModel,
				unknownDirectModel.baseUrl,
				usage,
				Date.parse("2026-08-20T00:00:00.000Z"),
			),
		).toBe(false);
		expect(usage.cost).toEqual(catalogCost);
	});

	it("applies the request-start window in the direct stream and leaves proxies on catalog cost", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-20T00:00:00.000Z"));

		const directUsage = await streamWithUsage(proModel);
		expectCost(directUsage, { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 });

		const proxyUsage = await streamWithUsage(proxyProModel);
		const catalogUsage = millionTokenUsage();
		calculateCost(proxyProModel, catalogUsage);
		expect(proxyUsage.cost).toEqual(catalogUsage.cost);
	});
});
