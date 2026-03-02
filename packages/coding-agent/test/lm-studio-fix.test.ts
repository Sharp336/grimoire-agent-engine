import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_LOCAL_TOKEN } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("LM Studio Fix", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-lm-studio-fix-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("discovery does NOT send Authorization header for default local token", async () => {
		// Mock local token in auth storage (as if user ran /login lm-studio and stayed with default)
		await authStorage.set("lm-studio", { type: "api_key", key: DEFAULT_LOCAL_TOKEN });

		const originalFetch = globalThis.fetch;
		let capturedHeaders: Headers | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/models")) {
				capturedHeaders = new Headers(init?.headers);
				return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/tags")) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!.has("Authorization")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("discovery DOES send Authorization header for custom token", async () => {
		const customKey = "sk-custom-lm-studio-key";
		await authStorage.set("lm-studio", { type: "api_key", key: customKey });

		const originalFetch = globalThis.fetch;
		let capturedHeaders: Headers | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/models")) {
				capturedHeaders = new Headers(init?.headers);
				return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/tags")) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!.get("Authorization")).toBe(`Bearer ${customKey}`);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("getApiKey returns stored key even if env var is missing", async () => {
		const customKey = "sk-stored-key";
		await authStorage.set("lm-studio", { type: "api_key", key: customKey });

		// Ensure env var is NOT set
		const originalEnv = process.env.LM_STUDIO_API_KEY;
		delete process.env.LM_STUDIO_API_KEY;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/models")) {
				return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/tags")) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			// Trigger implicit discovery
			await registry.refresh();

			const models = registry.getAll().filter(m => m.provider === "lm-studio");
			expect(models.length).toBeGreaterThan(0);

			const apiKey = await registry.getApiKey(models[0]);
			expect(apiKey).toBe(customKey);
		} finally {
			globalThis.fetch = originalFetch;
			process.env.LM_STUDIO_API_KEY = originalEnv;
		}
	});
});
