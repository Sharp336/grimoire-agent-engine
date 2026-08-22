/**
 * Friendli serves GLM-5.2 reasoning via the same `chat_template_kwargs.enable_thinking`
 * toggle NVIDIA NIM Qwen uses (so `buildOpenAICompat` resolves it to
 * `thinkingFormat: "qwen-chat-template"`, `reasoningDisableMode: "qwen-template-false"`).
 * Unlike NIM, Friendli additionally accepts top-level `reasoning_effort` for the
 * `high`/`max` ladder `getModelDefinedEfforts` exposes. The
 * `supportsReasoningEffort` flag tells `applyChatCompletionsCompatPolicy`
 * to emit `reasoning_effort` ALONGSIDE the template kwarg. Without it, the
 * `qwen-template-false` branch would write only `chat_template_kwargs.enable_thinking`
 * and collapse `high` vs `max` effort tiers to identical wire bodies — silently
 * dropping the user's selected effort. NIM's strict `additionalProperties: false`
 * schema 400s on top-level `reasoning_effort`, so `supportsReasoningEffort` is
 * false for NIM (and `omitReasoningEffort` is true).
 *
 * The template/effort tests target `applyChatCompletionsReasoningParams`
 * directly so they don't depend on the native text-wrapping addon the
 * streaming path pulls in. The payload-level extraBody test instead uses
 * `streamOpenAICompletions` with a `fetch` mock to verify the FULL request
 * serialization path (`buildParams` → `applyOpenAIExtraBody`).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyChatCompletionsReasoningParams,
	applyOpenAIExtraBody,
	type OpenAICompletionsParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function friendliModel(reasoning: boolean): Model<"openai-completions"> {
	return buildModel({
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 8_192,
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	} satisfies ModelSpec<"openai-completions">);
}

function apply(model: Model<"openai-completions">, reasoning: "high" | "max"): OpenAICompletionsParams {
	const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
	applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning });
	return params;
}

describe("Friendli GLM-5.2 template + reasoning_effort wire shape", () => {
	it("emits chat_template_kwargs.enable_thinking AND reasoning_effort (high)", () => {
		const params = apply(friendliModel(true), "high");
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params.reasoning_effort).toBe("high");
	});

	it("emits chat_template_kwargs.enable_thinking AND reasoning_effort (max) — distinct from high", () => {
		// Contract: distinct effort tiers MUST produce distinct wire bodies.
		// Collapsing to the same body is exactly the regression the
		// `supportsReasoningEffort` flag prevents.
		const high = apply(friendliModel(true), "high");
		const max = apply(friendliModel(true), "max");
		expect(max.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(max.reasoning_effort).toBe("max");
		expect(high.reasoning_effort).toBe("high");
		expect(high.reasoning_effort).not.toBe(max.reasoning_effort);
	});

	it("explicitly disables thinking when no effort is requested and drops reasoning_effort", () => {
		// Friendli's default is thinking-off; with no `reasoning` requested the
		// qwen-template-false dialect auto-disables via the kwarg. The Friendli
		// effort passthrough stays out of the disabled path.
		const model = friendliModel(true);
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, undefined);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("does NOT emit reasoning_effort for the other qwen-chat-template host (NVIDIA NIM)", () => {
		// NIM's strict request schema 400s on top-level `reasoning_effort`. The
		// opt-in must not bleed there. Use a Qwen NIM model so the dialect
		// genuinely resolves to `qwen-chat-template`.
		const model = buildModel({
			id: "qwen/qwen3.5-397b-a17b",
			name: "Qwen3.5-397B-A17B",
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
		expect(model.compat.thinkingFormat).toBe("qwen-chat-template");
		expect(model.compat.supportsReasoningEffort).toBe(false);

		const params = apply(model, "high");
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("still emits enable_thinking when a compat override suppresses reasoning_effort", () => {
		// Regression contract: a Friendli GLM-5.2 model with an explicit
		// `compat.supportsReasoningEffort: false` override suppresses the
		// top-level `reasoning_effort` field, but the model is identity-known
		// to carry an effort surface — `qwen-template-false` must survive so
		// the enabled request path emits `chat_template_kwargs.enable_thinking`
		// and the user can still turn thinking on. If the disable mode
		// collapsed to "omit" instead, the default branch would emit NEITHER
		// `reasoning_effort` (suppressed) NOR `enable_thinking` (omitted),
		// making it impossible to enable reasoning through the selector.
		const spec: ModelSpec<"openai-completions"> = {
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
			compat: { supportsReasoningEffort: false } as never,
		};
		const model = buildModel(spec);
		expect(model.compat.supportsReasoningEffort).toBe(false);
		expect(model.compat.omitReasoningEffort).toBe(true);
		expect(model.compat.reasoningDisableMode).toBe("qwen-template-false");

		const params = apply(model, "high");
		// The template toggle survives the override — thinking CAN be enabled.
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		// The top-level field is suppressed by the override.
		expect(params.reasoning_effort).toBeUndefined();
	});
});

describe("Friendli extraBody conditional merge", () => {
	// The catalog sets `extraBody: { parse_reasoning: true, include_reasoning: true }`
	// for Friendli reasoning models. `applyOpenAIExtraBody` strips those
	// reasoning-specific keys when thinking is disabled — they are no-ops on
	// the disabled path and clutter the wire body. But `extraBody` is an
	// arbitrary record: it commonly carries gateway routing hints and
	// controller fields unrelated to reasoning (see the `extraBody` docstring
	// on `OpenAICompat`). Skipping the entire merge would drop those
	// provider-required fields, so only the known reasoning-only keys are
	// removed; the rest flows through unchanged.

	it("merges extraBody when reasoning is not disabled", () => {
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { parse_reasoning: true, include_reasoning: true }, { reasoningDisabled: false });
		expect(params.parse_reasoning).toBe(true);
		expect(params.include_reasoning).toBe(true);
	});

	it("strips reasoning keys when reasoning is disabled", () => {
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { parse_reasoning: true, include_reasoning: true }, { reasoningDisabled: true });
		expect(params.parse_reasoning).toBeUndefined();
		expect(params.include_reasoning).toBeUndefined();
	});

	it("preserves non-reasoning extraBody fields when reasoning is disabled", () => {
		// A custom OpenAI-compatible model with a `compat.extraBody` that
		// carries gateway routing fields alongside reasoning fields. When
		// reasoning is disabled (explicit `disableReasoning` or implicit
		// not-requested for Qwen-style formats), the routing fields MUST
		// survive — losing them would route the request to the wrong backend.
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(
			params,
			{
				thinking: { type: "enabled" },
				parse_reasoning: true,
				include_reasoning: true,
				gateway: "us-east-1",
				controller: "v2",
			},
			{ reasoningDisabled: true },
		);
		expect(params.gateway).toBe("us-east-1");
		expect(params.controller).toBe("v2");
		expect(params.thinking).toBeUndefined();
		expect(params.parse_reasoning).toBeUndefined();
		expect(params.include_reasoning).toBeUndefined();
	});

	it("merges extraBody by default (no reasoningDisabled flag)", () => {
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { thinking: { type: "enabled" } });
		expect(params.thinking).toEqual({ type: "enabled" });
	});
});

const sseContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureBody(
	model: Model<"openai-completions">,
	reasoning: Effort | undefined,
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamOpenAICompletions(model, sseContext, {
		apiKey: "k",
		fetch: fetchMock,
		reasoning,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured chat-completions request");
	return body;
}

describe("Friendli extraBody serializes conditionally in the wire payload", () => {
	afterEach(() => vi.restoreAllMocks());

	it("strips parse_reasoning/include_reasoning in the serialized body when reasoning is disabled", async () => {
		// A custom OpenAI-compatible model pointing at Friendli with a
		// `compat.extraBody` that carries gateway routing fields alongside
		// the reasoning-specific keys. This verifies the FULL request path
		// — `buildParams` → `applyChatCompletionsCompatPolicy` →
		// `applyOpenAIExtraBody` — not just the helper. When reasoning is
		// disabled, the reasoning-specific keys MUST be absent from the
		// serialized JSON body while the gateway routing field survives.
		const spec: ModelSpec<"openai-completions"> = {
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
			compat: { extraBody: { parse_reasoning: true, include_reasoning: true, gateway: "us-east-1" } as never },
		};
		const model = buildModel(spec) as Model<"openai-completions">;

		const body = await captureBody(model, undefined);
		expect(body.parse_reasoning).toBeUndefined();
		expect(body.include_reasoning).toBeUndefined();
		// The gateway routing field survives the disable path — the entire
		// extraBody is NOT skipped, only the reasoning-specific keys.
		expect(body.gateway).toBe("us-east-1");
	});

	it("emits enable_thinking:false in the serialized body for an explicit disable on a toggle-only Friendli model", async () => {
		// A Friendli toggle-only reasoning model (e.g. GLM-4.5 with only a
		// `type: "toggle"` in reasoning_options) gets a single-tier binary
		// thinking config and `qwen-template-false` disable mode. When the
		// caller explicitly disables reasoning (`disableReasoning: true`),
		// the serialized body MUST emit `chat_template_kwargs.enable_thinking:
		// false` — without it, the model stays thinking at the server default
		// and callers can never turn it off.
		const spec: ModelSpec<"openai-completions"> = {
			id: "zai-org/GLM-4.5",
			name: "GLM-4.5",
			api: "openai-completions",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
		};
		const model = buildModel(spec) as Model<"openai-completions">;
		expect(model.compat.reasoningDisableMode).toBe("qwen-template-false");

		const body = await captureBody(model, undefined);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("emits enable_thinking:true and omits reasoning_effort in the serialized body when a toggle-only Friendli model is explicitly enabled", async () => {
		// Companion to the disable test above: the actual P1 regression this
		// discriminator fixes was that toggle-only models COULD be disabled
		// (via the fix above) but could no longer be ENABLED — the model's
		// `thinking` was left undefined so `getSupportedEfforts` returned an
		// empty array and callers had no on-state to select. This exercises
		// the full request path with an explicit `reasoning: "high"` request
		// on a toggle-only model (no `thinking.efforts` from discovery, no
		// static seed — GLM-4.5 is not the GLM-5.2 identity match) and
		// asserts the wire carries the template toggle WITHOUT the top-level
		// `reasoning_effort` field the endpoint rejects for toggle-only SKUs.
		const spec: ModelSpec<"openai-completions"> = {
			id: "zai-org/GLM-4.5",
			name: "GLM-4.5",
			api: "openai-completions",
			provider: "friendli",
			baseUrl: "https://api.friendli.ai/serverless/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
		};
		const model = buildModel(spec) as Model<"openai-completions">;
		// The toggle IS observable: getSupportedEfforts must return a
		// non-empty on-state, or the picker has nothing to select.
		expect(model.thinking?.efforts.length).toBeGreaterThan(0);
		expect(model.compat.supportsReasoningEffort).toBe(false);

		const body = await captureBody(model, Effort.High);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(body.reasoning_effort).toBeUndefined();
	});
});
