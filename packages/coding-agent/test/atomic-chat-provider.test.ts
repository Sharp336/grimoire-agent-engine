import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry Atomic Chat provider", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-atomic-chat-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("auto-discovers atomic-chat models from the default local API", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url.includes(":1337/v1/models")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "gemma-local" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const allModels = registry.getAll();
		expect(allModels.some(m => m.provider === "atomic-chat" && m.id === "gemma-local")).toBe(true);

		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "atomic-chat")).toBe(true);
	});

	test("ATOMIC_CHAT_BASE_URL overrides the implicit discovery endpoint", async () => {
		const originalBaseUrl = Bun.env.ATOMIC_CHAT_BASE_URL;
		Bun.env.ATOMIC_CHAT_BASE_URL = "http://127.0.0.1:7337/v1";
		let requestedUrl = "";
		try {
			const fetchMock: FetchImpl = input => {
				const url = String(input);
				if (url.includes(":7337/v1/models")) {
					requestedUrl = url;
					return Promise.resolve(
						new Response(JSON.stringify({ data: [{ id: "qwen-local" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return Promise.resolve(new Response(null, { status: 404 }));
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh();

			expect(requestedUrl).toBe("http://127.0.0.1:7337/v1/models");
			expect(registry.getAll().some(m => m.provider === "atomic-chat" && m.id === "qwen-local")).toBe(true);
		} finally {
			if (originalBaseUrl === undefined) {
				delete Bun.env.ATOMIC_CHAT_BASE_URL;
			} else {
				Bun.env.ATOMIC_CHAT_BASE_URL = originalBaseUrl;
			}
		}
	});
});
