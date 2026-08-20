import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry as ModelRegistryImpl } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("issue #9112 authHeader + discovery: provider survives cache startup", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let authStorage2: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-9112-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage2 = await AuthStorage.create(path.join(tempDir, "auth2.db"));
	});

	afterEach(() => {
		authStorage.close();
		authStorage2.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("restores authHeader discovery models from cache without a network call", async () => {
		// Write a models.yml with authHeader: true + discovery:
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  probe:",
				"    baseUrl: http://probe.invalid/v1",
				"    api: openai-completions",
				"    apiKey: static-test-key",
				"    authHeader: true",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		// --- First registry: online refresh writes the cache ---
		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			_init,
		) => {
			const url = String(input);
			if (url !== "http://probe.invalid/v1/models") {
				throw new Error(`Unexpected URL in first registry: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry1 = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry1.refreshProvider("probe");

		const firstModels = registry1.getAll().filter(m => m.provider === "probe");
		expect(firstModels.map(m => m.id).sort()).toEqual(["alpha", "beta"]);
		// Headers must carry the auth key on the live registry
		for (const m of firstModels) {
			expect((m.headers as Record<string, string>)?.Authorization).toBe("Bearer static-test-key");
		}

		// --- Second registry: cold start — must load from cache, network must NOT be called ---
		const neverFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			_init,
		) => {
			throw new Error(`Network must not be called in second registry; got: ${String(input)}`);
		};

		const registry2 = new ModelRegistryImpl(authStorage2, modelsPath, { fetch: neverFetch });
		// Do NOT call refreshProvider — we want what the constructor loaded from cache.

		// This is the new-behavior assertion: must fail before the fix with empty list.
		const cachedModels = registry2.getAll().filter(m => m.provider === "probe");
		expect(cachedModels.map(m => m.id).sort()).toEqual(["alpha", "beta"]);
		for (const m of cachedModels) {
			expect((m.headers as Record<string, string>)?.Authorization).toBe("Bearer static-test-key");
		}
	});
});
