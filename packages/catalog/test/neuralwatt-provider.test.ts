import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
	neuralwattModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Neuralwatt provider discovery", () => {
	test("registers runtime descriptor with unauthenticated public-endpoint discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "neuralwatt");
		expect(descriptor).toBeDefined();
		// /v1/models is public, so the runtime must construct a manager without an
		// API key: the entry-level flag is the only source for the resolved
		// descriptor (a catalogDiscovery-only flag never reaches it).
		expect(descriptor?.allowUnauthenticated).toBe(true);
		expect(descriptor?.catalogDiscovery?.forceUnauthenticated).toBe(true);
		expect(descriptor?.catalogDiscovery?.label).toBe("Neuralwatt");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("NEURALWATT_API_KEY");
	});

	test("discovers Neuralwatt models from the metadata envelope", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "kimi-k2.7-code",
							object: "model",
							created: 0,
							owned_by: "neuralwatt",
							max_model_len: 262128,
							metadata: {
								display_name: "Kimi K2.7 Code",
								pricing: {
									input_per_million: 0.95,
									output_per_million: 4,
									cached_input_per_million: 0.16,
									currency: "USD",
								},
								capabilities: {
									tools: true,
									vision: true,
									reasoning: true,
									reasoning_effort: false,
								},
								limits: {
									max_context_length: 262128,
									max_output_tokens: null,
									max_images: 20,
								},
								deprecated: false,
							},
						},
						{
							id: "glm-5.2-short",
							object: "model",
							created: 0,
							owned_by: "neuralwatt",
							max_model_len: 199984,
							metadata: {
								display_name: "GLM-5.2 (short)",
								pricing: {
									input_per_million: 1.45,
									output_per_million: 6.35,
									currency: "USD",
								},
								capabilities: {
									tools: true,
									vision: false,
									reasoning: true,
									reasoning_effort: true,
								},
								limits: {
									max_context_length: 199984,
									max_output_tokens: 32000,
									max_images: null,
								},
								deprecated: false,
							},
						},
						{
							id: "old-deprecated-model",
							object: "model",
							created: 0,
							owned_by: "neuralwatt",
							max_model_len: 8192,
							metadata: {
								display_name: "Old Model",
								pricing: { input_per_million: 1, output_per_million: 2, currency: "USD" },
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: false },
								limits: { max_context_length: 8192, max_output_tokens: 4096 },
								deprecated: true,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = neuralwattModelManagerOptions({ apiKey: "neuralwatt-test-key", fetch: fetchMock });
		const models = (await options.fetchDynamicModels?.())?.map(spec => buildModel(spec));

		expect(calls).toEqual([
			{
				url: "https://api.neuralwatt.com/v1/models",
				authorization: "Bearer neuralwatt-test-key",
			},
		]);

		// Deprecated entries are dropped.
		expect(models?.some(model => model.id === "old-deprecated-model")).toBe(false);

		const kimi = models?.find(model => model.id === "kimi-k2.7-code");
		expect(kimi).toBeDefined();
		expect(kimi).toMatchObject({
			provider: "neuralwatt",
			api: "openai-completions",
			name: "Kimi K2.7 Code",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262128,
			// `null` max_output_tokens means uncapped upstream; the bundled
			// reference's recommended Kimi K2.7 Code ceiling (32768) wins over a
			// flat low default.
			maxTokens: 32768,
			cost: {
				input: 0.95,
				output: 4,
				cacheRead: 0.16,
				cacheWrite: 0,
			},
		});
		// reasoning_effort: false → the wire omits the param and no inert effort
		// selector is exposed.
		expect(kimi?.compat?.supportsReasoningEffort).toBe(false);
		expect(kimi?.thinking).toBeUndefined();
		// With no effort ladder there is no lowest effort to fall back on, so
		// `disableReasoning` must take the documented chat-template off switch
		// (`chat_template_kwargs.enable_thinking: false`). The effort-ladder
		// `lowest-effort` override is reserved for effort-capable thinking
		// routes and must not leak into this effort-less base compat.
		expect(kimi?.compat?.reasoningDisableMode).toBe("qwen-template-false");
		expect(kimi?.compat?.whenThinking?.reasoningDisableMode).toBeUndefined();

		const glm = models?.find(model => model.id === "glm-5.2-short");
		expect(glm).toBeDefined();
		expect(glm).toMatchObject({
			provider: "neuralwatt",
			api: "openai-completions",
			name: "GLM-5.2 (short)",
			reasoning: true,
			input: ["text"],
			contextWindow: 199984,
			maxTokens: 32000,
			// `cached_input_per_million` absent → falls back to the bundled
			// reference's cache-read price (never mislabeled as 0/Free).
			cost: {
				input: 1.45,
				output: 6.35,
				cacheRead: 0.145,
				cacheWrite: 0,
			},
		});
		// reasoning_effort: true alone (no `metadata.reasoning` block) is
		// authoritative: the mapped compat installs the effort-encoding
		// `lowest-effort` selector under `whenThinking` even without live
		// effort metadata, while the base stays on the documented
		// chat-template off switch (`qwen-template-false`) — never the other
		// way around.
		expect(glm?.thinking).toMatchObject({ mode: "effort" });
		expect(glm?.compat?.supportsReasoningEffort).toBe(true);
		expect(glm?.compat?.reasoningDisableMode).toBe("qwen-template-false");
		expect(glm?.compat?.whenThinking?.reasoningDisableMode).toBe("lowest-effort");
		// The capability-only route still exposes a real effort ladder: with
		// no live `supported_efforts` vocabulary, build-time inference supplies
		// the GLM-5.2 tiers so the requested effort has values to serialize.
		expect(glm?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});

	test("strips a stale reference whenThinking override when the live route rejects effort", async () => {
		// The bundled `glm-5.2-short` reference carries a thinking ladder and a
		// `whenThinking.reasoningDisableMode: "lowest-effort"` override. A live
		// `reasoning_effort: false` declares the wire cannot honor any effort
		// tier: the stale override must be dropped (thinking turns would
		// otherwise serialize an effort the route rejects), the base compat
		// keeps the chat-template off switch, and no ladder survives.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "glm-5.2-short",
							object: "model",
							max_model_len: 199984,
							metadata: {
								display_name: "GLM-5.2 (short)",
								pricing: {
									input_per_million: 1.45,
									output_per_million: 6.35,
									currency: "USD",
								},
								capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: false },
								limits: { max_context_length: 199984, max_output_tokens: 32000 },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		const glm = models?.map(spec => buildModel(spec)).find(model => model.id === "glm-5.2-short");
		expect(glm).toBeDefined();
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking).toBeUndefined();
		expect(glm?.compat?.supportsReasoningEffort).toBe(false);
		expect(glm?.compat?.reasoningDisableMode).toBe("qwen-template-false");
		expect(glm?.compat?.whenThinking).toBeUndefined();
	});

	test("uses the live Neuralwatt effort surface even when reasoning is off by default", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "glm-5.2-fast",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "GLM-5.2 Fast",
								pricing: { input_per_million: 1.45, output_per_million: 4.5 },
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: true },
								reasoning: {
									mandatory: false,
									default_enabled: false,
									supported_efforts: ["max", "high", "none"],
									default_effort: "none",
								},
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							id: "kimi-k3",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "Kimi K3",
								pricing: { input_per_million: 3, output_per_million: 15 },
								capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: true },
								reasoning: {
									mandatory: false,
									default_enabled: true,
									supported_efforts: ["max", "high", "low", "none"],
									default_effort: "max",
								},
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							id: "kimi-k3-fast",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "Kimi K3 Fast",
								pricing: { input_per_million: 0.95, output_per_million: 4 },
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: true },
								reasoning: {
									mandatory: false,
									default_enabled: false,
									supported_efforts: ["none"],
									default_effort: "none",
								},
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const specs = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		const models = specs?.map(spec => buildModel(spec));
		const glm = models?.find(model => model.id === "glm-5.2-fast");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(glm?.thinking?.defaultLevel).toBeUndefined();
		expect(glm?.compat?.reasoningDisableMode).toBe("qwen-template-false");
		expect(glm?.compat?.whenThinking?.reasoningDisableMode).toBe("lowest-effort");

		const kimiReasoning = models?.find(model => model.id === "kimi-k3");
		expect(kimiReasoning?.thinking).toMatchObject({
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: false,
		});

		const kimi = models?.find(model => model.id === "kimi-k3-fast");
		expect(kimi?.reasoning).toBe(false);
		expect(kimi?.thinking).toBeUndefined();
	});

	test("excludes none from UI efforts: default-off GLM fast is reasoning opt-in, none-only Kimi fast stays off", async () => {
		// `none` is a wire value, not a user-selectable thinking level. A
		// default-off GLM fast route whose only real efforts are high/max still
		// exposes an opt-in reasoning dial with `none` filtered out, while a
		// none-only Kimi fast route has no real effort and stays non-reasoning.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "glm-5.2-fast",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "GLM-5.2 Fast",
								pricing: { input_per_million: 1.45, output_per_million: 4.5 },
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: true },
								reasoning: {
									mandatory: false,
									default_enabled: false,
									supported_efforts: ["max", "high", "none"],
									default_effort: "none",
								},
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							id: "kimi-k3-fast",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "Kimi K3 Fast",
								pricing: { input_per_million: 0.95, output_per_million: 4 },
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: true },
								reasoning: {
									mandatory: false,
									default_enabled: false,
									supported_efforts: ["none"],
									default_effort: "none",
								},
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = (
			await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.()
		)?.map(spec => buildModel(spec));

		// reasoning=false default-off, but high/max survive: an opt-in dial.
		const glm = models?.find(model => model.id === "glm-5.2-fast");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);

		// none-only leaves no real effort: no dial, no thinking surface.
		const kimi = models?.find(model => model.id === "kimi-k3-fast");
		expect(kimi?.reasoning).toBe(false);
		expect(kimi?.thinking).toBeUndefined();
	});

	test("leaves uncapped non-Kimi output limits unknown instead of inventing 32K", async () => {
		// glm-5.2 (full) reports max_output_tokens: null. Only the Kimi K2.7 Code
		// family (base and route aliases) has a known 32K recommendation; other
		// families stay null rather than get a fabricated cap that could truncate
		// or overstate.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "glm-5.2",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "GLM-5.2",
								pricing: { input_per_million: 1.45, output_per_million: 4.5, cached_input_per_million: 0.3625 },
								capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: true },
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							id: "kimi-k2.7-code",
							object: "model",
							max_model_len: 262128,
							metadata: {
								display_name: "Kimi K2.7 Code",
								pricing: { input_per_million: 0.95, output_per_million: 4, cached_input_per_million: 0.16 },
								capabilities: { tools: true, vision: true, reasoning: true, reasoning_effort: false },
								limits: { max_context_length: 262128, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							// The route aliases share the base route's recommended 32K
							// output budget: when upstream reports a null (uncapped)
							// limit, each resolves to the same recommendation as
							// `kimi-k2.7-code`.
							id: "kimi-k2.7-code-fast",
							object: "model",
							max_model_len: 262128,
							metadata: {
								display_name: "Kimi K2.7 Code Fast",
								pricing: { input_per_million: 0.95, output_per_million: 4, cached_input_per_million: 0.16 },
								capabilities: { tools: true, vision: true, reasoning: false, reasoning_effort: false },
								limits: { max_context_length: 262128, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							// The flex alias is newly exposed by the refreshed public
							// catalog with the live family shape; discovery still reports
							// max_output_tokens: null, so the family recommendation must
							// apply here too rather than dropping the 32K ceiling.
							id: "kimi-k2.7-code-flex",
							object: "model",
							max_model_len: 262128,
							metadata: {
								display_name: "Kimi K2.7 Code Flex",
								pricing: { input_per_million: 0.95, output_per_million: 4, cached_input_per_million: 0.16 },
								capabilities: { tools: true, vision: true, reasoning: true, reasoning_effort: false },
								limits: { max_context_length: 262128, max_output_tokens: null },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.find(model => model.id === "glm-5.2")?.maxTokens ?? null).toBeNull();
		expect(models?.find(model => model.id === "kimi-k2.7-code")?.maxTokens).toBe(
			KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
		);
		expect(models?.find(model => model.id === "kimi-k2.7-code-fast")?.maxTokens).toBe(
			KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
		);
		expect(models?.find(model => model.id === "kimi-k2.7-code-flex")?.maxTokens).toBe(
			KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
		);
	});

	test("resolves real pricing for discovered models whose metadata omits it", async () => {
		// Discovery metadata can omit pricing for a listed model (here, kimi-k3
		// arrives with no pricing row). The exact-ID Neuralwatt bundled reference
		// must supply it rather than defaulting to Free.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "kimi-k3",
							object: "model",
							max_model_len: 1048560,
							metadata: {
								display_name: "Kimi K3",
								capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: true },
								limits: { max_context_length: 1048560, max_output_tokens: null },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		const k3 = models?.find(model => model.id === "kimi-k3");
		expect(k3).toBeDefined();
		// Non-zero, real pricing (not the zero-cost Free mislabel).
		expect(k3?.cost.input).toBeGreaterThan(0);
		expect(k3?.cost.output).toBeGreaterThan(0);
	});

	test("omits discovered models with incomplete or invalid pricing", async () => {
		// Missing billable rates would undercount usage, while negative rates
		// would make spend decrease. Neither is a valid model contract.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "secret-internal-model-x9",
							object: "model",
							max_model_len: 131072,
							metadata: {
								display_name: "Internal X9",
								pricing: { input_per_million: 0.2 },
								capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: true },
								limits: { max_context_length: 131072, max_output_tokens: null },
								deprecated: false,
							},
						},
						{
							id: "negative-price-model",
							object: "model",
							max_model_len: 131072,
							metadata: {
								display_name: "Negative Price",
								pricing: { input_per_million: -0.2, output_per_million: 1 },
								capabilities: { tools: true, vision: false, reasoning: false },
								limits: { max_context_length: 131072, max_output_tokens: 8192 },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "secret-internal-model-x9")).toBe(false);
		expect(models?.some(model => model.id === "negative-price-model")).toBe(false);
	});

	test("omits discovered models whose only pricing reference is bundled under another provider", async () => {
		// `kimi-k2.5` is bundled under Moonshot (0.6/3 USD per 1M) but not under
		// Neuralwatt. Pricing is provider-specific: with no pricing row and no
		// same-provider exact-ID reference, the model must be dropped rather than
		// borrow Moonshot's rates or default to Free.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "kimi-k2.5",
							object: "model",
							max_model_len: 262144,
							metadata: {
								display_name: "Kimi K2.5",
								capabilities: { tools: true, vision: true, reasoning: true, reasoning_effort: false },
								limits: { max_context_length: 262144, max_output_tokens: null },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "kimi-k2.5")).toBe(false);
	});

	test("omits discovered models flagged pricing_tbd even with a stale provider reference", async () => {
		// Neuralwatt bundles a glm-5.2-short reference with real rates, but a live
		// `pricing_tbd: true` marker invalidates even that cached reference: the
		// model must disappear until the route publishes prices rather than ship
		// stale numbers.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "glm-5.2-short",
							object: "model",
							max_model_len: 199984,
							metadata: {
								display_name: "GLM-5.2 (short)",
								pricing_tbd: true,
								pricing: { currency: "USD" },
								limits: { max_context_length: 199984, max_output_tokens: 32000 },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "glm-5.2-short")).toBe(false);
	});

	test("preserves bundled reference vision and output limit when live metadata omits them", async () => {
		// gemma-4-31b's Neuralwatt reference is vision-enabled with a finite
		// 16384 output cap. When the live listing omits both `vision` and
		// `max_output_tokens`, omission must inherit the reference — an explicit
		// `null` output limit (covered by the uncapped-limit tests) would instead
		// resolve to uncapped, and dropping vision would degrade to text-only.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "gemma-4-31b",
							object: "model",
							max_model_len: 262128,
							metadata: {
								display_name: "Gemma 4 31B",
								pricing: {
									input_per_million: 0.144,
									output_per_million: 0.42,
									cached_input_per_million: 0.0144,
								},
								capabilities: { tools: true, reasoning: false },
								limits: { max_context_length: 262128 },
								deprecated: false,
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const models = await neuralwattModelManagerOptions({ apiKey: "k", fetch: fetchMock }).fetchDynamicModels?.();
		const gemma = models?.find(model => model.id === "gemma-4-31b");
		expect(gemma).toBeDefined();
		expect(gemma?.input).toEqual(["text", "image"]);
		expect(gemma?.maxTokens).toBe(16384);
	});

	test("keeps live Neuralwatt fields authoritative through the production manager merge", async () => {
		// The bundled `kimi-k2.7-code` reference bakes positive prices,
		// `reasoning: true`, and `input: ["text", "image"]`. Explicit live zeros
		// and disabled capabilities must replace those stale values rather than
		// being treated as missing.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-neuralwatt-merge-"));
		try {
			const fetchMock: FetchImpl = async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "kimi-k2.7-code",
								object: "model",
								max_model_len: 262128,
								metadata: {
									display_name: "Kimi K2.7 Code",
									pricing: { input_per_million: 0, output_per_million: 0, cached_input_per_million: 0 },
									capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: false },
									limits: { max_context_length: 262128, max_output_tokens: null },
									deprecated: false,
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);

			const manager = createModelManager({
				...neuralwattModelManagerOptions({ apiKey: "neuralwatt-test-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");

			const kimi = models.find(model => model.id === "kimi-k2.7-code");
			expect(kimi).toBeDefined();
			expect(kimi?.reasoning).toBe(false);
			expect(kimi?.input).toEqual(["text"]);
			expect(kimi?.thinking).toBeUndefined();
			expect(kimi?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("keeps a live uncapped Neuralwatt maxTokens null through the manager merge", async () => {
		// The bundled `glm-5.2-short` reference bakes `maxTokens: 32000`. When the
		// live route reports the same id with an uncapped limit
		// (`max_output_tokens: null`, mapped to `null` because glm-5.2-short is not
		// a Kimi id), the merge must keep that live `null` — falling back to the
		// stale bundled 32000 would silently truncate generations Neuralwatt does
		// not cap.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-neuralwatt-limit-merge-"));
		try {
			const fetchMock: FetchImpl = async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "glm-5.2-short",
								object: "model",
								max_model_len: 199984,
								metadata: {
									display_name: "GLM-5.2 (short)",
									pricing: {
										input_per_million: 1.45,
										output_per_million: 4.5,
										cached_input_per_million: 0.3625,
									},
									capabilities: { tools: true, vision: false, reasoning: true, reasoning_effort: true },
									limits: { max_context_length: 199984, max_output_tokens: null },
									deprecated: false,
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);

			const manager = createModelManager({
				...neuralwattModelManagerOptions({ apiKey: "neuralwatt-test-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");

			const glm = models.find(model => model.id === "glm-5.2-short");
			expect(glm).toBeDefined();
			expect(glm?.maxTokens).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("discovers models without an API key (public endpoint)", async () => {
		const calls: Array<{ authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ authorization: headers.get("authorization") });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = neuralwattModelManagerOptions({ fetch: fetchMock });
		expect(options.fetchDynamicModels).toBeDefined();
		await options.fetchDynamicModels?.();
		expect(calls).toEqual([{ authorization: null }]);
	});

	test("scopes the discovery cache by credentials so an authenticated refresh bypasses the public cache", async () => {
		// Regression: before credential scoping, both managers defaulted to the
		// bare `neuralwatt` cache namespace, so an `online-if-uncached`
		// authenticated refresh against a DB the unauthenticated run just
		// populated reused that fresh cache — models listed only for the
		// credential never appeared. The namespace must be derived from the API
		// key and base URL.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-neuralwatt-scope-"));
		try {
			const cacheDbPath = path.join(tempDir, "models.db");
			// A synthetic public catalog row with complete metadata and explicit
			// pricing keeps this cache-scoping regression independent of Neuralwatt's
			// evolving public catalog and bundled references.
			const publicModel = {
				id: "synthetic-public-model",
				object: "model",
				max_model_len: 262128,
				metadata: {
					display_name: "Synthetic Public Model",
					pricing: { input_per_million: 0.95, output_per_million: 4, cached_input_per_million: 0.16 },
					capabilities: { tools: true, vision: true, reasoning: true, reasoning_effort: false },
					limits: { max_context_length: 262128, max_output_tokens: null },
					deprecated: false,
				},
			};

			const accountPrivateModel = {
				id: "synthetic-account-private-model",
				object: "model",
				max_model_len: 524288,
				metadata: {
					display_name: "Synthetic Account-Private Model",
					pricing: { input_per_million: 1.25, output_per_million: 5, cached_input_per_million: 0.25 },
					capabilities: { tools: true, vision: false, reasoning: false, reasoning_effort: false },
					limits: { max_context_length: 524288, max_output_tokens: 32768 },
					deprecated: false,
				},
			};

			const publicFetch: FetchImpl = async () =>
				new Response(JSON.stringify({ object: "list", data: [publicModel] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			const publicOptions = neuralwattModelManagerOptions({ fetch: publicFetch });
			const publicManager = createModelManager({ ...publicOptions, cacheDbPath });
			const publicResult = await publicManager.refresh("online-if-uncached");
			expect(publicResult.stale).toBe(false);
			expect(publicResult.models.some(model => model.id === publicModel.id)).toBe(true);

			// Same DB and same default base URL, now with an API key. The
			// credential-scoped listing adds a synthetic account-private row with
			// complete metadata and explicit pricing.
			let authenticatedFetches = 0;
			const authenticatedFetch: FetchImpl = async () => {
				authenticatedFetches++;
				return new Response(
					JSON.stringify({
						object: "list",
						data: [publicModel, accountPrivateModel],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};
			const authenticatedKey = "neuralwatt-authenticated-key";
			const authenticatedOptions = neuralwattModelManagerOptions({
				apiKey: authenticatedKey,
				fetch: authenticatedFetch,
			});
			const authenticatedManager = createModelManager({ ...authenticatedOptions, cacheDbPath });
			const authenticatedResult = await authenticatedManager.refresh("online-if-uncached");

			// The authenticated refresh must not reuse the fresh unauthenticated
			// cache: it fetches the credential-scoped listing and exposes its
			// account-private row.
			expect(authenticatedFetches).toBe(1);
			const discoveredAccountPrivateModel = authenticatedResult.models.find(
				model => model.id === accountPrivateModel.id,
			);
			expect(discoveredAccountPrivateModel).toBeDefined();
			expect(discoveredAccountPrivateModel?.cost).toEqual({
				input: 1.25,
				output: 5,
				cacheRead: 0.25,
				cacheWrite: 0,
			});

			// The namespace differs per credential, stays prefixed with the provider,
			// and never embeds the raw key. A distinct custom base URL scopes the
			// same credential to yet another namespace.
			expect(authenticatedOptions.cacheProviderId).not.toBe(publicOptions.cacheProviderId);
			expect(authenticatedOptions.cacheProviderId?.startsWith("neuralwatt")).toBe(true);
			expect(authenticatedOptions.cacheProviderId).not.toContain(authenticatedKey);
			const customBaseOptions = neuralwattModelManagerOptions({
				apiKey: authenticatedKey,
				baseUrl: "https://gateway.internal.example.com/neuralwatt/v1",
			});
			expect(customBaseOptions.cacheProviderId).not.toBe(authenticatedOptions.cacheProviderId);
			expect(customBaseOptions.cacheProviderId).not.toContain(authenticatedKey);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
