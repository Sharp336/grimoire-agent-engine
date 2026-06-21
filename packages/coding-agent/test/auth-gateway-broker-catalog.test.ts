import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ModelsConfigResponse, SnapshotResponse } from "@oh-my-pi/pi-ai";
import {
	buildGatewayModelIndex,
	isGatewayCatalogBaseUrlAllowed,
	refreshGatewayCatalogIndex,
	startGatewayCatalogPolling,
} from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

const REFRESHER = {
	enabled: false,
	intervalMs: 0,
	skewMs: 0,
	nextSweepInMs: Number.MAX_SAFE_INTEGER,
};

function snapshot(providers: string[]): SnapshotResponse {
	return {
		generation: 1,
		generatedAt: 100,
		serverNowMs: 100,
		refresher: REFRESHER,
		credentials: providers.map((provider, index) => ({
			id: index + 1,
			provider,
			credential: { type: "api_key", key: `${provider}-key` },
			identityKey: null,
			rotatesInMs: null,
		})),
	};
}

function catalog(providers: ModelsConfigResponse["providers"]): ModelsConfigResponse {
	return {
		generatedAt: 200,
		schemaVersion: 1,
		providers,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("auth-gateway broker-served catalog", () => {
	test("adds enabled broker catalog models for credentialed and keyless providers", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					headers: { "X-Team": "platform" },
					models: [{ id: "custom-chat", name: "Custom Chat" }],
				},
				keyless: {
					baseUrl: "https://keyless.example/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "free-chat" }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		const credentialed = index.byId.get("acme/custom-chat");
		expect(credentialed?.provider).toBe("acme");
		expect(credentialed?.baseUrl).toBe("https://acme.example/v1");
		expect(credentialed?.headers).toEqual({ "X-Team": "platform" });
		expect(index.byId.get("custom-chat")).toBe(credentialed);

		const keyless = index.byId.get("keyless/free-chat");
		expect(keyless?.provider).toBe("keyless");
		expect(keyless?.auth).toBe("none");
		expect(keyless ? index.models.includes(keyless) : false).toBe(true);
	});

	test("preserves broker catalog requestModelId on gateway models", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					models: [{ id: "display-model", requestModelId: "wire-model" }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(index.byId.get("acme/display-model")?.requestModelId).toBe("wire-model");
	});

	test("preserves broker catalog requestModelId when applying model overrides", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					models: [{ id: "display-model", requestModelId: "wire-model" }],
					modelOverrides: {
						"display-model": { name: "Display Override" },
					},
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(index.byId.get("acme/display-model")?.requestModelId).toBe("wire-model");
		expect(index.byId.get("acme/display-model")?.name).toBe("Display Override");
	});

	test("preserves provider disableStrictTools compat on catalog models", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					disableStrictTools: true,
					models: [{ id: "custom-chat" }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		const model = index.byId.get("acme/custom-chat");
		expect((model?.compatConfig as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
	});

	test("catalog replacements update bare aliases for bundled models", () => {
		const index = buildGatewayModelIndex(
			snapshot(["openai"]),
			catalog({
				openai: {
					baseUrl: "https://shared-openai.example/v1",
					api: "openai-completions",
					models: [{ id: "gpt-4o", headers: { "X-Shared": "1" } }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(index.byId.get("gpt-4o")?.baseUrl).toBe("https://shared-openai.example/v1");
		expect(index.byId.get("gpt-4o")?.headers?.["X-Shared"]).toBe("1");
	});

	test("allows providers that only define model-level baseUrls", () => {
		const index = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: {
					api: "openai-completions",
					models: [{ id: "east", baseUrl: "https://east.acme.example/v1" }],
				},
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(index.byId.get("acme/east")?.baseUrl).toBe("https://east.acme.example/v1");
	});

	test("ignores catalog models when disabled or baseUrl is outside the allowlist", () => {
		const response = catalog({
			acme: {
				baseUrl: "https://acme.example/v1/models",
				api: "openai-completions",
				models: [{ id: "custom-chat" }],
			},
		});

		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, { enabled: false, allowedBaseUrls: [] }).byId.has(
				"acme/custom-chat",
			),
		).toBe(false);
		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, {
				enabled: true,
				allowedBaseUrls: ["https://acme.example/v10"],
			}).byId.has("acme/custom-chat"),
		).toBe(false);
		expect(
			buildGatewayModelIndex(
				snapshot(["acme"]),
				catalog({
					acme: {
						baseUrl: "https://acme.example/v1",
						api: "openai-completions",
						models: [{ id: "override", baseUrl: "https://evil.example/v1" }],
					},
				}),
				{ enabled: true, allowedBaseUrls: ["https://acme.example/v1"] },
			).byId.has("acme/override"),
		).toBe(false);
		expect(
			buildGatewayModelIndex(snapshot(["acme"]), response, {
				enabled: true,
				allowedBaseUrls: ["https://acme.example/v1"],
			}).byId.has("acme/custom-chat"),
		).toBe(true);
	});

	test("full rebuild drops models removed from the latest catalog", () => {
		const initial = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{ id: "old" }] },
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);
		const next = buildGatewayModelIndex(
			snapshot(["acme"]),
			catalog({
				acme: { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{ id: "new" }] },
			}),
			{ enabled: true, allowedBaseUrls: [] },
		);

		expect(initial.byId.has("acme/old")).toBe(true);
		expect(next.byId.has("acme/old")).toBe(false);
		expect(next.byId.has("acme/new")).toBe(true);
	});

	test("baseUrl allowlist is URL-aware", () => {
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com/v1/models", ["https://api.example.com/v1"])).toBe(
			true,
		);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com/v10", ["https://api.example.com/v1"])).toBe(false);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com.evil.test/v1", ["https://api.example.com"])).toBe(
			false,
		);
		expect(isGatewayCatalogBaseUrlAllowed("https://api.example.com:8443/v1", ["https://api.example.com/v1"])).toBe(
			false,
		);
	});
});

test("catalog refresh rebuilds against a freshly fetched credential snapshot", async () => {
	let refreshed = false;
	let rebuiltIds: string[] = [];
	let capturedCatalog: ModelsConfigResponse | undefined;
	await refreshGatewayCatalogIndex({
		catalogConfig: { enabled: true, allowedBaseUrls: [] },
		store: {
			get snapshot() {
				return snapshot([]);
			},
			async refreshSnapshot() {
				refreshed = true;
				return snapshot(["acme"]);
			},
		},
		fetchCatalog: async () =>
			catalog({
				acme: {
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					models: [{ id: "new-model" }],
				},
			}),
		onCatalog: catalog => {
			capturedCatalog = catalog;
		},
		onModelIndex: index => {
			rebuiltIds = [...index.byId.keys()];
		},
	});

	expect(refreshed).toBe(true);
	expect(capturedCatalog?.providers.acme.models?.map(model => model.id)).toEqual(["new-model"]);
	expect(rebuiltIds).toContain("acme/new-model");
});

describe("auth-gateway catalog polling", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("refreshes the broker catalog on the configured interval", async () => {
		vi.useFakeTimers();
		let refreshes = 0;
		const stop = startGatewayCatalogPolling({
			intervalMs: 1000,
			refresh: async () => {
				refreshes += 1;
			},
		});
		try {
			expect(refreshes).toBe(0);
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(refreshes).toBe(1);
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(refreshes).toBe(2);
		} finally {
			stop?.();
		}
	});

	test("skips overlapping catalog refreshes", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		let refreshes = 0;
		const stop = startGatewayCatalogPolling({
			intervalMs: 1000,
			refresh: async () => {
				refreshes += 1;
				await pending.promise;
			},
		});
		try {
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(refreshes).toBe(1);
			vi.advanceTimersByTime(3000);
			await flushMicrotasks();
			expect(refreshes).toBe(1);
			pending.resolve();
			await flushMicrotasks();
			vi.advanceTimersByTime(1000);
			await flushMicrotasks();
			expect(refreshes).toBe(2);
		} finally {
			pending.resolve();
			stop?.();
		}
	});
});
