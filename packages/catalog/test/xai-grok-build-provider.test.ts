import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/reference";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	buildXaiGrokBuildStaticSeed,
	buildXaiOAuthStaticSeed,
	xaiGrokBuildModelManagerOptions,
	xaiOAuthModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const BUILD_IDS = ["grok-4.5", "grok-composer-2.5-fast"];

function paidReference(id: string): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
	});
}

describe("xAI Grok Build catalog provider", () => {
	test("rejects custom discovery origins before exposing the Build token", () => {
		const token = "sentinel-build-token";
		const requests: Array<{ url: string; headers: Headers }> = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
			return Response.json({ data: [] });
		};

		expect(() =>
			xaiGrokBuildModelManagerOptions({
				apiKey: token,
				baseUrl: "https://attacker.example/v1",
				fetch,
			}),
		).toThrow(/canonical.*Build|Build.*canonical/i);
		expect(requests).toEqual([]);
		expect(JSON.stringify(requests)).not.toContain(token);
	});

	test("registers an OAuth-only-discovery descriptor with the two-model offline fallback", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "xai-grok-build");
		const seed = buildXaiGrokBuildStaticSeed();

		expect(descriptor?.defaultModel).toBe("grok-4.5");
		expect(descriptor?.catalogDiscovery).toEqual({
			label: "xAI Grok Build",
			oauthProvider: "xai-grok-build",
			envVars: [],
		});
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["xai-grok-build"]).toBe("grok-4.5");
		expect(seed.map(model => model.id)).toEqual(BUILD_IDS);
		expect(seed).toMatchObject([
			{
				provider: "xai-grok-build",
				baseUrl: "https://cli-chat-proxy.grok.com/v1",
				name: "Grok 4.5",
				contextWindow: 500_000,
				maxTokens: 500_000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				provider: "xai-grok-build",
				name: "Grok Composer 2.5 Fast",
				contextWindow: 200_000,
				maxTokens: 200_000,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
		const built = buildModel(seed[0] as ModelSpec<"openai-responses">);
		expect(built.compat).toMatchObject({
			supportsReasoningEffort: true,
			supportsImageDetailOriginal: false,
			includeEncryptedReasoning: false,
			filterReasoningHistory: true,
			promptCacheSessionHeader: "x-grok-conv-id",
		});
	});

	test("authenticated discovery replaces fallback, filters non-chat ids, and overlays matching metadata", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
			return Response.json({
				data: [
					{ id: "grok-4.5", name: "server label" },
					{ id: "grok-new-chat", name: "Grok New Chat" },
					{ id: "grok-imagine-image" },
					{ id: "grok-voice-live" },
					{ id: "grok-stt-transcribe" },
				],
			});
		};
		const options = xaiGrokBuildModelManagerOptions({ apiKey: "build-token", fetch });
		const models = await options.fetchDynamicModels?.();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer build-token");
		expect(requests[0]?.headers.get("user-agent")).toBe("grok-shell/0.2.93 (linux; x86_64)");
		expect(requests[0]?.headers.get("x-grok-client-identifier")).toBe("grok-shell");
		expect(requests[0]?.headers.get("x-grok-client-version")).toBe("0.2.93");
		expect(requests[0]?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(models?.map(model => model.id)).toEqual(["grok-4.5", "grok-new-chat"]);
		expect(models?.[0]).toMatchObject({
			name: "Grok 4.5",
			contextWindow: 500_000,
			maxTokens: 500_000,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(models?.[1]).toMatchObject({
			name: "Grok New Chat",
			provider: "xai-grok-build",
			reasoning: false,
			input: ["text"],
		});
		expect(models?.some(model => model.id === "grok-composer-2.5-fast")).toBe(false);
	});

	test("network, invalid JSON, and empty discovery preserve the static fallback contract", async () => {
		const failures: FetchImpl[] = [
			async () => {
				throw new Error("offline");
			},
			async () => new Response("not json", { status: 200 }),
			async () => Response.json({ data: [] }),
		];

		for (const fetch of failures) {
			const options = xaiGrokBuildModelManagerOptions({ apiKey: "build-token", fetch });
			const dynamic = await options.fetchDynamicModels?.();
			expect(dynamic).toBeNull();
			expect(options.staticModels?.map(model => model.id)).toEqual(BUILD_IDS);
			expect(options.dynamicModelsAuthoritative).toBe(true);
		}

		const cacheDbPath = `/tmp/xai-grok-build-catalog-${crypto.randomUUID()}.db`;
		try {
			const manager = createModelManager({
				...xaiGrokBuildModelManagerOptions({
					apiKey: "build-token",
					fetch: async () => Response.json({ data: [] }),
				}),
				cacheDbPath,
			});
			const result = await manager.refresh("online");
			expect(result.models.map(model => model.id)).toEqual(BUILD_IDS);
			expect(result.stale).toBe(true);
		} finally {
			await Promise.all(
				[cacheDbPath, `${cacheDbPath}-shm`, `${cacheDbPath}-wal`].map(path =>
					Bun.file(path)
						.delete()
						.catch(() => {}),
				),
			);
		}
	});

	test("non-chat-only authoritative discovery clears the static fallback", async () => {
		const cacheDbPath = `/tmp/xai-grok-build-catalog-${crypto.randomUUID()}.db`;
		try {
			const manager = createModelManager({
				...xaiGrokBuildModelManagerOptions({
					apiKey: "build-token",
					fetch: async () =>
						Response.json({
							data: [{ id: "grok-imagine-image" }, { id: "grok-voice-live" }, { id: "grok-stt-transcribe" }],
						}),
				}),
				cacheDbPath,
			});
			const result = await manager.refresh("online");
			expect(result.models).toEqual([]);
			expect(result.stale).toBe(false);
		} finally {
			await Promise.all(
				[cacheDbPath, `${cacheDbPath}-shm`, `${cacheDbPath}-wal`].map(path =>
					Bun.file(path)
						.delete()
						.catch(() => {}),
				),
			);
		}
	});

	test("Build subscription entries cannot become paid/public Grok references", () => {
		const paid = paidReference("grok-4.5");
		const build = buildModel(buildXaiGrokBuildStaticSeed()[0] as ModelSpec<"openai-responses">);
		const index = buildModelReferenceIndex([build, paid]);
		expect(index.exact.get("grok-4.5")).toBe(paid);
	});

	test("preserves xai-oauth seed and inject-on-success behavior", async () => {
		const seed = buildXaiOAuthStaticSeed();
		const options = xaiOAuthModelManagerOptions({
			apiKey: "oauth-token",
			fetch: async () => Response.json({ data: [{ id: "grok-4.5" }] }),
		});
		const dynamic = await options.fetchDynamicModels?.();

		expect(seed.map(model => model.id)).toEqual([
			"grok-build",
			"grok-build-0.1",
			"grok-4.3",
			"grok-4.5",
			"grok-4.20-multi-agent-0309",
			"grok-4.20-0309-reasoning",
			"grok-4.20-0309-non-reasoning",
			"grok-composer-2.5-fast",
		]);
		expect(dynamic?.map(model => model.id)).toEqual(seed.map(model => model.id));
		expect(options.providerId).toBe("xai-oauth");
	});
});
