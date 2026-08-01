import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

describe("AgentStorage model perf aggregates", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	async function openStorage(): Promise<AgentStorage> {
		tempDir = TempDir.createSync("@omp-agent-storage-perf-");
		return AgentStorage.open(path.join(tempDir.path(), "agent.db"));
	}

	it("averages TPS over total request duration and TTFT over reporting samples", async () => {
		const storage = await openStorage();

		// 1000 tokens over 6000ms + 500 tokens over 3000ms → 1500 tokens / 9s → 166.67 t/s
		// Back-to-back samples join one deferred batch; awaiting the shared flush
		// promise makes both visible.
		storage.recordModelPerf("openai/gpt-5", { outputTokens: 1000, durationMs: 6000, ttftMs: 1000 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 500, durationMs: 3000, ttftMs: 500 });

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats).toBeDefined();
		expect(stats?.samples).toBe(2);
		expect(stats?.tps).toBeCloseTo(1500000 / 9000, 5);
		expect(stats?.ttftMs).toBeCloseTo(750, 5);
	});

	it("keeps TTFT null when no sample reported one and uses full duration for TPS", async () => {
		const storage = await openStorage();

		// No ttft → 1000 tokens / 4s → 250 t/s
		await storage.recordModelPerf("zai/glm-5", { outputTokens: 1000, durationMs: 4000 });

		const stats = storage.getModelPerf().get("zai/glm-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("reports identical TPS regardless of TTFT (hidden-reasoning regression)", async () => {
		const storage = await openStorage();

		// Same duration and token count, wildly different TTFT: a provider that
		// hides reasoning until late (ttft ~ duration) must not report inflated
		// throughput vs one that streams from the start.
		storage.recordModelPerf("google/gemini", { outputTokens: 1020, durationMs: 7000, ttftMs: 5700 });
		await storage.recordModelPerf("google-vertex/gemini", { outputTokens: 1020, durationMs: 7000, ttftMs: 1700 });

		const hidden = storage.getModelPerf().get("google/gemini");
		const streamed = storage.getModelPerf().get("google-vertex/gemini");
		expect(hidden?.tps).toBeCloseTo(1020000 / 7000, 5);
		expect(streamed?.tps).toBeCloseTo(1020000 / 7000, 5);
	});

	it("drops unmeasurable samples instead of polluting the aggregates", async () => {
		const storage = await openStorage();

		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 0, durationMs: 4000 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 100, durationMs: 0 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: Number.NaN, durationMs: 4000 });

		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);
	});

	it("ignores out-of-range TTFT but keeps the throughput sample", async () => {
		const storage = await openStorage();

		// ttft >= duration is bogus latency data; the sample still measures TPS.
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 1000, durationMs: 4000, ttftMs: 5000 });

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("defers the write off the record path and lands it once the flush promise resolves", async () => {
		const storage = await openStorage();

		const flushed = storage.recordModelPerf("openai/gpt-5", { outputTokens: 1000, durationMs: 4000 });
		// Recording is deferred: nothing is visible before the batch flushes.
		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);

		await flushed;
		expect(storage.getModelPerf().get("openai/gpt-5")?.tps).toBeCloseTo(250, 5);
	});

	it("backfills perf aggregates from an omp stats database, excluding errored and stale turns", async () => {
		const storage = await openStorage();

		// Minimal stats.db fixture: only the columns the backfill query reads.
		const statsDbPath = path.join(tempDir.path(), "stats.db");
		const statsDb = new Database(statsDbPath);
		statsDb.run(`CREATE TABLE messages (
			provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER,
			ttft INTEGER, stop_reason TEXT, timestamp INTEGER
		)`);
		const insert = statsDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
		const now = Date.now();
		// Two valid turns totaling 1500 tokens over 8.5s, one with ttft missing.
		insert.run("openai", "gpt-5", 1000, 6000, 1000, "stop", now - 5000);
		insert.run("openai", "gpt-5", 500, 2500, null, "stop", now - 4000);
		// Errored and empty turns must not pollute the averages.
		insert.run("openai", "gpt-5", 9999, 1, null, "error", now - 3000);
		insert.run("openai", "gpt-5", 0, 4000, null, "stop", now - 2000);
		// Rows older than the recency window are stale provider speeds; skip them.
		insert.run("openai", "gpt-5", 100_000, 1000, null, "stop", now - 120 * 86_400_000);
		insert.run("zai", "glm-5", 300, 3000, 1000, "aborted", now - 1000);
		statsDb.close();

		const imported = await storage.backfillModelPerfFromStats(statsDbPath);

		expect(imported).toBe(3);
		const gpt = storage.getModelPerf().get("openai/gpt-5");
		// 1500 tokens over 6000ms + 2500ms total durations → 176.47 t/s.
		expect(gpt?.samples).toBe(2);
		expect(gpt?.tps).toBeCloseTo(1500000 / 8500, 5);
		expect(gpt?.ttftMs).toBeCloseTo(1000, 5);
		// Aborted turns with reported usage are valid samples, like live capture.
		const glm = storage.getModelPerf().get("zai/glm-5");
		expect(glm?.tps).toBeCloseTo(100, 5);
	});

	it("caps the backfill at the newest samples per model", async () => {
		const storage = await openStorage();

		const statsDbPath = path.join(tempDir.path(), "stats.db");
		const statsDb = new Database(statsDbPath);
		statsDb.run(`CREATE TABLE messages (
			provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER,
			ttft INTEGER, stop_reason TEXT, timestamp INTEGER
		)`);
		const insert = statsDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
		const now = Date.now();
		// 300 rows: the newest 256 run at 100 t/s, the older 44 at a wild
		// 10000 t/s. Only the newest 256 may count. One transaction: per-row
		// implicit transactions fsync 300 times and time out on slow CI disks.
		statsDb.transaction(() => {
			for (let i = 0; i < 300; i++) {
				const fast = i < 44; // smallest timestamps = oldest rows
				insert.run("openai", "gpt-5", fast ? 10_000 : 100, 1000, null, "stop", now - (300 - i) * 1000);
			}
		})();
		statsDb.close();

		const imported = await storage.backfillModelPerfFromStats(statsDbPath);

		expect(imported).toBe(256);
		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats?.samples).toBe(256);
		expect(stats?.tps).toBeCloseTo(100, 5);
	});

	it("latches after one corrupt stats.db and returns 0 without re-opening", async () => {
		const storage = await openStorage();

		// Write a malformed stats.db — bytes that are not a valid SQLite file.
		const statsDbPath = path.join(tempDir.path(), "malformed-stats.db");
		await fs.writeFile(statsDbPath, "this is not a sqlite database");

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// First call hits the malformed file, throws SQLITE_NOTADB, and latches.
		const imported1 = await storage.backfillModelPerfFromStats(statsDbPath);
		expect(imported1).toBe(0);

		// Second call short-circuits before touching SQLite.
		const imported2 = await storage.backfillModelPerfFromStats(statsDbPath);
		expect(imported2).toBe(0);

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Stats database is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(statsDbPath);
	});

	it("propagates destination-side transaction failure without latching or mislabelling the stats path", async () => {
		const storage = await openStorage();

		// Valid stats.db with one measurable row so the backfill reaches the
		// destination transaction.
		const statsDbPath = path.join(tempDir.path(), "stats.db");
		const statsDb = new Database(statsDbPath);
		statsDb.run(`CREATE TABLE messages (
			provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER,
			ttft INTEGER, stop_reason TEXT, timestamp INTEGER
		)`);
		statsDb
			.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run("openai", "gpt-5", 1000, 4000, null, "stop", Date.now() - 1000);
		statsDb.close();

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// Make the DESTINATION db's transaction throw a corrupt error. The
		// stats read path does not call .transaction(), so this spy only
		// fires when the backfill writes into agent.db.
		const corruptDestError = new Error("SQLITE_CORRUPT: destination agent.db is damaged") as Error & {
			code: string;
		};
		corruptDestError.code = "SQLITE_CORRUPT";
		const txSpy = vi.spyOn(Database.prototype, "transaction").mockImplementation(() => {
			throw corruptDestError;
		});

		// The destination failure must propagate — not be swallowed into the
		// stats-db latch.
		await expect(storage.backfillModelPerfFromStats(statsDbPath)).rejects.toThrow("SQLITE_CORRUPT");

		// No error log naming the stats path — the latch is for stats.db only.
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Stats database is damaged"),
		);
		expect(damagedErrors).toHaveLength(0);

		// The stats latch was NOT set: a second call must still reach the
		// stats read (and fail again at the destination), not short-circuit.
		await expect(storage.backfillModelPerfFromStats(statsDbPath)).rejects.toThrow("SQLITE_CORRUPT");

		txSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
