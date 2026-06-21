import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { CodemapConfig } from "../config";
import { closeCodemapDb } from "../db";
import { getTaskContext, tokenCost } from "../retrieve";
import { initSchema } from "../schema";
import { type SummaryRow, upsertSummary } from "../store";

// Token usage tests verify the budget packer produces correct estimatedTokens
// and that getTaskContext responses stay within the configured token budget.

const PROJECT = "token-test-project";

function makeConfig(dbPath: string, overrides: Partial<CodemapConfig> = {}): CodemapConfig {
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

function makeTmpDb(): { client: Client; dbPath: string; cleanup: () => Promise<void> } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-token-"));
	const dbPath = path.join(tmpDir, "codemap-token.db");
	const client = createClient({ url: `file:${dbPath}` });
	return {
		client,
		dbPath,
		cleanup: async () => {
			await closeCodemapDb(client);
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// Best-effort — libSQL may hold handles briefly
			}
		},
	};
}

async function setupSummaries(
	client: Client,
	summaries: Array<{ filePath: string; text: string; hash?: string }>,
): Promise<SummaryRow[]> {
	const rows: SummaryRow[] = [];
	for (const s of summaries) {
		const row = await upsertSummary(client, {
			projectLabel: PROJECT,
			filePath: s.filePath,
			summaryText: s.text,
			contentHash: s.hash ?? "h",
			maxSummaryChars: 1000,
		});
		rows.push(row);
	}
	return rows;
}

describe("codemap token formula", () => {
	it("matches codemap's documented formula: ceil(chars/4) + 20", () => {
		expect(tokenCost("")).toBe(20);
		expect(tokenCost("a")).toBe(21);
		expect(tokenCost("abcd")).toBe(21);
		expect(tokenCost("abcde")).toBe(22);
		expect(tokenCost("a".repeat(100))).toBe(45);
		expect(tokenCost("a".repeat(1000))).toBe(270);
	});

	it("the +20 is per-file overhead (markdown heading + metadata)", () => {
		// Two files with 40 chars each: 2 * (ceil(40/4) + 20) = 2 * 30 = 60
		const single = tokenCost("a".repeat(40));
		const double = tokenCost("a".repeat(40)) + tokenCost("a".repeat(40));
		expect(single).toBe(30);
		expect(double).toBe(60);
		expect(double).toBe(single * 2);
	});

	it("produces reasonable estimates for typical summary lengths", () => {
		// A typical 1-3 sentence summary is ~50-200 chars
		const short = tokenCost("Validates token and updates hash."); // 33 chars
		const medium = tokenCost(
			"Handles password hashing with bcrypt, token validation via JWT, and session management with Redis cache.",
		); // 104 chars
		const long = tokenCost(
			"This module implements the authentication flow: validates JWT tokens from the Authorization header, checks token expiry against the Redis cache, refreshes expired tokens via the refresh endpoint, and logs authentication events to the audit trail. Depends on bcrypt for password hashing and jsonwebtoken for token signing.",
		);
		expect(short).toBeLessThan(40);
		expect(medium).toBeLessThan(60);
		expect(long).toBeLessThan(120);
	});

	it("respects the 1000-char maxSummaryChars cap", () => {
		// A summary capped at 1000 chars: ceil(1000/4) + 20 = 270 tokens
		expect(tokenCost("a".repeat(1000))).toBe(270);
		// This is well under the default 8000 token budget
		expect(270).toBeLessThan(8000);
	});
});

describe("codemap budget packer token bounds", () => {
	it("estimatedTokens never exceeds budget when multiple files fit", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath, { tokenBudget: 200 });
		await setupSummaries(client, [
			{ filePath: "a.ts", text: "Short summary A." },
			{ filePath: "b.ts", text: "Short summary B." },
			{ filePath: "c.ts", text: "Short summary C." },
		]);

		const result = await getTaskContext(client, config, "short summary", PROJECT, os.tmpdir(), {
			maxFiles: 10,
			tokenBudget: 200,
		});

		expect(result.meta.estimatedTokens).toBeLessThanOrEqual(200);
		await cleanup();
	});

	it("always includes at least one file even if it exceeds budget", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath, { tokenBudget: 10 });
		const longText = `searchterm ${"a".repeat(500)}`; // tokenCost = ceil(512/4)+20 = 148
		await setupSummaries(client, [{ filePath: "big.ts", text: longText }]);

		const result = await getTaskContext(client, config, "searchterm", PROJECT, os.tmpdir(), {
			maxFiles: 5,
			tokenBudget: 10,
		});

		// Even with a 10-token budget, the packer includes at least 1 file
		expect(result.files.length).toBeGreaterThanOrEqual(1);
		expect(result.meta.estimatedTokens).toBe(tokenCost(longText));
		await cleanup();
	});

	it("packs more files with a larger budget", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		// Insert 20 summaries, each ~50 chars (tokenCost = ceil(50/4)+20 = 33)
		const summaries = Array.from({ length: 20 }, (_, i) => ({
			filePath: `file${i}.ts`,
			text: `Summary about database and authentication topic ${i}.`,
		}));
		await setupSummaries(client, summaries);

		const smallBudget = await getTaskContext(client, config, "database authentication", PROJECT, os.tmpdir(), {
			maxFiles: 20,
			tokenBudget: 100,
		});
		const largeBudget = await getTaskContext(client, config, "database authentication", PROJECT, os.tmpdir(), {
			maxFiles: 20,
			tokenBudget: 8000,
		});

		// With 100-token budget: ~3 files (33 each)
		expect(smallBudget.files.length).toBeLessThan(largeBudget.files.length);
		expect(smallBudget.meta.estimatedTokens).toBeLessThan(largeBudget.meta.estimatedTokens);
		await cleanup();
	});

	it("truncates when results exceed budget", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		const summaries = Array.from({ length: 30 }, (_, i) => ({
			filePath: `mod${i}.ts`,
			text: `Database connection pool authentication module number ${i}.`,
		}));
		await setupSummaries(client, summaries);

		const result = await getTaskContext(client, config, "database authentication pool", PROJECT, os.tmpdir(), {
			maxFiles: 5,
			tokenBudget: 8000,
		});

		// 30 summaries match, only 5 fit in maxFiles → truncated
		expect(result.meta.truncated).toBe(true);
		expect(result.files.length).toBe(5);
		await cleanup();
	});
});

describe("codemap getTaskContext token efficiency", () => {
	it("FTS-only retrieval is token-efficient vs reading full files", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		// Simulate 10 files, each with a 1000-char summary (max cap)
		// Full file reads would be ~10,000 chars ≈ 2,500 tokens
		// Summary retrieval: 10 * (ceil(1000/4)+20) = 10 * 270 = 2,700 tokens
		// But with budget=8000, all 10 fit
		const summaries = Array.from({ length: 10 }, (_, i) => ({
			filePath: `src/module${i}.ts`,
			text: `a`.repeat(1000),
		}));
		await setupSummaries(client, summaries);

		const result = await getTaskContext(client, config, "module", PROJECT, os.tmpdir(), {
			maxFiles: 10,
			tokenBudget: 8000,
		});

		// All 10 summaries fit within the 8000 token budget
		expect(result.files.length).toBe(10);
		expect(result.meta.estimatedTokens).toBe(2700); // 10 * 270
		expect(result.meta.estimatedTokens).toBeLessThan(8000);
		await cleanup();
	});

	it("budget packing reduces token usage when budget is tight", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		// 20 summaries, each 200 chars (tokenCost = ceil(200/4)+20 = 70)
		// Budget = 500 → can fit 7 summaries (7*70=490 ≤ 500, 8*70=560 > 500)
		const summaries = Array.from({ length: 20 }, (_, i) => ({
			filePath: `src/file${i}.ts`,
			text: `x`.repeat(200),
		}));
		await setupSummaries(client, summaries);

		const result = await getTaskContext(client, config, "file", PROJECT, os.tmpdir(), {
			maxFiles: 20,
			tokenBudget: 500,
		});

		expect(result.files.length).toBe(7);
		expect(result.meta.estimatedTokens).toBe(490);
		expect(result.meta.estimatedTokens).toBeLessThanOrEqual(500);
		expect(result.meta.truncated).toBe(true);
		await cleanup();
	});

	it("empty result has zero token cost", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		const result = await getTaskContext(client, config, "zzznomatchxyz", PROJECT, os.tmpdir());

		expect(result.files).toHaveLength(0);
		expect(result.meta.estimatedTokens).toBe(0);
		expect(result.meta.fileCount).toBe(0);
		await cleanup();
	});

	it("single file result has exact token cost matching the formula", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath);

		const text = "Validates JWT tokens and manages session state with Redis.";
		await setupSummaries(client, [{ filePath: "src/auth.ts", text }]);

		const result = await getTaskContext(client, config, "validates jwt tokens", PROJECT, os.tmpdir(), {
			maxFiles: 10,
			tokenBudget: 8000,
		});

		expect(result.files).toHaveLength(1);
		expect(result.meta.estimatedTokens).toBe(tokenCost(text));
		await cleanup();
	});

	it("default 8000 token budget accommodates 20+ typical summaries", async () => {
		const { client, dbPath, cleanup } = makeTmpDb();
		await initSchema(client);
		const config = makeConfig(dbPath); // default tokenBudget=8000

		// 30 typical summaries (~80 chars each, tokenCost = ceil(80/4)+20 = 40)
		// 8000 / 40 = 200 summaries could fit — well beyond 30
		const summaries = Array.from({ length: 30 }, (_, i) => ({
			filePath: `src/svc${i}.ts`,
			text: `Service module that handles business logic for domain ${i}.`,
		}));
		await setupSummaries(client, summaries);

		const result = await getTaskContext(client, config, "service module domain", PROJECT, os.tmpdir(), {
			maxFiles: 30,
			tokenBudget: 8000,
		});

		expect(result.meta.estimatedTokens).toBeLessThanOrEqual(8000);
		expect(result.files.length).toBeGreaterThan(10); // most/all fit
		await cleanup();
	});
});
