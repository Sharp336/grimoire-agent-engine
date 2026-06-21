import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ModelsConfigResponse, readAuthBrokerCatalogCache, writeAuthBrokerCatalogCache } from "@oh-my-pi/pi-ai";

const TOKEN = "broker-catalog-token";
const URL = "http://127.0.0.1:8765";

function makeCatalog(generatedAt: number): ModelsConfigResponse {
	return {
		generatedAt,
		schemaVersion: 1,
		providers: {
			acme: {
				baseUrl: "https://acme.example/v1",
				api: "openai-completions",
				models: [{ id: "acme-chat" }],
			},
		},
	};
}

async function withCachePath(run: (cachePath: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-catalog-cache-"));
	try {
		await run(path.join(tempDir, "catalog.enc"));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("auth-broker catalog cache", () => {
	test("round-trips an encrypted catalog and writes mode 0600", async () => {
		await withCachePath(async cachePath => {
			const catalog = makeCatalog(1_000_000);
			await writeAuthBrokerCatalogCache({ path: cachePath, token: TOKEN, url: URL, catalog });

			const stat = await fs.stat(cachePath);
			expect(stat.mode & 0o777).toBe(0o600);
			const payload = await fs.readFile(cachePath);
			expect(new TextDecoder().decode(payload)).not.toContain("acme-chat");

			const decoded = await readAuthBrokerCatalogCache({
				path: cachePath,
				token: TOKEN,
				url: URL,
				ttlMs: 60_000,
				now: () => 1_001_000,
			});
			expect(decoded).toEqual(catalog);
		});
	});

	test("rejects mismatched binding, expired, and schema-invalid cache files", async () => {
		await withCachePath(async cachePath => {
			const catalog = makeCatalog(10_000);
			await writeAuthBrokerCatalogCache({ path: cachePath, token: TOKEN, url: URL, catalog });

			expect(
				await readAuthBrokerCatalogCache({
					path: cachePath,
					token: "wrong",
					url: URL,
					ttlMs: 60_000,
					now: () => 10_001,
				}),
			).toBeNull();
			expect(
				await readAuthBrokerCatalogCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 100,
					now: () => 10_101,
				}),
			).toBeNull();

			await writeAuthBrokerCatalogCache({
				path: cachePath,
				token: TOKEN,
				url: URL,
				catalog: { generatedAt: 10_000 } as unknown as ModelsConfigResponse,
			});
			expect(
				await readAuthBrokerCatalogCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 10_001,
				}),
			).toBeNull();
		});
	});
});
