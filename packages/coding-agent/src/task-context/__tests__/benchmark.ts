/**
 * Codemap task-context benchmark.
 *
 * Measures latency of the core operations at realistic data volumes:
 *   1. Schema init (cold start)
 *   2. Upsert throughput (batch insert N summaries)
 *   3. FTS search latency (single keyword + multi-keyword)
 *   4. Vector search latency (vector_top_k with embeddings)
 *   5. Full getTaskContext pipeline (FTS + vector + RRF + budget packer + staleness)
 *
 * Usage: bun run src/task-context/__tests__/benchmark.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import type { CodemapConfig } from "../config";
import { closeCodemapDb } from "../db";
import { getTaskContext } from "../retrieve";
import { initSchema } from "../schema";
import { searchFts, searchVector, summaryCount, updateEmbedding, upsertSummary } from "../store";

const PROJECT = "bench-project";
const DIMENSIONS = 768;

function makeConfig(dbPath: string): CodemapConfig {
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
			dimensions: DIMENSIONS,
		},
	};
}

const SUMMARY_TEMPLATES = [
	"Handles authentication token validation and session management for the API gateway",
	"Database connection pool manager with PostgreSQL driver and retry logic",
	"React component for rendering user profile cards with avatar and bio sections",
	"Utility functions for string manipulation including camelCase and snake_case conversion",
	"Error handling middleware that catches async errors and formats them as JSON responses",
	"Configuration loader that reads YAML files and merges environment variable overrides",
	"WebSocket server implementation with room-based message routing and presence tracking",
	"File system watcher that detects changes and triggers incremental rebuilds",
	"GraphQL resolver for the User type with DataLoader batching for N+1 prevention",
	"Test fixture generator that creates mock data factories for integration tests",
	"Cryptography module implementing AES-256-GCM encryption with authenticated metadata",
	"Rate limiter using sliding window algorithm with Redis backend for distributed systems",
	"Image processing pipeline with sharp for resize, crop, and WebP conversion",
	"OAuth2 client flow handler supporting authorization code and client credentials grants",
	"Background job queue with priority lanes and dead-letter queue for failed tasks",
	"Logging utility with structured JSON output and configurable log levels",
	"Cache layer with TTL support and LRU eviction policy backed by Redis",
	"Input validation schema builder using Zod with custom error messages",
	"HTTP client wrapper with retry, timeout, and circuit breaker pattern",
	"Migration runner that applies versioned SQL files in order with rollback support",
];

function generateVector(seed: number): number[] {
	const vec = new Array(DIMENSIONS);
	for (let i = 0; i < DIMENSIONS; i++) {
		// Use a deterministic non-zero pattern that avoids NaN from zero-norm normalization
		vec[i] = Math.sin(seed * 0.1 + i * 0.01) + 0.5;
	}
	// Normalize to unit length
	const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
	return vec.map(v => v / norm);
}

const FILE_PATHS = Array.from({ length: 1000 }, (_, i) => {
	const dirs = ["src", "lib", "utils", "components", "services", "routes", "models", "middleware", "hooks", "types"];
	const dir = dirs[i % dirs.length]!;
	const name = `file${i}.ts`;
	return `${dir}/${name}`;
});

function fmtMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
	return `${ms.toFixed(1)}ms`;
}

async function bench(label: string, fn: () => Promise<void>, iterations = 1): Promise<number> {
	// Warmup
	await fn();

	const times: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await fn();
		times.push(performance.now() - start);
	}
	const avg = times.reduce((a, b) => a + b, 0) / times.length;
	const min = Math.min(...times);
	const max = Math.max(...times);
	console.log(
		`  ${label.padEnd(50)} avg=${fmtMs(avg).padStart(8)}  min=${fmtMs(min).padStart(8)}  max=${fmtMs(max).padStart(8)}${
			iterations > 1 ? `  (${iterations} runs)` : ""
		}`,
	);
	return avg;
}

async function runBenchmark() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-bench-"));
	const dbPath = path.join(tmpDir, "bench.db");
	const config = makeConfig(dbPath);
	const client = createClient({ url: `file:${dbPath}` });

	console.log("═══════════════════════════════════════════════════════════════════");
	console.log("  Codemap Task-Context Benchmark");
	console.log(`  DB: ${dbPath}`);
	console.log(`  Dimensions: ${DIMENSIONS}d (bge-base-en-v1.5)`);
	console.log("═══════════════════════════════════════════════════════════════════\n");

	// 1. Schema init
	console.log("── Schema Init ──");
	await bench(
		"initSchema (cold, creates tables + indexes + triggers)",
		async () => {
			// Use a fresh in-memory DB each time
			const c = createClient({ url: "file::memory:" });
			await initSchema(c, DIMENSIONS);
			await c.close();
		},
		5,
	);

	// Init the real DB for the rest of the benchmarks
	await initSchema(client, DIMENSIONS);

	// 2. Upsert throughput
	for (const count of [100, 500, 1000]) {
		console.log(`\n── Upsert: ${count} summaries ──`);
		// Clear existing
		await client.execute("DELETE FROM summaries");

		await bench(
			`upsertSummary x${count} (no embedding)`,
			async () => {
				for (let i = 0; i < count; i++) {
					const filePath = FILE_PATHS[i % FILE_PATHS.length]!;
					const summary = SUMMARY_TEMPLATES[i % SUMMARY_TEMPLATES.length]!;
					await upsertSummary(client, {
						projectLabel: PROJECT,
						filePath,
						summaryText: summary,
						contentHash: `hash${i}`,
						maxSummaryChars: 1000,
					});
				}
			},
			1,
		);

		const total = await summaryCount(client, PROJECT);
		console.log(`  → ${total} summaries in DB`);

		// 3. FTS search latency
		console.log(`\n── FTS5 Search: ${count} summaries ──`);
		await bench(
			"searchFts (single keyword: 'database')",
			async () => {
				await searchFts(client, PROJECT, "database", 20);
			},
			10,
		);

		await bench(
			"searchFts (multi-keyword: 'database connection pool retry')",
			async () => {
				await searchFts(client, PROJECT, "database connection pool retry", 20);
			},
			10,
		);

		await bench(
			"searchFts (no match: 'zzznomatchxyz')",
			async () => {
				await searchFts(client, PROJECT, "zzznomatchxyz", 20);
			},
			10,
		);

		// 4. Vector search — only for counts where we have embeddings
		if (count <= 500) {
			console.log(`\n── Vector Search: ${count} summaries (embedding first ${count}) ──`);
			// Add embeddings to all summaries
			const rows = await client.execute({
				sql: "SELECT id FROM summaries WHERE project_label = ? ORDER BY id",
				args: [PROJECT],
			});
			await bench(
				`updateEmbedding x${rows.rows.length}`,
				async () => {
					for (let i = 0; i < rows.rows.length; i++) {
						const id = Number(rows.rows[i]!.id);
						await updateEmbedding(client, id, generateVector(i), "test-model");
					}
				},
				1,
			);

			const queryVec = generateVector(42);
			await bench(
				"searchVector (vector_top_k, k=20)",
				async () => {
					await searchVector(client, PROJECT, queryVec, 20);
				},
				10,
			);

			// 5. Full pipeline
			console.log(`\n── Full getTaskContext Pipeline: ${count} summaries ──`);
			await bench(
				"getTaskContext (FTS only, no queryEmbedding)",
				async () => {
					await getTaskContext(client, config, "database connection pool authentication", PROJECT, tmpDir, {
						maxFiles: 12,
						tokenBudget: 8000,
					});
				},
				10,
			);

			await bench(
				"getTaskContext (hybrid FTS + vector, with queryEmbedding)",
				async () => {
					await getTaskContext(client, config, "database connection pool authentication", PROJECT, tmpDir, {
						maxFiles: 12,
						tokenBudget: 8000,
						queryEmbedding: queryVec,
					});
				},
				10,
			);
		} else {
			console.log(`\n── Full getTaskContext Pipeline: ${count} summaries (FTS only, no embeddings) ──`);
			await bench(
				"getTaskContext (FTS only)",
				async () => {
					await getTaskContext(client, config, "database connection pool authentication", PROJECT, tmpDir, {
						maxFiles: 12,
						tokenBudget: 8000,
					});
				},
				10,
			);
		}
	}

	// Cleanup
	await closeCodemapDb(client);
	await Bun.sleep(100);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort
	}

	console.log("\n═══════════════════════════════════════════════════════════════════");
	console.log("  Benchmark complete.");
	console.log("═══════════════════════════════════════════════════════════════════");
}

runBenchmark().catch(err => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});
