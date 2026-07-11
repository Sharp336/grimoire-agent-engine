import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isOAuthCredentialResolver, resolveApiKeyOnce } from "@oh-my-pi/pi-ai";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
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

	test("OAuth-only providers ignore command keys and mint provider-bound resolvers", async () => {
		const counterFile = path.join(tempDir, "oauth-command-counter.txt");
		fs.writeFileSync(counterFile, "0");
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', '1'); process.stdout.write('forbidden')"`;
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"xai-grok-build": {
						baseUrl: "https://cli-chat-proxy.grok.com/v1",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);
		await authStorage.set("xai-grok-build", [
			{
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.getAll().find(candidate => candidate.provider === "xai-grok-build");
		expect(model).toBeDefined();
		if (!model) throw new Error("Build model missing");
		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(await registry.getApiKey(model)).toBe("oauth-access");
		const resolver = registry.resolver(model, "session");
		expect(isOAuthCredentialResolver(resolver, "xai-grok-build")).toBe(true);
		expect(await resolveApiKeyOnce(resolver)).toBe("oauth-access");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("0");
	});

	test("auth:none does not make OAuth-only Build keyless", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"xai-grok-build": {
						baseUrl: "https://cli-chat-proxy.grok.com/v1",
						api: "openai-responses",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
					"normal-keyless": {
						baseUrl: "https://normal-keyless.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
						models: [{ id: "normal-keyless-model", name: "Normal keyless" }],
					},
				},
			}),
		);
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "https://normal-keyless.example.com/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "normal-keyless-model" }] }));
			}
			throw new Error(`Unexpected discovery request: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		const buildModel = registry.getAll().find(model => model.provider === "xai-grok-build");
		const normalKeylessModel = registry.find("normal-keyless", "normal-keyless-model");
		if (!buildModel || !normalKeylessModel) throw new Error("Expected configured models");

		expect(registry.getAvailable()).not.toContainEqual(buildModel);
		expect(registry.hasConfiguredAuth(buildModel)).toBe(false);
		expect(await registry.getApiKey(buildModel)).toBeUndefined();
		await registry.refreshProvider("xai-grok-build");
		expect(registry.getProviderDiscoveryState("xai-grok-build")?.status).toBe("unauthenticated");

		await registry.refreshProvider("normal-keyless");
		expect(requestedUrls).toEqual(["https://normal-keyless.example.com/v1/models"]);
		expect(
			registry.getAvailable().some(
				model => model.provider === "normal-keyless" && model.id === "normal-keyless-model",
			),
		).toBe(true);
		expect(registry.hasConfiguredAuth(normalKeylessModel)).toBe(true);
		expect(await registry.getApiKey(normalKeylessModel)).toBe(kNoAuth);
	});
});
