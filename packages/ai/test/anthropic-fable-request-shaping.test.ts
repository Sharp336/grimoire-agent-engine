import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeMiniMaxAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

/** Adaptive-thinking model (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5). */
function adaptiveModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

/** Budget-thinking Anthropic model; neutral adaptive mode should not opt it into thinking. */
function budgetModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

/** Real catalog entry — carries shipped `thinking` capability metadata. */
function bundledAnthropicModel(id: string): Model<"anthropic-messages"> {
	const model = getBundledModel<"anthropic-messages">("anthropic", id);
	// The signature is non-nullable but the lookup is a map miss away from undefined.
	if (!model) throw new Error(`missing bundled model ${id}`);
	return model;
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: { type: string; display?: string };
	model?: string;
	tool_choice?: { type: string };
	output_config?: { effort?: string };
};

function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
		...opts,
	});
	return promise;
}

function captureSimplePayload(model: Model<"anthropic-messages">, opts: SimpleStreamOptions): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamSimple(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
		...opts,
	});
	return promise;
}

describe("Anthropic Fable/Mythos forced tool_choice", () => {
	it("downgrades a forced tool to auto for Fable (which rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("downgrades tool_choice:'any' to auto for Mythos", async () => {
		const payload = await capturePayload(adaptiveModel("claude-mythos-5"), {
			toolChoice: "any",
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("preserves a forced tool_choice for non-Fable models (Opus 4.8 supports it)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-4-8"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("tool");
	});
});

describe("Anthropic adaptive-only thinking disable", () => {
	it("never sends thinking.type:'disabled' to an adaptive-only model, pins lowest effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config?.effort).toBe("low");
	});

	it("sends thinking.type:'disabled' without output_config effort for budget-based models", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-3-7-sonnet-20250219"), {
			thinkingEnabled: false,
			reasoning: Effort.High,
		});
		expect(payload.thinking?.type).toBe("disabled");
		expect(payload.output_config?.effort).toBeUndefined();
	});
});

describe("Anthropic adaptive thinking mode", () => {
	it("preserves adaptive thinking mode without fabricating an effort", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-4-8"), {
			anthropicThinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("preserves neutral off mode with caller effort on off-capable Opus 5", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-5"), {
			thinkingMode: "off",
			reasoning: Effort.High,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it("maps neutral adaptive mode without fabricating an effort", async () => {
		const payload = await captureSimplePayload(adaptiveModel("claude-opus-4-8"), {
			thinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("ignores neutral adaptive mode on budget Anthropic models", async () => {
		const payload = await captureSimplePayload(budgetModel("claude-3-7-sonnet-20250219"), {
			thinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	// These run against real bundled catalog IDs so the request-shaping tests
	// cover the metadata shipped to users, not only synthetic model specs.
	it("clamps disabled thinking to the documented ceiling on bundled Opus 5", async () => {
		const model = bundledAnthropicModel("claude-opus-5");
		// Opus 5 returns 400 for `thinking:{type:"disabled"}` above `high`.
		for (const effort of [Effort.Max, Effort.XHigh] as const) {
			const payload = await captureSimplePayload(model, { thinkingMode: "off", reasoning: effort });
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config?.effort).toBe("high");
		}

		// Below the ceiling the caller's effort must survive untouched.
		const medium = await captureSimplePayload(model, { thinkingMode: "off", reasoning: Effort.Medium });
		expect(medium.output_config?.effort).toBe("medium");
	});

	it("routes thinking-off requests to the off SKU while preserving effort", async () => {
		const routed = buildModel({
			...makeAnthropicModel("claude-routed"),
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				effortRouting: {
					off: "claude-routed",
					[Effort.High]: "claude-routed-thinking",
				},
				supportsDisabledThinking: true,
			},
		} as ModelSpec<"anthropic-messages">);

		for (const opts of [{ thinkingMode: "off" as const }, { disableReasoning: true }] as const) {
			const payload = await captureSimplePayload(routed, { ...opts, reasoning: Effort.High });

			expect(payload.model).toBe("claude-routed");
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config?.effort).toBe("high");
		}
	});

	it("preserves disabled thinking on forced-tool turns for bundled Opus 5 and Sonnet 5", async () => {
		const opus = await captureSimplePayload(bundledAnthropicModel("claude-opus-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
			toolChoice: "any",
		});
		expect(opus.thinking).toEqual({ type: "disabled" });
		expect(opus.output_config?.effort).toBe("high");

		const sonnet = await captureSimplePayload(bundledAnthropicModel("claude-sonnet-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
			toolChoice: "any",
		});
		expect(sonnet.thinking).toEqual({ type: "disabled" });
		expect(sonnet.output_config?.effort).toBe("max");
	});

	it("turns thinking off at max effort on bundled Sonnet 5, which has no ceiling", async () => {
		const payload = await captureSimplePayload(bundledAnthropicModel("claude-sonnet-5"), {
			thinkingMode: "off",
			reasoning: Effort.Max,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe("max");
	});

	it("direct provider options preserve adaptive thinking mode without effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-4-8"), {
			anthropicThinkingMode: "adaptive",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
});

describe("MiniMax Anthropic adaptive thinking", () => {
	it("serializes MiniMax adaptive reasoning without Anthropic output_config effort", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			reasoning: Effort.High,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("maps direct MiniMax effort options to the adaptive tag only", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			effort: "low",
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("serializes MiniMax M3 thinking-off requests without the Claude effort pin", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			thinkingEnabled: false,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
	it("maps every MiniMax M2 reasoning tier to the documented adaptive tag", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M2.7"), {
			reasoning: Effort.Low,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
});
