import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ZAI_CODING_PLAN_STATIC_MODELS,
	ZHIPU_CODING_PLAN_STATIC_MODELS,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function captureSimplePayload<TApi extends Api>(
	model: Model<TApi>,
	options: Pick<SimpleStreamOptions, "disableReasoning" | "reasoning">,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamSimple(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		...options,
		onPayload: payload => resolve(payload),
	});
	const payload = await promise;
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Expected captured request payload");
	}
	return payload as Record<string, unknown>;
}

const zaiSpec = ZAI_CODING_PLAN_STATIC_MODELS.find(model => model.id === "glm-5.3");
const zhipuSpec = ZHIPU_CODING_PLAN_STATIC_MODELS.find(model => model.id === "glm-5.3");
if (!zaiSpec || !zhipuSpec) {
	throw new Error("GLM-5.3 Coding Plan seeds are required for wire-contract tests");
}
const zaiGlm53 = buildModel(zaiSpec);
const zhipuGlm53 = buildModel(zhipuSpec);

describe("GLM-5.3 official Coding Plan wire mapping", () => {
	it("floors thinking-off to low on the Z.AI Anthropic endpoint", async () => {
		const payload = await captureSimplePayload(zaiGlm53, { disableReasoning: true });

		expect(payload).toMatchObject({
			thinking: { type: "enabled" },
			output_config: { effort: "low" },
		});
	});

	it("floors thinking-off to low on the Zhipu OpenAI endpoint", async () => {
		const payload = await captureSimplePayload(zhipuGlm53, { disableReasoning: true });

		expect(payload).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "low",
		});
	});
});
