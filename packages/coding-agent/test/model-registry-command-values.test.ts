import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function stdoutCommand(value: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

describe("ModelRegistry command-resolved models.yml values", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-values-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("provider apiKey and headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						headers: { "X-Api-Key": `!${stdoutCommand("cmd-header")}` },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const models = registry.getAll().filter(model => model.provider === "anthropic");

		expect(models.length).toBeGreaterThan(1);
		for (const model of models) {
			expect(model.headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(model.headers?.["X-Api-Key"]).toBe("cmd-header");
		}
		expect(await registry.getApiKey(models[0])).toBe("cmd-api-key");
	});

	test("modelOverrides headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "X-Model-Key": `!${stdoutCommand("cmd-model-header")}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");

		expect(model).toBeDefined();
		expect(model?.headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(model?.headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("resolveCommandConfig caches failed executions so they do not retry", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "0");

		// Command increments a counter and then fails (exit 1).
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Init triggers the first command resolution.
		const registry = new ModelRegistry(authStorage, modelsPath);

		const dummyModel: Model<Api> = buildModel({
			id: "foo",
			name: "foo",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "a",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});

		// Trigger the fallback resolver which also calls resolveConfigValue.
		await registry.getApiKey(dummyModel);

		// Another call to ensure it hits cache multiple times.
		await registry.getApiKey(dummyModel);

		// The command should have only run once.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("resolveCommandConfig retries failed executions after TTL", async () => {
		let mockTime = 1000000;
		const dateSpy = spyOn(Date, "now").mockImplementation(() => mockTime);

		try {
			const counterFile = path.join(tempDir, "counter_ttl.txt");
			fs.writeFileSync(counterFile, "0");

			const stateFile = path.join(tempDir, "state_ttl.txt");
			if (fs.existsSync(stateFile)) {
				fs.unlinkSync(stateFile);
			}

			// A node script that fails on the first run, and succeeds on the second run, writing the counter
			const failThenSucceedCommand = `node -e "const fs=require('fs'); const cFile='${counterFile.replace(/\\/g, "/")}'; const sFile='${stateFile.replace(/\\/g, "/")}'; fs.writeFileSync(cFile, String(Number(fs.readFileSync(cFile, 'utf8')) + 1)); let s=''; try { s=fs.readFileSync(sFile, 'utf8').trim(); } catch (e) {} if (s==='success') { process.stdout.write('resolved-success-value'); process.exit(0); } else { fs.writeFileSync(sFile, 'success'); process.exit(1); }"`;

			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"custom-proxy": {
							baseUrl: "https://custom-proxy.example.com/v1",
							api: "openai-completions",
							apiKey: `!${failThenSucceedCommand}`,
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsPath);

			const dummyModel: Model<Api> = buildModel({
				id: "foo",
				name: "foo",
				api: "openai-completions",
				provider: "custom-proxy",
				baseUrl: "a",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			});

			// First resolution: command fails, returns undefined.
			const key1 = await registry.getApiKey(dummyModel);
			expect(key1).toBeUndefined();
			expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

			// Second resolution (within TTL): command should not re-execute, returns undefined.
			const key2 = await registry.getApiKey(dummyModel);
			expect(key2).toBeUndefined();
			expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

			// Advance time past COMMAND_FAILURE_RETRY_MS (30_000 ms)
			mockTime += 30001;

			// Third resolution (past TTL): command re-runs, succeeds, returns cached value.
			const key3 = await registry.getApiKey(dummyModel);
			expect(key3).toBe("resolved-success-value");
			expect(fs.readFileSync(counterFile, "utf8")).toBe("2");

			// Fourth resolution (cached success): returns immediately without running the command.
			const key4 = await registry.getApiKey(dummyModel);
			expect(key4).toBe("resolved-success-value");
			expect(fs.readFileSync(counterFile, "utf8")).toBe("2");
		} finally {
			dateSpy.mockRestore();
		}
	});
});
