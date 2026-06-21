import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { CodemapConfig } from "../config";
import { closeCodemapDb } from "../db";
import { getTaskContext } from "../retrieve";
import { initSchema } from "../schema";
import {
	deleteSummary,
	getSummary,
	getUnembeddedSummaries,
	searchFts,
	searchVector,
	summaryCount,
	updateEmbedding,
	upsertSummary,
} from "../store";

// --- Test helpers -----------------------------------------------------------

const PROJECT = "test-project";
let tmpDir: string;
let dbPath: string;
let client: Client;

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-int-"));
	dbPath = path.join(tmpDir, "codemap-test.db");
	client = createClient({ url: `file:${dbPath}` });
	await initSchema(client);
});

afterAll(async () => {
	await closeCodemapDb(client);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup — may fail on Windows if libSQL handles aren't fully released
	}
});

function makeConfig(overrides: Partial<CodemapConfig> = {}): CodemapConfig {
	return {
		enabled: true,
		autoInject: true,
		dbPath,
		tokenBudget: 8000,
		maxResults: 20,
		maxSummaryChars: 1000,
		turso: { syncUrl: "", authToken: "", autoProvision: false, org: "" },
		embedding: {
			model: "BAAI/bge-base-en-v1.5",
			variant: "en",
			apiUrl: undefined,
			apiKey: undefined,
			dimensions: 768,
		},
		...overrides,
	};
}

// --- Schema + init ----------------------------------------------------------

describe("codemap schema + init", () => {
	it("creates all tables after initSchema", async () => {
		const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
		const names = tables.rows.map(r => String(r.name));
		expect(names).toContain("summaries");
		expect(names).toContain("summaries_fts");
		expect(names).toContain("schema_migrations");
	});

	it("creates the vector index", async () => {
		const indexes = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_summaries%' ORDER BY name",
		);
		const names = indexes.rows.map(r => String(r.name));
		expect(names).toContain("idx_summaries_project");
		expect(names).toContain("idx_summaries_hash");
		expect(names).toContain("idx_summaries_embedding");
	});

	it("creates FTS5 sync triggers", async () => {
		const triggers = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'summaries_%' ORDER BY name",
		);
		const names = triggers.rows.map(r => String(r.name));
		expect(names).toContain("summaries_ai");
		expect(names).toContain("summaries_ad");
		expect(names).toContain("summaries_au");
	});

	it("records schema version 1", async () => {
		const result = await client.execute("SELECT version FROM schema_migrations");
		expect(Number(result.rows[0]?.version)).toBe(1);
	});

	it("initSchema is idempotent (running twice does not error)", async () => {
		await initSchema(client);
		const count = await summaryCount(client, PROJECT);
		expect(count).toBe(0);
	});
});

// --- CRUD operations --------------------------------------------------------

describe("codemap CRUD", () => {
	it("upserts and retrieves a summary", async () => {
		const row = await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/auth.ts",
			summaryText: "Handles password hashing and token validation.",
			contentHash: "abc123",
			maxSummaryChars: 1000,
		});
		expect(row.id).toBeGreaterThan(0);
		expect(row.filePath).toBe("src/auth.ts");
		expect(row.summaryText).toBe("Handles password hashing and token validation.");
		expect(row.contentHash).toBe("abc123");

		const retrieved = await getSummary(client, PROJECT, "src/auth.ts");
		expect(retrieved).not.toBeNull();
		expect(retrieved?.summaryText).toBe("Handles password hashing and token validation.");
	});

	it("upsert updates existing summary on conflict (same project+path)", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/auth.ts",
			summaryText: "Updated: handles password hashing, token validation, and session management.",
			contentHash: "def456",
			maxSummaryChars: 1000,
		});

		const retrieved = await getSummary(client, PROJECT, "src/auth.ts");
		expect(retrieved?.summaryText).toBe(
			"Updated: handles password hashing, token validation, and session management.",
		);
		expect(retrieved?.contentHash).toBe("def456");
	});

	it("upsert truncates summary to maxSummaryChars", async () => {
		const longText = "x".repeat(2000);
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/long.ts",
			summaryText: longText,
			contentHash: "hash",
			maxSummaryChars: 50,
		});

		const retrieved = await getSummary(client, PROJECT, "src/long.ts");
		expect(retrieved?.summaryText.length).toBe(50);
	});

	it("isolates summaries by project_label", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/shared.ts",
			summaryText: "Project A summary.",
			contentHash: "h1",
			maxSummaryChars: 1000,
		});
		await upsertSummary(client, {
			projectLabel: "other-project",
			filePath: "src/shared.ts",
			summaryText: "Project B summary.",
			contentHash: "h2",
			maxSummaryChars: 1000,
		});

		const a = await getSummary(client, PROJECT, "src/shared.ts");
		const b = await getSummary(client, "other-project", "src/shared.ts");
		expect(a?.summaryText).toBe("Project A summary.");
		expect(b?.summaryText).toBe("Project B summary.");
	});

	it("returns null for missing summary", async () => {
		const result = await getSummary(client, PROJECT, "nonexistent.ts");
		expect(result).toBeNull();
	});

	it("deletes a summary and returns true", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/to-delete.ts",
			summaryText: "Will be deleted.",
			contentHash: "h",
			maxSummaryChars: 1000,
		});
		const deleted = await deleteSummary(client, PROJECT, "src/to-delete.ts");
		expect(deleted).toBe(true);
		const gone = await getSummary(client, PROJECT, "src/to-delete.ts");
		expect(gone).toBeNull();
	});

	it("returns false when deleting a non-existent summary", async () => {
		const deleted = await deleteSummary(client, PROJECT, "never-existed.ts");
		expect(deleted).toBe(false);
	});

	it("counts summaries per project", async () => {
		// PROJECT has: src/auth.ts, src/long.ts, src/shared.ts (to-delete was deleted)
		const count = await summaryCount(client, PROJECT);
		expect(count).toBeGreaterThanOrEqual(3);
	});

	it("stores optional symbol metadata", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/symbols.ts",
			summaryText: "Contains exported functions.",
			contentHash: "h",
			maxSummaryChars: 1000,
			symbolName: "authenticateUser",
			symbolKind: "function",
			symbolLineRange: "10-25",
		});

		const retrieved = await getSummary(client, PROJECT, "src/symbols.ts");
		expect(retrieved?.symbolName).toBe("authenticateUser");
		expect(retrieved?.symbolKind).toBe("function");
		expect(retrieved?.symbolLineRange).toBe("10-25");
	});
});

// --- FTS5 search ------------------------------------------------------------

describe("codemap FTS5 search", () => {
	it("finds summaries by keyword match", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/search-target.ts",
			summaryText: "Database connection pool manages PostgreSQL connections.",
			contentHash: "h",
			maxSummaryChars: 1000,
		});

		const results = await searchFts(client, PROJECT, "database", 10);
		expect(results.length).toBeGreaterThan(0);
		const target = results.find(r => r.filePath === "src/search-target.ts");
		expect(target).toBeDefined();
		expect(target?.score).toBeGreaterThan(0);
	});

	it("returns empty for no matches", async () => {
		const results = await searchFts(client, PROJECT, "zzznomatchxyz", 10);
		expect(results).toHaveLength(0);
	});

	it("returns empty for query with only short tokens (<3 chars)", async () => {
		const results = await searchFts(client, PROJECT, "ab cd ef", 10);
		expect(results).toHaveLength(0);
	});

	it("ranks more relevant results higher", async () => {
		// Insert two summaries — one with the keyword prominently, one tangentially
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/relevant.ts",
			summaryText: "authentication authentication authentication token validation",
			contentHash: "h",
			maxSummaryChars: 1000,
		});
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/tangential.ts",
			summaryText: "Some code that mentions authentication once in passing",
			contentHash: "h",
			maxSummaryChars: 1000,
		});

		const results = await searchFts(client, PROJECT, "authentication", 10);
		expect(results.length).toBeGreaterThanOrEqual(2);
		// The file with more keyword occurrences should rank higher
		const relevantIdx = results.findIndex(r => r.filePath === "src/relevant.ts");
		const tangentialIdx = results.findIndex(r => r.filePath === "src/tangential.ts");
		expect(relevantIdx).toBeLessThan(tangentialIdx);
	});

	it("isolates FTS search by project_label", async () => {
		await upsertSummary(client, {
			projectLabel: "iso-project",
			filePath: "src/iso.ts",
			summaryText: "unique isolation keyword zonkflag",
			contentHash: "h",
			maxSummaryChars: 1000,
		});

		const otherProject = await searchFts(client, PROJECT, "zonkflag", 10);
		expect(otherProject).toHaveLength(0);

		const ownProject = await searchFts(client, "iso-project", "zonkflag", 10);
		expect(ownProject.length).toBeGreaterThan(0);
	});
});

// --- Vector search ----------------------------------------------------------

describe("codemap vector search", () => {
	it("finds nearest neighbors by cosine similarity", async () => {
		// Insert a summary with an embedding
		const row = await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/vec-target.ts",
			summaryText: "Vector search test target.",
			contentHash: "h",
			maxSummaryChars: 1000,
		});
		// Use a simple 4-dimensional vector (schema expects 768d, but for testing
		// we use a reduced dimension by creating a separate test table)
		// Actually, the schema column is F32_BLOB(768) — we need 768d vectors.
		// Generate a simple 768d vector.
		const vec = new Array(768).fill(0);
		vec[0] = 1.0; // unit vector along first dimension

		await updateEmbedding(client, row.id, vec, "test-model");

		const queryVec = new Array(768).fill(0);
		queryVec[0] = 1.0;

		const results = await searchVector(client, PROJECT, queryVec, 5);
		expect(results.length).toBeGreaterThan(0);
		const target = results.find(r => r.filePath === "src/vec-target.ts");
		expect(target).toBeDefined();
		expect(target?.score).toBeGreaterThan(0.9); // nearly identical vectors
	});

	it("returns empty when queryVector is empty", async () => {
		const results = await searchVector(client, PROJECT, [], 5);
		expect(results).toHaveLength(0);
	});

	it("returns empty for project with no embedded summaries", async () => {
		const queryVec = new Array(768).fill(0);
		queryVec[0] = 1.0;
		const results = await searchVector(client, "no-embeddings-project", queryVec, 5);
		expect(results).toHaveLength(0);
	});
});

// --- Embedding backfill -----------------------------------------------------

describe("codemap embedding backfill", () => {
	it("finds summaries without embeddings", async () => {
		const unembedded = await getUnembeddedSummaries(client, PROJECT, 100);
		// Most summaries we inserted don't have embeddings (except vec-target.ts)
		expect(unembedded.length).toBeGreaterThan(0);
		expect(unembedded.every(r => r.filePath !== "src/vec-target.ts")).toBe(true);
	});

	it("updates embedding for a summary row", async () => {
		const row = await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "src/embed-test.ts",
			summaryText: "Will get an embedding.",
			contentHash: "h",
			maxSummaryChars: 1000,
		});

		const vec = new Array(768).fill(0.1);
		await updateEmbedding(client, row.id, vec, "test-model");

		// Should no longer appear in unembedded list
		const unembedded = await getUnembeddedSummaries(client, PROJECT, 100);
		expect(unembedded.find(r => r.id === row.id)).toBeUndefined();
	});
});

// --- Full retrieval pipeline ------------------------------------------------

describe("codemap getTaskContext pipeline", () => {
	it("returns task-relevant summaries via FTS", async () => {
		const config = makeConfig();
		const result = await getTaskContext(client, config, "how does authentication work", PROJECT, tmpDir, {
			maxFiles: 5,
			tokenBudget: 4000,
		});

		expect(result.task).toBe("how does authentication work");
		expect(result.files.length).toBeGreaterThan(0);
		expect(result.meta.fileCount).toBe(result.files.length);
		expect(result.meta.estimatedTokens).toBeGreaterThan(0);
		// auth.ts may or may not appear depending on FTS ranking, but at least
		// some file should be returned
		expect(result.files.length).toBeGreaterThan(0);
	});

	it("respects maxFiles limit", async () => {
		const config = makeConfig();
		const result = await getTaskContext(client, config, "database connection pool", PROJECT, tmpDir, {
			maxFiles: 1,
			tokenBudget: 10000,
		});
		expect(result.files.length).toBeLessThanOrEqual(1);
	});

	it("respects token budget", async () => {
		const config = makeConfig({ tokenBudget: 100 });
		const result = await getTaskContext(client, config, "authentication database connection", PROJECT, tmpDir, {
			maxFiles: 50,
			tokenBudget: 100,
		});
		// With a 100-token budget, only 1-2 short summaries should fit
		// (each costs ceil(chars/4) + 20)
		expect(result.meta.estimatedTokens).toBeLessThanOrEqual(200); // allows 1 file exceeding budget
	});

	it("sets truncated=true when results exceed budget or maxFiles", async () => {
		const config = makeConfig();
		const result = await getTaskContext(
			client,
			config,
			"authentication database connection pool validation",
			PROJECT,
			tmpDir,
			{ maxFiles: 1, tokenBudget: 10000 },
		);
		// We have many summaries matching these terms; with maxFiles=1, should truncate
		expect(result.meta.truncated).toBe(true);
	});

	it("returns empty files when no summaries match the task", async () => {
		const config = makeConfig();
		const result = await getTaskContext(client, config, "zzznomatchxyz qqqnothingqqq", PROJECT, tmpDir);
		expect(result.files).toHaveLength(0);
		expect(result.meta.fileCount).toBe(0);
		expect(result.meta.estimatedTokens).toBe(0);
	});

	it("includes staleness flags in results", async () => {
		// Insert a summary for a file that exists on disk
		const testFile = path.join(tmpDir, "exists.ts");
		fs.writeFileSync(testFile, "export const x = 1;");
		const row = await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "exists.ts",
			summaryText: "A real file that exists.",
			contentHash: "wronghash", // intentionally wrong to trigger stale
			maxSummaryChars: 1000,
		});
		expect(row.id).toBeGreaterThan(0);

		const config = makeConfig();
		const result = await getTaskContext(client, config, "real file exists", PROJECT, tmpDir, {
			maxFiles: 50,
			tokenBudget: 10000,
		});

		const file = result.files.find(f => f.path === "exists.ts");
		expect(file).toBeDefined();
		expect(file?.stale).toBe(true); // hash doesn't match
		expect(file?.missing).toBe(false); // file exists on disk
	});

	it("marks missing=true for summarized files that no longer exist", async () => {
		await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: "deleted-file.ts",
			summaryText: "A file that was deleted.",
			contentHash: "somehash",
			maxSummaryChars: 1000,
		});

		const config = makeConfig();
		const result = await getTaskContext(client, config, "deleted file", PROJECT, tmpDir, {
			maxFiles: 50,
			tokenBudget: 10000,
		});

		const file = result.files.find(f => f.path === "deleted-file.ts");
		expect(file).toBeDefined();
		expect(file?.missing).toBe(true);
		expect(file?.stale).toBe(true);
	});
});
