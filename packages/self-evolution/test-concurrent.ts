/**
 * Concurrent session test for self-evolution global store.
 *
 * Simulates multiple omp sessions sharing the same global DB to verify:
 * 1. Per-path refcount in db.ts
 * 2. Per-path refcount in activity-logger.ts
 * 3. busy_timeout handling
 * 4. Data visibility across sessions
 */

import { closeActivityLogger, getActivityLogger } from "./src/logging/activity-logger";
import { closeEvolutionDb, getEvolutionDb } from "./src/storage/db";

const TEST_CWD = "/tmp/test-project";
const GLOBAL_STORE = true;

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

async function runSession(sessionId: string, writeCount: number, delayMs: number) {
	console.log(`[${sessionId}] Starting session...`);

	// Open DB and logger (same as _ensureInit)
	const db = getEvolutionDb(TEST_CWD, GLOBAL_STORE);
	const logger = getActivityLogger(TEST_CWD, GLOBAL_STORE);

	console.log(`[${sessionId}] DB and logger acquired`);

	// Log session start
	await logger.log("session_start", { sessionId, pid: process.pid });

	// Write episodes
	for (let i = 0; i < writeCount; i++) {
		const ts = Date.now();
		const id = `${sessionId}-ep-${i}-${ts}`;
		db.run(
			`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				sessionId,
				TEST_CWD,
				`Write ${i} from ${sessionId}`,
				ts,
				100,
				1,
				0,
				0,
				1,
				`Episode ${i}`,
				"read",
				"test.ts",
			],
		);
		await logger.log("episode_written", { sessionId, episodeId: id, index: i });

		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}

	console.log(`[${sessionId}] Wrote ${writeCount} episodes`);

	// Read back total count
	const count = (db.query("SELECT COUNT(*) as c FROM episodes WHERE session_id = ?").get(sessionId) as { c: number })
		.c;
	console.log(`[${sessionId}] Verified own episodes: ${count}`);

	// Simulate session end
	await logger.log("session_end", { sessionId, episodesWritten: writeCount });

	console.log(`[${sessionId}] Closing resources (refcount decrements)...`);
	closeActivityLogger(TEST_CWD, GLOBAL_STORE);
	closeEvolutionDb(TEST_CWD, GLOBAL_STORE);

	console.log(`[${sessionId}] Session complete.`);
}

async function main() {
	const args = process.argv.slice(2);
	const mode = args[0] ?? "single";

	if (mode === "single") {
		// Single session test - use pid to avoid collisions when multiple processes run
		await runSession(`session-p${process.pid}`, 5, 10);
	} else if (mode === "concurrent") {
		// Concurrent session test - two sessions running in parallel
		const p1 = runSession("session-A", 10, 20);
		await sleep(50); // Slight stagger
		const p2 = runSession("session-B", 10, 20);

		await Promise.all([p1, p2]);

		// Verify both sessions' data is present
		const db = getEvolutionDb(TEST_CWD, GLOBAL_STORE);
		const countA = (
			db.query("SELECT COUNT(*) as c FROM episodes WHERE session_id = 'session-A'").get() as { c: number }
		).c;
		const countB = (
			db.query("SELECT COUNT(*) as c FROM episodes WHERE session_id = 'session-B'").get() as { c: number }
		).c;
		console.log(`\n[VERIFY] Session A episodes: ${countA} (expected 10)`);
		console.log(`[VERIFY] Session B episodes: ${countB} (expected 10)`);
		console.log(`[VERIFY] Result: ${countA === 10 && countB === 10 ? "PASS" : "FAIL"}`);
		closeEvolutionDb(TEST_CWD, GLOBAL_STORE);
	} else if (mode === "stress") {
		// Stress test: many concurrent writers
		const writers = Array.from({ length: 10 }, (_, i) => runSession(`stress-${i}`, 20, 0));
		await Promise.all(writers);

		const db = getEvolutionDb(TEST_CWD, GLOBAL_STORE);
		const total = (
			db.query("SELECT COUNT(*) as c FROM episodes WHERE session_id LIKE 'stress-%'").get() as { c: number }
		).c;
		console.log(`\n[VERIFY] Total stress episodes: ${total} (expected 200)`);
		console.log(`[VERIFY] Result: ${total === 200 ? "PASS" : "FAIL"}`);
		closeEvolutionDb(TEST_CWD, GLOBAL_STORE);
	} else if (mode === "switch") {
		// Session switch test: open, close, reopen
		console.log("[SWITCH] Opening session 1...");
		const db1 = getEvolutionDb(TEST_CWD, GLOBAL_STORE);
		const log1 = getActivityLogger(TEST_CWD, GLOBAL_STORE);
		db1.run(`INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			"switch-test-1",
			"switch",
			TEST_CWD,
			"First session",
			Date.now(),
			100,
			1,
			0,
			0,
			1,
			"First",
			"read",
			"first.ts",
		]);
		await log1.log("first_session", {});

		console.log("[SWITCH] Closing session 1 (refcount should not close DB since no other users)...");
		closeActivityLogger(TEST_CWD, GLOBAL_STORE);
		closeEvolutionDb(TEST_CWD, GLOBAL_STORE);

		console.log("[SWITCH] Opening session 2 immediately...");
		const db2 = getEvolutionDb(TEST_CWD, GLOBAL_STORE);
		const log2 = getActivityLogger(TEST_CWD, GLOBAL_STORE);

		// Verify session 1 data is still there
		const row = db2.query("SELECT * FROM episodes WHERE id = 'switch-test-1'").get() as Record<string, unknown>;
		console.log(`[SWITCH] Session 1 data visible in session 2: ${row ? "YES" : "NO"}`);

		db2.run(`INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			"switch-test-2",
			"switch",
			TEST_CWD,
			"Second session",
			Date.now(),
			100,
			1,
			0,
			0,
			1,
			"Second",
			"bash",
			"second.ts",
		]);
		await log2.log("second_session", {});

		closeActivityLogger(TEST_CWD, GLOBAL_STORE);
		closeEvolutionDb(TEST_CWD, GLOBAL_STORE);

		console.log("[SWITCH] Session switch test complete.");
	}
}

main().catch(err => {
	console.error("Test failed:", err);
	process.exit(1);
});
