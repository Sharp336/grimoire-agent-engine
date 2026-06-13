import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clearModelCache, readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { Model } from "@oh-my-pi/pi-catalog/types";

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
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

describe("clearModelCache", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-clear-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
			dbPath = "";
		}
	});

	it("deletes every cached row when no provider is given", () => {
		writeModelCache("ollama-cloud", Date.now(), [createModel("m1", "M1")], true, "fp", dbPath);
		writeModelCache("openrouter", Date.now(), [createModel("m2", "M2")], true, "fp", dbPath);
		expect(readModelCache("ollama-cloud", TTL_MS, Date.now, dbPath)).not.toBeNull();

		const removed = clearModelCache(dbPath);

		expect(removed).toBe(2);
		expect(readModelCache("ollama-cloud", TTL_MS, Date.now, dbPath)).toBeNull();
		expect(readModelCache("openrouter", TTL_MS, Date.now, dbPath)).toBeNull();
	});

	it("deletes only the matching provider when scoped", () => {
		writeModelCache("p1", Date.now(), [createModel("m1", "M1")], true, "fp", dbPath);
		writeModelCache("p2", Date.now(), [createModel("m2", "M2")], true, "fp", dbPath);

		const removed = clearModelCache(dbPath, "p1");

		expect(removed).toBe(1);
		expect(readModelCache("p1", TTL_MS, Date.now, dbPath)).toBeNull();
		expect(readModelCache("p2", TTL_MS, Date.now, dbPath)).not.toBeNull();
	});

	it("treats an empty provider as a no-match scope, not a full wipe", () => {
		writeModelCache("p1", Date.now(), [createModel("m1", "M1")], true, "fp", dbPath);
		writeModelCache("p2", Date.now(), [createModel("m2", "M2")], true, "fp", dbPath);

		// An empty `--provider ""` must NOT fall through to deleting every row.
		const removed = clearModelCache(dbPath, "");

		expect(removed).toBe(0);
		expect(readModelCache("p1", TTL_MS, Date.now, dbPath)).not.toBeNull();
		expect(readModelCache("p2", TTL_MS, Date.now, dbPath)).not.toBeNull();
	});
});
