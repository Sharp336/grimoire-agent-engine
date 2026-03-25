import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage } from "../src/auth-storage";
import { buildAnthropicClientOptions } from "../src/providers/anthropic";
import type { Model } from "../src/types";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) {
		previous.set(key, Bun.env[key]);
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

describe("Anthropic proxy auth behavior", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("uses ANTHROPIC_BASE_URL for normal Anthropic requests and strips a trailing /v1", async () => {
		await withEnv(
			{
				ANTHROPIC_BASE_URL: "http://127.0.0.1:8080/v1/",
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "btr-proxy-key",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("http://127.0.0.1:8080");
				expect(options.apiKey).toBe("btr-proxy-key");
				expect(options.authToken).toBeUndefined();
				expect(options.defaultHeaders.Authorization).toBeUndefined();
				expect(options.defaultHeaders["X-Api-Key"]).toBe("btr-proxy-key");
			},
		);
	});

	it("prefers ANTHROPIC_API_KEY over stored OAuth when proxying Anthropic through a custom base URL", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-anthropic-proxy-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "sk-ant-oat-db-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
			},
		]);

		await withEnv(
			{
				ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
				ANTHROPIC_API_KEY: "btr-env-proxy-key",
				ANTHROPIC_OAUTH_TOKEN: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
			},
			async () => {
				const apiKey = await authStorage?.getApiKey("anthropic", "proxy-session", {
					baseUrl: ANTHROPIC_MODEL.baseUrl,
					modelId: ANTHROPIC_MODEL.id,
				});

				expect(apiKey).toBe("btr-env-proxy-key");
			},
		);
	});

	it("prefers ANTHROPIC_API_KEY for custom proxy model base URLs even when ANTHROPIC_BASE_URL is blank", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-anthropic-proxy-blank-env-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "sk-ant-oat-db-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
			},
		]);

		await withEnv(
			{
				ANTHROPIC_BASE_URL: "",
				ANTHROPIC_API_KEY: "btr-env-proxy-key",
				ANTHROPIC_OAUTH_TOKEN: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
			},
			async () => {
				const apiKey = await authStorage?.getApiKey("anthropic", "proxy-session-blank-env", {
					baseUrl: "http://127.0.0.1:8080",
					modelId: ANTHROPIC_MODEL.id,
				});

				expect(apiKey).toBe("btr-env-proxy-key");
			},
		);
	});

	it("keeps stored OAuth precedence when no custom Anthropic proxy base URL is configured", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-anthropic-direct-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "sk-ant-oat-db-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
			},
		]);

		await withEnv(
			{
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_API_KEY: "sk-ant-api-env",
				ANTHROPIC_OAUTH_TOKEN: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
			},
			async () => {
				const apiKey = await authStorage?.getApiKey("anthropic", "direct-session", {
					baseUrl: ANTHROPIC_MODEL.baseUrl,
					modelId: ANTHROPIC_MODEL.id,
				});

				expect(apiKey).toBe("sk-ant-oat-db-token");
			},
		);
	});
});
