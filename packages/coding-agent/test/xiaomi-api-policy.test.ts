import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Model, writeModelCache } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("Xiaomi API policy", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-xiaomi-api-policy-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(async () => {
		resetSettingsForTest();
		authStorage.close();
		await removeTempDir(tempDir);
	});

	function writeXiaomiModel(baseUrl: string, id: string): void {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					xiaomi: {
						baseUrl,
						apiKey: "TEST_KEY",
						api: "anthropic-messages",
						models: [
							{
								id,
								name: id,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 100000,
								maxTokens: 8000,
							},
						],
					},
				},
			}),
		);
	}

	function writeDiscoverableOpenAIProvider(provider: string, baseUrl: string): void {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl,
						apiKey: "TEST_KEY",
						api: "openai-completions",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
	}

	test("preserves explicit plain Xiaomi /v1 custom Anthropic models", () => {
		writeXiaomiModel("https://api.xiaomimimo.com/v1", "mimo-openai-root");

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("xiaomi", "mimo-openai-root");

		expect(model?.api).toBe("anthropic-messages");
	});

	test("preserves explicit nested Anthropic /v1 custom models", () => {
		writeXiaomiModel("https://api.xiaomimimo.com/anthropic/v1", "mimo-anthropic-root");

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("xiaomi", "mimo-anthropic-root");

		expect(model?.api).toBe("anthropic-messages");
	});

	test("rewrites stale cached plain Xiaomi /v1 entries to OpenAI completions", () => {
		writeModelCache(
			"xiaomi",
			Date.now(),
			[xiaomiCachedModel("https://api.xiaomimimo.com/v1")],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("xiaomi", "mimo-cached");

		expect(model?.api).toBe("openai-completions");
	});

	test("applies hardcoded policies to cached standard provider models", () => {
		writeModelCache(
			"openai",
			Date.now(),
			[cachedGpt54Model("openai", "https://api.openai.com/v1", 200000)],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-5.4");

		expect(model?.contextWindow).toBe(1_000_000);
	});

	test("applies hardcoded policies to cached discoverable provider models", () => {
		writeDiscoverableOpenAIProvider("custom-local", "https://models.example.com/v1");
		writeModelCache(
			"custom-local",
			Date.now(),
			[cachedGpt54Model("custom-local", "https://models.example.com/v1", 200000)],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("custom-local", "gpt-5.4");

		expect(model?.contextWindow).toBe(1_000_000);
	});
});

function xiaomiCachedModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "mimo-cached",
		name: "MiMo cached",
		api: "anthropic-messages",
		provider: "xiaomi",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8000,
	};
}

function cachedGpt54Model(provider: string, baseUrl: string, contextWindow: number): Model<"openai-completions"> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 128000,
	};
}

async function removeTempDir(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true });
			}
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EBUSY" && attempt === 4) {
				return;
			}
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") {
				throw error;
			}
			await Bun.sleep(25);
		}
	}
}
