import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, resetModelCacheCorruptLatchForTests, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as piUtils from "@oh-my-pi/pi-utils";
import { logger } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string, name: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

describe("model cache migrations", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("invalidates and scrubs pre-v10 header-bearing cache rows", async () => {
		const legacyModel = {
			...createModel("legacy-cloud-model", "Legacy Cloud Model"),
			headers: { "X-Access-Token": "legacy-cached-secret" },
		};
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models) VALUES (?, ?, ?, ?, ?)",
			["ollama-cloud", 9, Date.now(), 1, JSON.stringify([legacyModel])],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated).toBeNull();
		expect((await fs.readFile(dbPath)).includes("legacy-cached-secret")).toBe(false);

		const replacementModel = createModel("fresh-cloud-model", "Fresh Cloud Model");
		writeModelCache("ollama-cloud", Date.now(), [replacementModel], true, "static-v3", dbPath);

		const fresh = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(fresh?.models.map(model => model.id)).toEqual(["fresh-cloud-model"]);
		expect(fresh?.staticFingerprint).toBe("static-v3");
	});

	it("omits every model header before persisting (#5780)", () => {
		const model = buildModel({
			id: "gated-model",
			name: "Gated Model",
			api: "openai-completions",
			provider: "runtime-ext",
			baseUrl: "https://ext.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
			headers: {
				Authorization: "Bearer standard-secret",
				"X-Goog-Api-Key": "google-secret",
				"X-Access-Token": "access-secret",
				"X-Project-Id": "proj-42",
			},
		});
		writeModelCache("runtime-ext", Date.now(), [model], true, "static-v1", dbPath);

		// Header names are provider-defined and any value may be a credential.
		// The plaintext SQLite payload therefore persists no model headers.
		const raw = new Database(dbPath, { readonly: true });
		const row = raw
			.query<{ models: string }, []>("SELECT models FROM model_cache WHERE provider_id = 'runtime-ext'")
			.get();
		raw.close();
		expect(row?.models).not.toContain("standard-secret");
		expect(row?.models).not.toContain("google-secret");
		expect(row?.models).not.toContain("access-secret");
		expect(row?.models).not.toContain("proj-42");

		const cached = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(cached?.models[0]?.headers).toBeUndefined();
		expect(cached?.headerOmittedModelIds).toEqual(["gated-model"]);
		expect(cached?.unrestorableHeaderModelIds).toEqual(["gated-model"]);
	});
});

async function writeMalformedCacheDb(dir: string): Promise<string> {
	const dbPath = path.join(dir, "malformed.db");
	await fs.writeFile(dbPath, "this is not a sqlite database");
	return dbPath;
}

describe("model cache corrupt-store latch", () => {
	let tempDir = "";

	beforeEach(async () => {
		resetModelCacheCorruptLatchForTests();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-corrupt-cache-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("latches after one corrupt read and stops re-opening the damaged file", async () => {
		const malformedDbPath = await writeMalformedCacheDb(tempDir);
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// First call hits the malformed file, throws SQLITE_NOTADB, and latches.
		const result1 = readModelCache("ollama-cloud", TTL_MS, Date.now, malformedDbPath);
		expect(result1).toBeNull();

		// Second call short-circuits before touching SQLite.
		const result2 = readModelCache("ollama-cloud", TTL_MS, Date.now, malformedDbPath);
		expect(result2).toBeNull();

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Model cache database is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(malformedDbPath);
	});

	it("closes the shared cache handle when the latch fires on the shared path", async () => {
		// 1. Set up a valid cache db at a temp path and route the no-dbPath
		//    calls through it so getSharedDb() assigns the shared handle.
		const validDbPath = path.join(tempDir, "shared.db");
		const pathSpy = vi.spyOn(piUtils, "getModelDbPath").mockReturnValue(validDbPath);

		// Write through the shared path — this opens and caches sharedDb.
		writeModelCache("ollama-cloud", Date.now(), [createModel("warm-model", "Warm")], true, "static-v1");
		// Confirm the shared handle is live: a read returns the cached row.
		const warm = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now);
		expect(warm?.models.map(m => m.id)).toEqual(["warm-model"]);

		// 2. Capture a real SQLITE_NOTADB error from a malformed file, then
		//    make the shared handle's next query throw it.
		const malformedDbPath = await writeMalformedCacheDb(tempDir);
		const realErr = (() => {
			const db = new Database(malformedDbPath);
			try {
				db.run("PRAGMA integrity_check");
			} catch (err) {
				return err as Error;
			} finally {
				db.close();
			}
			throw new Error("expected SQLITE_NOTADB");
		})();

		const querySpy = vi.spyOn(Database.prototype, "query").mockImplementation(() => {
			throw realErr;
		});
		const closeSpy = vi.spyOn(Database.prototype, "close");
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// 3. Drive the read again through the shared path. The shared handle's
		//    query throws SQLITE_NOTADB → latch fires → sharedDb.close() is
		//    called and sharedDb/sharedDbPath are cleared.
		const result = readModelCache("ollama-cloud", TTL_MS, Date.now);
		expect(result).toBeNull();

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Model cache database is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(validDbPath);

		// The latch closed the shared handle.
		expect(closeSpy).toHaveBeenCalled();

		// 4. Second call short-circuits via the latch — query is not called again.
		const queryCallsBefore = querySpy.mock.calls.length;
		const result2 = readModelCache("ollama-cloud", TTL_MS, Date.now);
		expect(result2).toBeNull();
		expect(querySpy.mock.calls.length).toBe(queryCallsBefore);

		pathSpy.mockRestore();
		querySpy.mockRestore();
		closeSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
