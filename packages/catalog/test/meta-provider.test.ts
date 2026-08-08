import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { META_MUSE_STATIC_MODELS, metaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MUSE_SPARK_THINKING = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
} as const;

const META_RESPONSES_COMPAT = {
	supportsReasoningEffort: true,
	includeEncryptedReasoning: true,
} as const;

describe("Meta Model API provider", () => {
	test("ships every Muse Spark model with its documented Responses capabilities", () => {
		expect(META_MUSE_STATIC_MODELS).toEqual([
			{
				id: "muse-spark-1.1",
				name: "Muse Spark 1.1",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: MUSE_SPARK_THINKING,
				compat: META_RESPONSES_COMPAT,
			},
			{
				id: "muse-spark-1.2",
				name: "Muse Spark 1.2",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: MUSE_SPARK_THINKING,
				compat: META_RESPONSES_COMPAT,
			},
			{
				id: "muse-spark-1.2-contributor",
				name: "Muse Spark 1.2 Contributor",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: MUSE_SPARK_THINKING,
				compat: META_RESPONSES_COMPAT,
			},
		]);

		const options = metaModelManagerOptions();
		expect(options.providerId).toBe("meta");
		expect(options.staticModels).toEqual(META_MUSE_STATIC_MODELS);
	});

	test("keeps curated Muse Spark 1.2 metadata when discovery returns only model ids", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-meta-"));
		const fetchImpl: FetchImpl = async () =>
			Response.json({ data: [{ id: "muse-spark-1.2" }, { id: "muse-spark-1.2-contributor" }] });

		try {
			const result = await resolveProviderModels(
				{
					...metaModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl }),
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);
			const expectedIds = new Set(["muse-spark-1.2", "muse-spark-1.2-contributor"]);
			const variants = result.models.filter(model => expectedIds.has(model.id));

			expect(variants).toHaveLength(2);
			expect(variants).toEqual([
				expect.objectContaining({
					id: "muse-spark-1.2",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
					contextWindow: 1_048_576,
					maxTokens: 131_072,
					thinking: MUSE_SPARK_THINKING,
					compat: expect.objectContaining(META_RESPONSES_COMPAT),
				}),
				expect.objectContaining({
					id: "muse-spark-1.2-contributor",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
					contextWindow: 1_048_576,
					maxTokens: 131_072,
					thinking: MUSE_SPARK_THINKING,
					compat: expect.objectContaining(META_RESPONSES_COMPAT),
				}),
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses Muse Spark 1.2 by default and accepts both Meta API key names", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "meta");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.2",
			envVars: ["MODEL_API_KEY", "META_API_KEY"],
			catalogDiscovery: { label: "Meta Model API" },
		});
	});
});
