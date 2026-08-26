import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	type FetchImpl,
	getCustomApi,
	type Model,
} from "@oh-my-pi/pi-ai";
import { getOAuthProviders, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const sourceIds = ["ext://atomic", "ext://runtime", "ext://oauth"];

	// Stub transport: reject every request so refresh("online") drives the full
	// online discovery path with deterministic, instant failures instead of real
	// network. Provider fetches (dynamic + stencil.so) are caught and swallowed,
	// leaving the registry with its bundled catalog plus runtime overlays.
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in model-registry runtime test"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		vi.useRealTimers();
		clearCustomApis();
		for (const sourceId of sourceIds) {
			unregisterOAuthProviders(sourceId);
		}
		resetSettingsForTest();
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

	test("registerProvider rebuilds inferred computer capability after OpenAI runtime reroutes", async () => {
		const modelId = "gpt-5.4";
		const directModel = registry.find("openai", modelId);
		expect(directModel?.supportsComputerUse).toBe(true);

		registry.registerProvider("openai", { baseUrl: "https://runtime-proxy.example.com/v1" }, "ext://runtime");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);

		await registry.refresh("offline");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);
		await registry.refreshProvider("openai", "offline");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);

		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(true);
	});

	test("config.models re-registration rebuilds inferred capability after a saved transport override", () => {
		const providerName = "openai";
		const modelId = "gpt-5.4";
		const proxyBaseUrl = "https://runtime-proxy.example.com/v1";

		registry.registerProvider(providerName, { baseUrl: proxyBaseUrl }, "ext://runtime");
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://api.openai.com/v1",
				api: "openai-responses",
				apiKey: "RUNTIME_KEY",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);

		const model = registry.find(providerName, modelId);
		expect(model?.baseUrl).toBe(proxyBaseUrl);
		expect(model?.supportsComputerUse).toBe(false);
		expect(model?.supportsComputerUseConfig).toBeUndefined();
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

	test("auth-declared runtime providers defer fetchDynamicModels until a credential resolves", async () => {
		const providerName = "gated-runtime-provider";
		let discoveryCalls = 0;

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				auth: "apiKey",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return [{ ...baseModel, id: "gated-model" }];
				},
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		expect(discoveryCalls).toBe(0);
		expect(registry.find(providerName, "gated-model")).toBeUndefined();
		// A resolved credential (login/env/config key) unlocks discovery.
		registry.authStorage.setRuntimeApiKey(providerName, "RUNTIME_KEY");
		await registry.refreshProvider(providerName, "online");
		expect(discoveryCalls).toBe(1);
		expect(registry.find(providerName, "gated-model")).toBeDefined();
	});

	test("null from fetchDynamicModels preserves previously discovered cached models", async () => {
		const providerName = "null-fetch-provider";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => [{ ...baseModel, id: "transient-model" }],
			},
			"ext://runtime",
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "transient-model")).toBeDefined();

		// Re-register with a fetcher reporting failed discovery (contract null):
		// the cached catalog must survive the cycle instead of being pruned.
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => null,
			},
			"ext://runtime",
		);
		await registry.refreshProvider(providerName, "online");
		expect(registry.find(providerName, "transient-model")).toBeDefined();
	});
	test("runtime baseUrl default does not clobber per-model baseUrl from fetchDynamicModels", async () => {
		const providerName = "per-model-url-provider";
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => [
					{ ...baseModel, id: "openai-wire", baseUrl: "https://openai-wire.example.com/v1" },
					{
						...baseModel,
						id: "anthropic-wire",
						api: "anthropic-messages",
						baseUrl: "https://anthropic-wire.example.com/v1",
					},
					{ ...baseModel, id: "fallback-model" },
				],
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "openai-wire")?.baseUrl).toBe("https://openai-wire.example.com/v1");
		expect(registry.find(providerName, "anthropic-wire")?.baseUrl).toBe("https://anthropic-wire.example.com/v1");
		expect(registry.find(providerName, "fallback-model")?.baseUrl).toBe("https://default.example.com/v1");

		// A full recomposition (compose site) must preserve the same contract.
		await registry.refresh("offline");
		expect(registry.find(providerName, "openai-wire")?.baseUrl).toBe("https://openai-wire.example.com/v1");
		expect(registry.find(providerName, "anthropic-wire")?.baseUrl).toBe("https://anthropic-wire.example.com/v1");
		expect(registry.find(providerName, "fallback-model")?.baseUrl).toBe("https://default.example.com/v1");
	});

	test("provider baseUrl stays a default for static models that declare their own", async () => {
		const providerName = "static-per-model-url-provider";
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{ ...baseModel, id: "own-url-model", baseUrl: "https://own.example.com/v1" },
					{ ...baseModel, id: "inheriting-model" },
				],
			},
			"ext://runtime",
		);

		const expectBaseUrls = () => {
			expect(registry.find(providerName, "own-url-model")?.baseUrl).toBe("https://own.example.com/v1");
			expect(registry.find(providerName, "inheriting-model")?.baseUrl).toBe("https://default.example.com/v1");
		};
		expectBaseUrls();
		await registry.refresh("offline");
		expectBaseUrls();
		await registry.refreshProvider(providerName, "offline");
		expectBaseUrls();
	});

	test("cache-served dynamic models keep per-model baseUrls without a live fetch", async () => {
		const providerName = "warm-cache-url-provider";
		const cacheDbPath = path.join(tempDir, "model-cache.db");
		const dynamicModels = async () => [
			{ ...baseModel, id: "own-a", baseUrl: "https://own-a.example.com/v1" },
			{ ...baseModel, id: "own-b", baseUrl: "https://own-b.example.com/v1" },
			{ ...baseModel, id: "inherited-model" },
		];

		// Seed the SQLite discovery cache with exactly one live fetch.
		const first = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		first.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: dynamicModels,
			},
			"ext://runtime",
		);
		await first.refreshRuntimeProviders("online");
		expect(first.find(providerName, "own-a")?.baseUrl).toBe("https://own-a.example.com/v1");

		// A fresh registry over the same cache: the rows are fresh under the
		// runtime provider TTL, so an online-if-uncached cycle serves the cached
		// specs WITHOUT invoking the fetcher. The provider baseUrl must still act
		// only as a default for models that declared their own url.
		let discoveryCalls = 0;
		const second = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		second.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return dynamicModels();
				},
			},
			"ext://runtime",
		);
		await second.refreshRuntimeProviders("online-if-uncached");
		expect(discoveryCalls).toBe(0);
		const expectBaseUrls = () => {
			expect(second.find(providerName, "own-a")?.baseUrl).toBe("https://own-a.example.com/v1");
			expect(second.find(providerName, "own-b")?.baseUrl).toBe("https://own-b.example.com/v1");
			expect(second.find(providerName, "inherited-model")?.baseUrl).toBe("https://default.example.com/v1");
		};
		expectBaseUrls();
		await second.refresh("offline");
		expectBaseUrls();
	});

	test("auth-gated cached fallback keeps per-model baseUrls without credentials", async () => {
		const providerName = "gated-cache-url-provider";
		const cacheDbPath = path.join(tempDir, "model-cache.db");
		const dynamicModels = async () => [
			{ ...baseModel, id: "gated-own", baseUrl: "https://gated-own.example.com/v1" },
			{ ...baseModel, id: "gated-inherited" },
		];

		const first = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		first.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: dynamicModels,
			},
			"ext://runtime",
		);
		await first.refreshRuntimeProviders("online");

		// The unauthenticated second instance cannot run discovery at all: the
		// requiresAuth preflight surfaces the cached catalog via readModelCache
		// (no fetch, no cache write). Even so, the model-declared url must not be
		// clobbered by the provider-level runtime override. A separate
		// AuthStorage keeps the seed credential from leaking into the cycle.
		let discoveryCalls = 0;
		const unauthStorage = await AuthStorage.create(":memory:");
		const second = new ModelRegistry(unauthStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		second.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "apiKey",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return dynamicModels();
				},
			},
			"ext://runtime",
		);
		await second.refreshRuntimeProviders("online");
		expect(discoveryCalls).toBe(0);
		expect(second.find(providerName, "gated-own")?.baseUrl).toBe("https://gated-own.example.com/v1");
		expect(second.find(providerName, "gated-inherited")?.baseUrl).toBe("https://default.example.com/v1");
		unauthStorage.close();
	});

	test("auth none registers keyless static models without credentials", () => {
		const providerName = "keyless-static-provider";
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://keyless.example.com/v1",
				auth: "none",
				api: "openai-completions",
				models: [baseModel],
			},
			"ext://runtime",
		);

		const model = registry.find(providerName, baseModel.id);
		expect(model).toBeDefined();
		expect(registry.getAvailable().some(candidate => candidate.provider === providerName)).toBe(true);
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
	});

	test("auth none discovers dynamic models without credentials", async () => {
		const providerName = "keyless-dynamic-provider";
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://keyless.example.com/v1",
				auth: "none",
				api: "openai-completions",
				fetchDynamicModels: async () => [{ ...baseModel, id: "keyless-dynamic-model" }],
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		const model = registry.find(providerName, "keyless-dynamic-model");
		expect(model).toBeDefined();
		expect(registry.getAvailable().some(candidate => candidate.provider === providerName)).toBe(true);
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
	});

	test("keyless lifecycle: unregister removes availability and credential auth flips out of keyless", () => {
		const providerName = "keyless-lifecycle-provider";
		const keylessConfig: ProviderConfigInput = {
			baseUrl: "https://keyless.example.com/v1",
			auth: "none",
			api: "openai-completions",
			models: [baseModel],
		};
		const isAvailable = () => registry.getAvailable().some(candidate => candidate.provider === providerName);

		registry.registerProvider(providerName, keylessConfig, "ext://runtime");
		const model = registry.find(providerName, baseModel.id)!;
		expect(model).toBeDefined();
		expect(isAvailable()).toBe(true);
		expect(registry.hasConfiguredAuth(model)).toBe(true);

		registry.unregisterProvider(providerName);
		expect(registry.find(providerName, baseModel.id)).toBeUndefined();
		expect(isAvailable()).toBe(false);

		registry.registerProvider(providerName, keylessConfig, "ext://runtime");
		expect(isAvailable()).toBe(true);

		// A credential auth mode flips the provider out of the keyless set even
		// while no credential resolves: the model survives but gates on auth.
		registry.registerProvider(
			providerName,
			{ auth: "apiKey", baseUrl: "https://keyless.example.com/v1" },
			"ext://runtime",
		);
		const flipped = registry.find(providerName, baseModel.id)!;
		expect(flipped).toBeDefined();
		expect(registry.hasConfiguredAuth(flipped)).toBe(false);
		expect(isAvailable()).toBe(false);
	});

	test("expired oauth credential defers gated discovery without throwing", async () => {
		const providerName = "expired-oauth-runtime-provider";
		let discoveryCalls = 0;

		await authStorage.set(providerName, {
			type: "oauth",
			access: "expired-access",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
		});

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				auth: "oauth",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return [{ ...baseModel, id: "oauth-model" }];
				},
			},
			"ext://oauth",
		);

		// No refresher is registered for this provider: the OAuth fallback must
		// fail gracefully and keep discovery gated rather than throw or fetch.
		await registry.refreshRuntimeProviders("online");
		expect(discoveryCalls).toBe(0);
		expect(registry.find(providerName, "oauth-model")).toBeUndefined();
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

	test("runtime-registered models inherit configured provider guardrails", () => {
		const providerName = "amazon-bedrock";
		const modelId = "runtime-bedrock-model";
		const guardrailIdentifier = "arn:aws:bedrock:eu-west-2:123456789012:guardrail/abcd1234";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						guardrailIdentifier,
						guardrailVersion: "1",
						guardrailTrace: "enabled",
					},
				},
			}),
		);
		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });

		configuredRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				apiKey: "RUNTIME_KEY",
				api: "bedrock-converse-stream",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);

		const model = configuredRegistry.find(providerName, modelId);
		expect(model?.guardrailIdentifier).toBe(guardrailIdentifier);
		expect(model?.guardrailVersion).toBe("1");
		expect(model?.guardrailTrace).toBe("enabled");
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

	test("oauth.modifyModels projection survives refresh and refreshProvider", async () => {
		await authStorage.set("projecting-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Mirrors a credential-aware provider: the registered `models` array is a
		// pre-discovery bootstrap, and modifyModels swaps in the catalog the
		// account actually has.
		const config: ProviderConfigInput = {
			api: "custom-projection-api",
			baseUrl: "https://example.invalid/",
			streamSimple,
			models: [baseModel],
			oauth: {
				name: "Projecting OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== "projecting-provider"),
					{
						...(models.find(model => model.provider === "projecting-provider") as Model<Api>),
						id: "projected-model",
						name: "Projected Model",
					},
				],
			},
		};

		registry.registerProvider("projecting-provider", config, "ext://oauth");

		const projectedIds = () => getProviderModels(registry, "projecting-provider").map(model => model.id);
		expect(projectedIds()).toEqual(["projected-model"]);

		// The model selector reloads the registry offline every time it opens; the
		// projection must not fall back to the bootstrap `models` array.
		await registry.refresh("offline");
		expect(projectedIds()).toEqual(["projected-model"]);

		await registry.refreshProvider("projecting-provider", "offline");
		expect(projectedIds()).toEqual(["projected-model"]);

		registry.clearSourceRegistrations("ext://oauth");
		expect(getProviderModels(registry, "projecting-provider")).toEqual([]);
	});

	test("a throwing modifyModels degrades to the unprojected catalog", async () => {
		await authStorage.set("throwing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		registry.registerProvider(
			"throwing-provider",
			{
				api: "custom-throwing-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Throwing OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: () => {
						throw new Error("boom");
					},
				},
			},
			"ext://oauth",
		);

		expect(getProviderModels(registry, "throwing-provider").map(model => model.id)).toEqual(["runtime-model"]);
		await registry.refresh("offline");
		expect(getProviderModels(registry, "throwing-provider").map(model => model.id)).toEqual(["runtime-model"]);
		// A broken extension must not take the rest of the catalog down with it.
		expect(registry.getAll().some(model => model.provider === "anthropic")).toBe(true);
	});

	test("a throwing modifyModels logs once per distinct failure", async () => {
		await authStorage.set("noisy-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			registry.registerProvider(
				"noisy-provider",
				{
					api: "custom-noisy-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Noisy OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: () => {
							throw new Error("boom");
						},
					},
				},
				"ext://oauth",
			);

			const modifierWarnings = () =>
				warn.mock.calls.filter(([message]) => String(message).includes("extension model projection failed"));
			expect(modifierWarnings()).toHaveLength(1);
			expect(modifierWarnings()[0]?.[1]).toMatchObject({ provider: "noisy-provider", error: "boom" });

			// Same failure on every later recomposition must not spam the log.
			await registry.refresh("offline");
			expect(modifierWarnings()).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("a non-idempotent modifyModels does not compound across refreshes", async () => {
		await authStorage.set("appending-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Deliberately append-only: the hook never strips its own prior output, so
		// feeding it an already-projected list would duplicate on every rebuild.
		let projectionCount = 0;
		registry.registerProvider(
			"appending-provider",
			{
				api: "custom-appending-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Appending OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						const seed = models.find(model => model.provider === "appending-provider") as Model<Api>;
						return [...models, { ...seed, id: `extra-${projectionCount}` }];
					},
				},
			},
			"ext://oauth",
		);

		const ids = () => getProviderModels(registry, "appending-provider").map(model => model.id);
		expect(ids()).toEqual(["runtime-model", "extra-1"]);

		await registry.refresh("offline");
		expect(ids()).toHaveLength(2);

		await registry.refresh("online");
		expect(ids()).toHaveLength(2);
	});

	test("a non-idempotent modifyModels does not compound when another provider registers", async () => {
		// The SDK and CLI loaders drain pending registrations one at a time, so an
		// earlier provider's projection is still in #models when the next arrives.
		const registerAppending = async (providerName: string, apiId: string) => {
			await authStorage.set(providerName, {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			});
			let projectionCount = 0;
			registry.registerProvider(
				providerName,
				{
					api: apiId,
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: `${providerName} OAuth`,
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: models => {
							projectionCount += 1;
							const seed = models.find(model => model.provider === providerName) as Model<Api>;
							return [...models, { ...seed, id: `extra-${projectionCount}` }];
						},
					},
				},
				"ext://oauth",
			);
		};

		await registerAppending("appending-first", "custom-appending-first-api");
		expect(getProviderModels(registry, "appending-first").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registerAppending("appending-second", "custom-appending-second-api");
		// Catalog changes rerun whole-catalog hooks, but each run must start from
		// the unprojected snapshot rather than accumulating prior output.
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registry.refresh("offline");
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second")).toHaveLength(2);
	});

	test("provider-scoped lookups preserve whole-catalog modifyModels projections", async () => {
		const hiddenModel = registry.getAll().find(model => model.provider === "anthropic");
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== hiddenModel?.provider || model.id !== hiddenModel.id),
				},
			},
			"ext://oauth",
		);

		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		const refreshPromise = registry.refresh("offline");
		// While refresh is awaiting discovery, lookup takes the provider-scoped composition path.
		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		await refreshPromise;
		expect(
			registry.getAll().find(model => model.provider === hiddenModel!.provider && model.id === hiddenModel!.id),
		).toBeUndefined();
	});

	test("provider-scoped lookups do not intern other providers' transient projections", async () => {
		const anthropicId = registry.getAll().find(model => model.provider === "anthropic")?.id;
		await authStorage.set("changing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		let projectionCount = 0;
		registry.registerProvider(
			"changing-provider",
			{
				api: "custom-changing-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Changing OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						return models.map(model =>
							model.provider === "changing-provider"
								? { ...model, name: `projection-${projectionCount}` }
								: model,
						);
					},
				},
			},
			"ext://oauth",
		);

		const refreshPromise = registry.refresh("offline");
		expect(registry.find("anthropic", anthropicId!)).toBeDefined();
		expect(registry.find("changing-provider", "runtime-model")?.name).toBe("projection-3");
		await refreshPromise;
	});

	test("registering another provider reapplies whole-catalog modifyModels projections", async () => {
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => models.filter(model => model.provider !== "later-provider"),
				},
			},
			"ext://oauth",
		);

		registry.registerProvider(
			"later-provider",
			{
				api: "custom-later-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				apiKey: "RUNTIME_KEY",
				models: [baseModel],
			},
			"ext://runtime",
		);

		expect(getProviderModels(registry, "later-provider")).toEqual([]);
	});

	test("runtime transport overrides reapply whole-catalog modifyModels projections", async () => {
		const proxyBaseUrl = "https://proxy.example.invalid/v1";
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== "anthropic" || model.baseUrl !== proxyBaseUrl),
				},
			},
			"ext://oauth",
		);
		expect(getProviderModels(registry, "anthropic").length).toBeGreaterThan(0);

		registry.registerProvider("anthropic", { baseUrl: proxyBaseUrl }, "ext://runtime");

		expect(getProviderModels(registry, "anthropic")).toEqual([]);
	});

	test("online discovery reapplies modifiers to an unprojected full catalog", async () => {
		const target = registry.getAll().find(model => model.provider === "anthropic");
		await authStorage.set("renaming-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"renaming-provider",
			{
				api: "custom-renaming-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Renaming OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.map(model =>
							model.provider === target?.provider && model.id === target.id
								? { ...model, name: `${model.name} projected` }
								: model,
						),
				},
			},
			"ext://oauth",
		);
		registry.registerProvider(
			"dynamic-provider",
			{
				api: "custom-dynamic-api",
				baseUrl: "https://example.invalid/",
				apiKey: "RUNTIME_KEY",
				streamSimple,
				fetchDynamicModels: async () => [{ ...baseModel, id: "dynamic-model" }],
			},
			"ext://runtime",
		);

		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
	});

	test("a modifyModels that mutates in place then throws cannot corrupt the catalog", async () => {
		await authStorage.set("mutating-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			const targetBefore = registry.getAll()[0];
			const targetSnapshot = structuredClone(targetBefore!);
			const anthropicBefore = registry.getAll().filter(model => model.provider === "anthropic").length;
			expect(anthropicBefore).toBeGreaterThan(0);

			registry.registerProvider(
				"mutating-provider",
				{
					api: "custom-mutating-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Mutating OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						// Corrupts a model record and its nested cost, wipes the array,
						// then fails. None of those mutations may reach the canonical
						// unprojected catalog used for fallback or later refreshes.
						modifyModels: models => {
							models[0]!.name = "Corrupted by failing hook";
							models[0]!.cost.input = -1;
							models.length = 0;
							throw new Error("mutated then failed");
						},
					},
				},
				"ext://oauth",
			);

			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "anthropic")).toHaveLength(anthropicBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);

			await registry.refresh("offline");
			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "anthropic")).toHaveLength(anthropicBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);
		} finally {
			warn.mockRestore();
		}
	});

	test("disabled extension provider is excluded from runtime discovery fetches", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { disabledProviders: ["disabled-runtime-provider"] } });

		let discoveryCalls = 0;
		const disabledRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		disabledRegistry.registerProvider(
			"disabled-runtime-provider",
			{
				baseUrl: "https://disabled.example.com/v1",
				auth: "none",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return [{ ...baseModel, id: "disabled-model" }];
				},
			},
			"ext://runtime",
		);

		await disabledRegistry.refreshRuntimeProviders("online");
		// A disabled extension provider must not be fetched by the background
		// refresh: getAvailable()/getDiscoverableProviders() already shadow it out,
		// so the requiresAuth gate must skip it too (mirrors #discoverableProviders
		// filtering in #refreshRuntimeDiscoveries).
		expect(discoveryCalls).toBe(0);
		expect(disabledRegistry.find("disabled-runtime-provider", "disabled-model")).toBeUndefined();
		expect(disabledRegistry.getAvailable().some(model => model.provider === "disabled-runtime-provider")).toBe(false);
	});

	test("runtime provider restorableHeaderFallback preserves headers across cache round-trip", async () => {
		const providerName = "header-restore-provider";
		const dynamicModels = async () => [{ ...baseModel, id: "header-model" }];
		const cacheDbPath = path.join(tempDir, "model-cache.db");

		// Seed the SQLite discovery cache with one live fetch. The provider declares
		// a constant header that must survive a cache write (cache rows never persist
		// headers) and be reattached on the cache-served read via restorableHeaderFallback.
		const first = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		first.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "none",
				api: "openai-completions",
				headers: { "X-Custom-Auth": "secret-token" },
				fetchDynamicModels: dynamicModels,
			},
			"ext://runtime",
		);
		await first.refreshRuntimeProviders("online");
		expect(first.find(providerName, "header-model")?.headers?.["X-Custom-Auth"]).toBe("secret-token");

		// A fresh registry over the same cache: without the restorable fallback the
		// header-bearing model would be flagged unrestorable and dropped on the
		// offline-style read. With it, the constant header is reattached by value.
		let discoveryCalls = 0;
		const second = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch, cacheDbPath });
		second.registerProvider(
			providerName,
			{
				baseUrl: "https://default.example.com/v1",
				auth: "none",
				api: "openai-completions",
				headers: { "X-Custom-Auth": "secret-token" },
				fetchDynamicModels: async () => {
					discoveryCalls++;
					return dynamicModels();
				},
			},
			"ext://runtime",
		);
		await second.refreshRuntimeProviders("online-if-uncached");
		expect(discoveryCalls).toBe(0);
		expect(second.find(providerName, "header-model")?.headers?.["X-Custom-Auth"]).toBe("secret-token");
	});
});
