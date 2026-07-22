import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	type FetchImpl,
	getCustomApi,
} from "@oh-my-pi/pi-ai";
import { getOAuthProviders, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	dropUnavailableQoderApi3Models,
	setQoderWasmBridgeAvailabilityForTests,
} from "@oh-my-pi/pi-coding-agent/config/qoder-api3-availability";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const sourceIds = ["ext://atomic", "ext://runtime", "ext://oauth", "ext://other-runtime"];

	// Stub transport: reject every request so refresh("online") drives the full
	// online discovery path with deterministic, instant failures instead of real
	// network. Provider fetches (dynamic + models.dev) are caught and swallowed,
	// leaving the registry with its bundled catalog plus runtime overlays.
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in model-registry runtime test"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		vi.useRealTimers();
		clearCustomApis();
		for (const sourceId of sourceIds) {
			unregisterOAuthProviders(sourceId);
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	function getProviderModels(registry: ModelRegistry, providerName: string) {
		return registry.getAll().filter(model => model.provider === providerName);
	}

	function expectProviderHeader(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): void {
		for (const model of getProviderModels(registry, providerName)) {
			expect(model.headers?.[headerName]).toBe(expectedValue);
		}
	}

	async function expectProviderHeaderAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): Promise<void> {
		expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refresh("offline");
		expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refreshProvider(providerName, "offline");
		expectProviderHeader(registry, providerName, headerName, expectedValue);
	}

	async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			if (predicate()) return;
			await Promise.resolve();
		}
		throw new Error(errorMessage);
	}

	async function expectModelTransportAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		modelId: string,
		baseUrl: string,
		headerName: string,
		headerValue: string | undefined,
	): Promise<void> {
		const model = registry.find(providerName, modelId);
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe(baseUrl);
		expect(model?.headers?.[headerName]).toBe(headerValue);
		await registry.refresh("offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
		await registry.refreshProvider(providerName, "offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
	}

	test("validates provider config before mutating custom API state", () => {
		const beforeAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;

		const invalidConfig: ProviderConfigInput = {
			api: "custom-atomic-api",
			apiKey: "RUNTIME_KEY",
			streamSimple,
			models: [{ ...baseModel, id: "broken" }],
			// baseUrl intentionally missing to force validation failure
		};

		expect(() => registry.registerProvider("atomic-provider", invalidConfig, "ext://atomic")).toThrow(
			'Provider atomic-provider: "baseUrl" is required when defining custom models.',
		);
		expect(getCustomApi("custom-atomic-api")).toBeUndefined();

		const afterAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;
		expect(afterAnthropicCount).toBe(beforeAnthropicCount);
	});

	test("registerProvider applies headers-only overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";
		const runtimeHeader = "X-Runtime-Provider-Header";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { headers: { [runtimeHeader]: "runtime-header" } }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, runtimeHeader, "runtime-header");

		registry.clearSourceRegistrations("ext://runtime");
		expectProviderHeader(registry, providerName, runtimeHeader, undefined);
	});

	test("registerProvider keeps runtime header objects live for request-time reads", () => {
		const providerHeaders: Record<string, string> = { "X-Request-ID": "request-1" };
		const modelHeaders: Record<string, string> = { "X-Message-ID": "message-1" };

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				headers: providerHeaders,
				models: [{ ...baseModel, headers: modelHeaders }],
			},
			"ext://runtime",
		);

		providerHeaders["X-Request-ID"] = "request-2";
		providerHeaders["X-Turn-ID"] = "turn-2";
		modelHeaders["X-Message-ID"] = "message-2";
		modelHeaders["X-Model-Turn-ID"] = "model-turn-2";

		const model = registry.find("runtime-provider", "runtime-model");
		expect({ ...(model?.headers ?? {}) }).toEqual({
			"X-Request-ID": "request-2",
			"X-Turn-ID": "turn-2",
			"X-Message-ID": "message-2",
			"X-Model-Turn-ID": "model-turn-2",
		});
	});

	test("registerProvider carries requestModelId from extension models into finalized models", async () => {
		const providerName = "qoder";
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://api2-v2.qoder.sh/model/v1",
				apiKey: "QODER_KEY",
				api: "openai-completions",
				models: [
					{
						id: "foo",
						name: "Foo",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 32_000,
					},
					{
						id: "foo-1m",
						name: "Foo (1M)",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 32_000,
						requestModelId: "foo",
					},
				],
			},
			"ext://runtime",
		);

		const base = registry.find(providerName, "foo");
		expect(base).toBeDefined();
		expect(base?.id).toBe("foo");
		expect(base?.requestModelId).toBeUndefined();

		const alias = registry.find(providerName, "foo-1m");
		expect(alias).toBeDefined();
		expect(alias?.id).toBe("foo-1m");
		expect(alias?.name).toBe("Foo (1M)");
		expect(alias?.contextWindow).toBe(1_000_000);
		expect(alias?.requestModelId).toBe("foo");

		await registry.refresh("offline");
		const aliasAfterRefresh = registry.find(providerName, "foo-1m");
		expect(aliasAfterRefresh?.id).toBe("foo-1m");
		expect(aliasAfterRefresh?.requestModelId).toBe("foo");
	});

	test("replace-mode overlays clear omitted requestModelId instead of keeping a bundled alias wire rewrite", async () => {
		const providerName = "qoder";
		// Bundled qoder/ultimate-1m rewrites to "ultimate". Redefining it as a
		// real model (omit requestModelId) must send the local id on both the
		// immediate registerProvider path and after refresh merge.
		expect(registry.find(providerName, "ultimate-1m")?.requestModelId).toBe("ultimate");

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://api2-v2.qoder.sh/model/v1",
				apiKey: "QODER_KEY",
				api: "openai-completions",
				models: [
					{
						id: "ultimate-1m",
						name: "Ultimate (1M)",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 32_768,
					},
					{
						id: "vendor/ultimate-1m",
						name: "Proxied Ultimate (1M)",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 32_768,
					},
				],
			},
			"ext://runtime",
		);

		const alias = registry.find(providerName, "ultimate-1m");
		expect(alias).toBeDefined();
		expect(alias?.id).toBe("ultimate-1m");
		expect(alias?.requestModelId).toBeUndefined();

		// Fuzzy ids must not pick up a Qoder alias wire rewrite either.
		const proxied = registry.find(providerName, "vendor/ultimate-1m");
		expect(proxied).toBeDefined();
		expect(proxied?.requestModelId).toBeUndefined();

		await registry.refresh("offline");
		const aliasAfterRefresh = registry.find(providerName, "ultimate-1m");
		expect(aliasAfterRefresh?.id).toBe("ultimate-1m");
		expect(aliasAfterRefresh?.requestModelId).toBeUndefined();
	});

	test("Qoder reference metadata does not leak into unrelated providers with colliding ids", async () => {
		registry.registerProvider(
			"other-provider",
			{
				baseUrl: "https://example.test/v1",
				apiKey: "OTHER_KEY",
				api: "openai-completions",
				models: [
					{
						id: "ultimate-1m",
						name: "Other Ultimate (1M)",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			},
			"ext://other-runtime",
		);

		const crossProvider = registry.find("other-provider", "ultimate-1m");
		expect(crossProvider).toBeDefined();
		expect(crossProvider?.requestModelId).toBeUndefined();
		expect(crossProvider?.contextWindow).toBe(128_000);
		expect(crossProvider?.maxTokens).toBe(8_192);
		const compat = crossProvider?.compatConfig as { extraBody?: Record<string, unknown> } | undefined;
		expect(compat?.extraBody?.context_length).toBeUndefined();

		// Same-provider Qoder overrides still resolve against the Qoder seed.
		registry.registerProvider(
			"qoder",
			{
				baseUrl: "https://api2-v2.qoder.sh/model/v1",
				apiKey: "QODER_KEY",
				api: "openai-completions",
				models: [
					{
						id: "ultimate-1m",
						name: "Ultimate Override",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 1_000_000,
						maxTokens: 32_768,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						// Omit compat so the same-provider Qoder reference still
						// supplies its transport-specific policy.
					},
				],
			},
			"ext://runtime",
		);
		const sameProvider = registry.find("qoder", "ultimate-1m");
		expect(sameProvider).toBeDefined();
		expect(sameProvider?.name).toBe("Ultimate Override");
		expect(sameProvider?.contextWindow).toBe(1_000_000);
		expect(sameProvider?.maxTokens).toBe(32_768);
		const qoderCompat = sameProvider?.compatConfig as { extraBody?: Record<string, unknown> } | undefined;
		expect(qoderCompat?.extraBody?.context_length).toBe(1_000_000);
	});

	test("registerProvider applies authHeader overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { apiKey: "RUNTIME_AUTH_KEY", authHeader: true }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, "Authorization", "Bearer RUNTIME_AUTH_KEY");

		registry.clearSourceRegistrations("ext://runtime");
		expectProviderHeader(registry, providerName, "Authorization", undefined);
	});

	test("registerProvider applies remoteCompaction-only overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";
		const overrideEndpoint = "https://runtime.example.com/v1/compact";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(
			providerName,
			{ remoteCompaction: { enabled: false, endpoint: overrideEndpoint } },
			"ext://runtime",
		);

		const expectCompaction = () => {
			for (const model of getProviderModels(registry, providerName)) {
				expect(model.remoteCompaction?.enabled).toBe(false);
				expect(model.remoteCompaction?.endpoint).toBe(overrideEndpoint);
			}
		};
		expectCompaction();
		await registry.refresh("offline");
		expectCompaction();
		await registry.refreshProvider(providerName, "offline");
		expectCompaction();

		registry.clearSourceRegistrations("ext://runtime");
		for (const model of getProviderModels(registry, providerName)) {
			expect(model.remoteCompaction?.endpoint).not.toBe(overrideEndpoint);
		}
	});

	test("refreshRuntimeProviders preserves model-level remoteCompaction over provider defaults", async () => {
		const providerName = "dynamic-compact-provider";
		const providerEndpoint = "https://runtime.example.com/v1/responses/provider-compact";
		const modelEndpoint = "https://runtime.example.com/v1/responses/model-compact";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-responses",
				remoteCompaction: {
					enabled: true,
					api: "openai-responses",
					endpoint: providerEndpoint,
					model: "provider-compact",
				},
				fetchDynamicModels: async () => [
					{
						...baseModel,
						id: "dynamic-compact-model",
						remoteCompaction: {
							endpoint: modelEndpoint,
							model: "model-compact",
						},
					},
				],
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		const model = registry.find(providerName, "dynamic-compact-model");
		expect(model?.remoteCompaction).toEqual({
			enabled: true,
			api: "openai-responses",
			endpoint: modelEndpoint,
			model: "model-compact",
		});
	});

	test("configured discovery suppresses extension fetchDynamicModels for the same provider", async () => {
		const providerName = "runtime-configured-provider";
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "http://127.0.0.1:4893",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const configuredFetch: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4893/v1/models") {
				return Response.json({
					data: [{ id: "shared-runtime-model", context_length: 32_768 }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: configuredFetch });
		let runtimeFetchCalls = 0;
		configuredRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					runtimeFetchCalls++;
					return [{ ...baseModel, id: "shared-runtime-model", contextWindow: 999_999 }];
				},
			},
			"ext://runtime",
		);

		await configuredRegistry.refreshProvider(providerName, "online");

		expect(runtimeFetchCalls).toBe(0);
		expect(configuredRegistry.find(providerName, "shared-runtime-model")?.contextWindow).toBe(32_768);
	});

	test("refreshRuntimeProviders times out extension fetchDynamicModels that never resolves", async () => {
		vi.useFakeTimers();
		const hangingFetch = Promise.withResolvers<readonly NonNullable<ProviderConfigInput["models"]>[number][]>();
		registry.registerProvider(
			"hanging-runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: () => hangingFetch.promise,
			},
			"ext://runtime",
		);

		const baselineTimers = vi.getTimerCount();
		let outcome: "resolved" | "rejected" | undefined;
		const refresh = registry.refreshRuntimeProviders("online").then(
			() => {
				outcome = "resolved";
			},
			error => {
				outcome = "rejected";
				throw error;
			},
		);

		await drainMicrotasksUntil(
			() => vi.getTimerCount() > baselineTimers,
			"dynamic fetch timeout timer was not armed",
		);
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(14_999);
		await Promise.resolve();
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(1);
		await refresh;
		expect(outcome).toBe("resolved");
		expect(registry.find("hanging-runtime-provider", "any-model")).toBeUndefined();
	});

	test("registerProvider preserves explicit thinking and backfills wire facts", () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "anthropic-messages",
			models: [
				{
					...baseModel,
					id: "runtime-thinking-model",
					reasoning: true,
					thinking: {
						mode: "anthropic-adaptive",
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
					},
				},
			],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		const model = registry.find("runtime-provider", "runtime-thinking-model");

		expect(model?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			// Adaptive ladders are wire-exact (no backfilled effortMap); only
			// requiresEffort is backfilled from identity.
			requiresEffort: true,
		});
	});

	test("extension-registered models survive refresh('offline') cycle", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();

		await registry.refresh("offline");

		const model = registry.find("runtime-provider", "runtime-model");
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://runtime.example.com/v1");
		expect(model?.api).toBe("openai-completions");
	});

	test("extension-registered models survive refresh('online') cycle", async () => {
		// The shared registry uses a stub fetch that rejects every request, so
		// refresh("online") exercises the full online discovery path without real
		// network: each provider's fetch fails fast and is swallowed. The contract
		// under test is overlay survival across the online cycle, not discovery.
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "online-survivor" }],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "online-survivor")).toBeDefined();

		await registry.refresh("online");

		const model = registry.find("runtime-provider", "online-survivor");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
	});

	test("headers-only runtime override preserves existing baseUrl across refresh", async () => {
		const modelId = "runtime-headers-only-baseurl-survivor";
		const overrideBaseUrl = "https://runtime-baseurl.example.com/v1";
		const runtimeHeader = "X-Runtime-Headers-Only";

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", { baseUrl: overrideBaseUrl }, "ext://runtime");
		registry.registerProvider(
			"runtime-provider",
			{ headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);

		await expectModelTransportAcrossRefresh(
			registry,
			"runtime-provider",
			modelId,
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("runtime-provider", modelId)).toBeUndefined();
	});

	test("runtime headers override modelOverrides headers across refresh cycles", async () => {
		const targetModel = registry.getAll().find(model => model.provider === "anthropic");
		if (!targetModel) throw new Error("Expected bundled anthropic model");

		const modelId = targetModel.id;
		const sharedHeader = "X-Shared-Provider-Model-Header";
		const configHeaderValue = "config-header";
		const runtimeHeaderValue = "runtime-header";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					anthropic: { modelOverrides: { [modelId]: { headers: { [sharedHeader]: configHeaderValue } } } },
				},
			}),
		);

		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		expect(configuredRegistry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);

		configuredRegistry.registerProvider(
			"anthropic",
			{ headers: { [sharedHeader]: runtimeHeaderValue } },
			"ext://runtime",
		);
		await expectProviderHeaderAcrossRefresh(configuredRegistry, "anthropic", sharedHeader, runtimeHeaderValue);

		configuredRegistry.clearSourceRegistrations("ext://runtime");
		expect(configuredRegistry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);
	});

	test("extension-registered API keys survive refresh cycle for auth resolution", async () => {
		// Set up the env var that the apiKey config references
		process.env.TEST_RUNTIME_KEY = "test-value";

		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "TEST_RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		await registry.refresh("offline");

		// The fallback resolver should still find the API key after refresh
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		delete process.env.TEST_RUNTIME_KEY;
	});

	test("extension-registered custom API handler survives model refresh", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(getCustomApi("custom-runtime-api")).toBeDefined();

		// Custom API registry is separate from model registry — verify it persists
		// Note: refresh clears+re-registers source registrations via sdk.ts,
		// but the custom API registry itself is not cleared by refresh()
		await registry.refresh("offline");

		expect(getCustomApi("custom-runtime-api")).toBeDefined();
	});

	test("re-registering a provider replaces overlays and keeps transport overrides stable", async () => {
		const runtimeHeader = "X-ReRegister-Provider-Header";
		const overrideBaseUrl = "https://runtime-override.example.com/v1";
		const config1: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v1", name: "Model V1" }],
		};
		const config2: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v2",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v2", name: "Model V2" }],
		};

		registry.registerProvider("runtime-provider", config1, "ext://runtime");
		registry.registerProvider(
			"runtime-provider",
			{ baseUrl: overrideBaseUrl, headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", config2, "ext://runtime");

		expect(registry.find("runtime-provider", "model-v1")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			"runtime-provider",
			"model-v2",
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
	});

	test("provider source handoff does not retain previous source transport overrides", async () => {
		const providerName = "shared-runtime-provider";
		const leakedHeader = "X-Old-Source-Header";
		const sourceBBaseUrl = "https://source-b.example.com/v1";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://source-a.example.com/v1",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{ baseUrl: "https://override-a.example.com/v1", headers: { [leakedHeader]: "from-source-a" } },
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{
				baseUrl: sourceBBaseUrl,
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find(providerName, "model-a")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			providerName,
			"model-b",
			sourceBBaseUrl,
			leakedHeader,
			undefined,
		);
	});

	test("transport-only source handoff clears previous source headers immediately", async () => {
		const providerName = "anthropic";
		const sourceAHeader = "X-Source-A-Header";
		const sourceBHeader = "X-Source-B-Header";

		registry.registerProvider(providerName, { headers: { [sourceAHeader]: "from-source-a" } }, "ext://a");
		expectProviderHeader(registry, providerName, sourceAHeader, "from-source-a");

		registry.registerProvider(providerName, { headers: { [sourceBHeader]: "from-source-b" } }, "ext://b");
		await expectProviderHeaderAcrossRefresh(registry, providerName, sourceAHeader, undefined);
		expectProviderHeader(registry, providerName, sourceBHeader, "from-source-b");
	});

	test("multiple extension providers survive refresh independently", async () => {
		registry.registerProvider(
			"provider-a",
			{
				baseUrl: "https://a.example.com",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			"provider-b",
			{
				baseUrl: "https://b.example.com",
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();

		await registry.refresh("offline");

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();
	});

	test("clearSourceRegistrations and syncExtensionSources remove source-scoped API and OAuth providers", () => {
		const oauthCredentials: OAuthCredentials = {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};

		const config: ProviderConfigInput = {
			api: "custom-oauth-api",
			streamSimple,
			oauth: {
				name: "Custom OAuth",
				login: async () => oauthCredentials,
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
			},
		};

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.clearSourceRegistrations("ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.syncExtensionSources([]);
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);
	});
});

describe("Qoder api3 availability gate", () => {
	const API3_BASE_IDS = ["cmodel", "qmodel_preview", "qmodel_latest", "kmodel_latest", "gm51model", "dfmodel"];
	const API3_IDS = API3_BASE_IDS.flatMap(id => [id, `${id}-400k`, `${id}-1m`]);
	const LEGACY_COUNT = 19; // 9 bases + 10 context aliases
	const FULL_COUNT = 37; // 15 bases + 22 context aliases

	let tempDir: string;
	let authStorage: AuthStorage;
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in qoder api3 gate test"));

	function qoderRows(registry: ModelRegistry): Model<Api>[] {
		return registry.getAll().filter(model => model.provider === "qoder");
	}

	function createRegistry(): ModelRegistry {
		return new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
	}

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-qoder-api3-gate-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		setQoderWasmBridgeAvailabilityForTests(undefined);
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("drops every api3 row when the auth WASM is unavailable, across load and refresh", async () => {
		setQoderWasmBridgeAvailabilityForTests(false);
		const registry = createRegistry();

		const ids = new Set(qoderRows(registry).map(model => model.id));
		expect(ids.size).toBe(LEGACY_COUNT);
		for (const id of API3_IDS) {
			expect(ids.has(id), `qoder/${id} must be gated out`).toBe(false);
			expect(registry.find("qoder", id), `qoder/${id} must not resolve`).toBeUndefined();
		}
		expect(registry.find("qoder", "auto")).toBeDefined();
		expect(registry.find("qoder", "ultimate-1m")).toBeDefined();

		await registry.refresh("offline");
		expect(qoderRows(registry)).toHaveLength(LEGACY_COUNT);
		await registry.refreshProvider("qoder", "offline");
		expect(qoderRows(registry)).toHaveLength(LEGACY_COUNT);
		expect(registry.find("qoder", "dfmodel-1m")).toBeUndefined();
	});

	test("keeps every api3 row when the auth WASM is available", async () => {
		setQoderWasmBridgeAvailabilityForTests(true);
		const registry = createRegistry();

		expect(qoderRows(registry)).toHaveLength(FULL_COUNT);
		for (const id of API3_IDS) {
			const model = registry.find("qoder", id);
			expect(model, `qoder/${id} must be present`).toBeDefined();
			const compat = model?.compat;
			expect(
				typeof compat === "object" && compat !== null && "api3" in compat && compat.api3 === true,
				`qoder/${id} must carry the resolved api3 flag`,
			).toBe(true);
		}
		const alias = registry.find("qoder", "dfmodel-1m");
		expect(alias?.requestModelId).toBe("dfmodel");
		expect(alias?.contextWindow).toBe(1_000_000);

		await registry.refresh("offline");
		expect(qoderRows(registry)).toHaveLength(FULL_COUNT);
	});

	test("re-evaluates the gate on each refresh cycle", async () => {
		setQoderWasmBridgeAvailabilityForTests(false);
		const registry = createRegistry();
		expect(qoderRows(registry)).toHaveLength(LEGACY_COUNT);

		setQoderWasmBridgeAvailabilityForTests(true);
		await registry.refresh("offline");
		expect(qoderRows(registry)).toHaveLength(FULL_COUNT);
		expect(registry.find("qoder", "cmodel")).toBeDefined();

		setQoderWasmBridgeAvailabilityForTests(false);
		await registry.refresh("offline");
		expect(qoderRows(registry)).toHaveLength(LEGACY_COUNT);
		expect(registry.find("qoder", "cmodel")).toBeUndefined();
	});
});

describe("dropUnavailableQoderApi3Models", () => {
	function qoderSpec(id: string, api3: boolean): Model<Api> {
		return buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider: "qoder",
			baseUrl: "https://api2-v2.qoder.sh/model/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
			compat: { supportsStore: false, ...(api3 ? { api3: true } : {}) },
		});
	}

	afterEach(() => {
		setQoderWasmBridgeAvailabilityForTests(undefined);
	});

	test("is identity when no api3 rows are present, whatever the availability", () => {
		const models = [qoderSpec("auto", false), qoderSpec("ultimate", false)];
		setQoderWasmBridgeAvailabilityForTests(false);
		expect(dropUnavailableQoderApi3Models(models)).toBe(models);
		setQoderWasmBridgeAvailabilityForTests(true);
		expect(dropUnavailableQoderApi3Models(models)).toBe(models);
	});

	test("drops only qoder api3 rows when unavailable; other providers pass through", () => {
		const other = buildModel({
			id: "api3-named-decoy",
			name: "api3-named-decoy",
			api: "openai-completions",
			provider: "not-qoder",
			baseUrl: "https://example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
			compat: { api3: true },
		});
		const models = [qoderSpec("auto", false), qoderSpec("dfmodel", true), qoderSpec("dfmodel-1m", true), other];
		setQoderWasmBridgeAvailabilityForTests(false);
		expect(dropUnavailableQoderApi3Models(models).map(model => `${model.provider}/${model.id}`)).toEqual([
			"qoder/auto",
			"not-qoder/api3-named-decoy",
		]);
		setQoderWasmBridgeAvailabilityForTests(true);
		expect(dropUnavailableQoderApi3Models(models)).toBe(models);
	});
});
