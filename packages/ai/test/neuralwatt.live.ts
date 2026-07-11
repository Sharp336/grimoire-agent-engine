/**
 * Live Neuralwatt smoke. NOT part of the bun test suite — run manually:
 *   NEURALWATT_API_KEY=nw_... bun packages/ai/test/neuralwatt.live.ts
 *
 * Validates:
 *   1. The bundled `neuralwatt/glm-5.2` entry emits documented OpenAI-style
 *      reasoning request fields (`reasoning_effort`, `tool_stream`,
 *      `max_tokens`) and does NOT emit the undocumented top-level Z.ai
 *      `thinking` object.
 *   2. The lower OpenAI effort tier (`low`) is accepted by Neuralwatt.
 *   3. `disableReasoning: true` maps to the `minimal` effort fallback.
 *   4. The bundled `neuralwatt/kimi-k2.6` entry omits both `thinking` and
 *      `reasoning_effort` (metadata says effort is unsupported) and still
 *      completes successfully.
 *
 * The script NEVER prints the API key. It captures each outbound JSON body
 * before the network call, drains the real SSE stream, and fails on any stream
 * error or non-success response.
 */

import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const apiKey = Bun.env.NEURALWATT_API_KEY;
if (!apiKey) {
	console.error("NEURALWATT_API_KEY env var is required");
	process.exit(2);
}

const glmModel = getBundledModel<"openai-completions">("neuralwatt", "glm-5.2");
const kimiModel = getBundledModel<"openai-completions">("neuralwatt", "kimi-k2.6");
console.log(`GLM model: ${glmModel.provider}/${glmModel.id} -> ${glmModel.baseUrl}`);
console.log(`Kimi model: ${kimiModel.provider}/${kimiModel.id} -> ${kimiModel.baseUrl}`);

interface CapturedRequest {
	url: string;
	body: string | null;
}

const originalFetch = fetch;
const captured: { value: CapturedRequest | null } = { value: null };
type FetchInput = string | URL | Request;

const fetchImpl: FetchImpl = Object.assign(
	async (input: FetchInput, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		captured.value = { url, body: typeof init?.body === "string" ? init.body : null };
		return originalFetch(input, init);
	},
	{ preconnect: fetch.preconnect },
);

const harmlessTool: Tool = {
	name: "get_time",
	description: "Returns the current time.",
	parameters: { type: "object", properties: {} },
};

const context: Context = {
	systemPrompt: ["Reply concisely."],
	messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
};

interface ProbeResult {
	parsedBody: Record<string, unknown> | null;
	stopReason: string | undefined;
	firstError: unknown;
}

async function runProbe(
	label: string,
	model: Model<"openai-completions">,
	options: {
		reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
		disableReasoning?: boolean;
		maxTokens?: number;
		tools?: Tool[];
	},
): Promise<ProbeResult> {
	console.log(`\n=== ${label} ===`);
	captured.value = null;
	const probeContext = options.tools ? { ...context, tools: options.tools } : context;
	const stream = streamOpenAICompletions(model, probeContext, {
		apiKey,
		fetch: fetchImpl,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
		maxTokens: options.maxTokens,
	});
	let text = "";
	let stopReason: string | undefined;
	let firstError: unknown;
	for await (const ev of stream) {
		if (ev.type === "text_delta") text += ev.delta;
		else if (ev.type === "done") {
			stopReason = ev.reason;
		} else if (ev.type === "error") {
			firstError = ev.error.errorMessage ?? ev.error;
			stopReason = ev.reason;
		}
	}

	const snapshot = (captured as { value: CapturedRequest | null }).value;
	const parsedBody = snapshot?.body ? (JSON.parse(snapshot.body) as Record<string, unknown>) : null;
	console.log("wire url:", snapshot?.url);
	console.log("wire model:", parsedBody?.model);
	console.log("wire reasoning_effort:", parsedBody?.reasoning_effort ?? "(omitted)");
	console.log("wire tool_stream:", parsedBody?.tool_stream ?? "(omitted)");
	console.log("wire max_tokens:", parsedBody?.max_tokens ?? "(omitted)");
	console.log("wire thinking:", parsedBody?.thinking ?? "(omitted)");
	console.log("text:", JSON.stringify(text.slice(0, 80)));
	console.log("stopReason:", stopReason);
	if (firstError) console.log("error:", firstError);

	return { parsedBody, stopReason, firstError };
}

function fail(message: string): never {
	console.error(`\n${message}`);
	process.exit(1);
}

// --- Probe 1: GLM-5.2 high with tool and full cap ---
const glmHigh = await runProbe("GLM-5.2 high effort + tool + maxTokens 131072", glmModel, {
	reasoning: "high",
	maxTokens: 131_072,
	tools: [harmlessTool],
});
if (glmHigh.firstError) fail("GLM high probe failed — stream/API error");
if (glmHigh.parsedBody?.reasoning_effort !== "high") {
	fail(`GLM high: reasoning_effort expected "high", got ${glmHigh.parsedBody?.reasoning_effort}`);
}
if (glmHigh.parsedBody?.tool_stream !== true) {
	fail(`GLM high: tool_stream expected true, got ${glmHigh.parsedBody?.tool_stream}`);
}
if (glmHigh.parsedBody?.max_tokens !== 131_072) {
	fail(`GLM high: max_tokens expected 131072, got ${glmHigh.parsedBody?.max_tokens}`);
}
if (glmHigh.parsedBody?.thinking !== undefined) {
	fail(`GLM high: top-level thinking must be absent, got ${JSON.stringify(glmHigh.parsedBody?.thinking)}`);
}

// --- Probe 2: GLM-5.2 low with small cap ---
const glmLow = await runProbe("GLM-5.2 low effort + small cap", glmModel, {
	reasoning: "low",
	maxTokens: 64,
});
if (glmLow.firstError) fail("GLM low probe failed — stream/API error");
if (glmLow.parsedBody?.reasoning_effort !== "low") {
	fail(`GLM low: reasoning_effort expected "low", got ${glmLow.parsedBody?.reasoning_effort}`);
}
if (glmLow.parsedBody?.thinking !== undefined) {
	fail(`GLM low: top-level thinking must be absent, got ${JSON.stringify(glmLow.parsedBody?.thinking)}`);
}

// --- Probe 3: GLM-5.2 disabled with small cap ---
const glmDisabled = await runProbe("GLM-5.2 disabled reasoning + small cap", glmModel, {
	disableReasoning: true,
	maxTokens: 64,
});
if (glmDisabled.firstError) fail("GLM disabled probe failed — stream/API error");
if (glmDisabled.parsedBody?.reasoning_effort !== "minimal") {
	fail(`GLM disabled: reasoning_effort expected "minimal", got ${glmDisabled.parsedBody?.reasoning_effort}`);
}
if (glmDisabled.parsedBody?.thinking !== undefined) {
	fail(`GLM disabled: top-level thinking must be absent, got ${JSON.stringify(glmDisabled.parsedBody?.thinking)}`);
}

// --- Probe 4: Kimi-K2.6 high with small cap ---
const kimiHigh = await runProbe("Kimi-K2.6 high effort + small cap", kimiModel, {
	reasoning: "high",
	maxTokens: 64,
});
if (kimiHigh.firstError) fail("Kimi high probe failed — stream/API error");
if (kimiHigh.parsedBody?.thinking !== undefined) {
	fail(`Kimi high: top-level thinking must be absent, got ${JSON.stringify(kimiHigh.parsedBody?.thinking)}`);
}
if (kimiHigh.parsedBody?.reasoning_effort !== undefined) {
	fail(`Kimi high: reasoning_effort must be absent, got ${kimiHigh.parsedBody?.reasoning_effort}`);
}

// --- Probe 5: Kimi-K2.6 unsupported reasoning controls omitted (effort omitted) + small cap ---
const kimiDisabled = await runProbe("Kimi-K2.6 effort omitted + small cap", kimiModel, {
	disableReasoning: true,
	maxTokens: 64,
});
if (kimiDisabled.firstError) fail("Kimi effort-omitted probe failed — stream/API error");
if (kimiDisabled.parsedBody?.thinking !== undefined) {
	fail(
		`Kimi effort-omitted: top-level thinking must be absent, got ${JSON.stringify(kimiDisabled.parsedBody?.thinking)}`,
	);
}
if (kimiDisabled.parsedBody?.reasoning_effort !== undefined) {
	fail(`Kimi effort-omitted: reasoning_effort must be absent, got ${kimiDisabled.parsedBody?.reasoning_effort}`);
}

console.log(
	"\nLIVE OK — Neuralwatt accepted OpenAI-style reasoning requests for GLM-5.2 (high/low/minimal) " +
		"and Kimi-K2.6 high/effort-omitted, with no top-level thinking object on any probe. " +
		"All five probes passed.",
);
