/**
 * Reference-counting corner case test.
 *
 * Simulates an omp process switching sessions while keeping the same
 * global DB open. Verifies that closing session N does not close the
 * DB while session N+1 is still active.
 */

import { closeActivityLogger, getActivityLogger } from "./src/logging/activity-logger";
import { closeEvolutionDb, getEvolutionDb } from "./src/storage/db";

const TEST_CWD = "/tmp/test-project";
const GLOBAL = true;

function _sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

async function main() {
	console.log("=== Refcount Corner Case Test ===\n");

	// Simulate: omp opens session 1
	console.log("[1] Opening session-1...");
	const db1 = getEvolutionDb(TEST_CWD, GLOBAL);
	const log1 = getActivityLogger(TEST_CWD, GLOBAL);

	// Session 1 writes
	db1.run(
		`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"refcount-ep-1",
			"refcount-test",
			TEST_CWD,
			"Session 1 write",
			Date.now(),
			100,
			1,
			0,
			0,
			1,
			"S1",
			"read",
			"s1.ts",
		],
	);
	await log1.log("s1_write", {});
	console.log("[1] Session-1 wrote 1 episode");

	// Simulate: user switches to session 2 (same process)
	console.log("\n[2] Opening session-2 (same process, same DB path)...");
	const db2 = getEvolutionDb(TEST_CWD, GLOBAL);
	const log2 = getActivityLogger(TEST_CWD, GLOBAL);

	// Verify db2 === db1 (same connection due to refcount)
	console.log(`[2] Same DB instance: ${db1 === db2}`);
	console.log(`[2] Same logger instance: ${log1 === log2}`);

	// Session 2 writes
	db2.run(
		`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"refcount-ep-2",
			"refcount-test",
			TEST_CWD,
			"Session 2 write",
			Date.now(),
			100,
			1,
			0,
			0,
			1,
			"S2",
			"read",
			"s2.ts",
		],
	);
	await log2.log("s2_write", {});
	console.log("[2] Session-2 wrote 1 episode");

	// Simulate: session 1 ends, calls close
	console.log("\n[3] Session-1 ends, calling closeEvolutionDb...");
	closeActivityLogger(TEST_CWD, GLOBAL);
	closeEvolutionDb(TEST_CWD, GLOBAL);
	console.log("[3] closeEvolutionDb returned (refcount decremented, not closed yet)");

	// CRITICAL: Session 2 should still be able to write!
	console.log("\n[4] Session-2 writes AFTER session-1 closed...");
	try {
		db2.run(
			`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"refcount-ep-3",
				"refcount-test",
				TEST_CWD,
				"Session 2 post-close write",
				Date.now(),
				100,
				1,
				0,
				0,
				1,
				"S2-after",
				"read",
				"s2-after.ts",
			],
		);
		await log2.log("s2_post_close", {});
		console.log("[4] Session-2 write SUCCESS (refcount protected)");
	} catch (err) {
		console.log(`[4] Session-2 write FAILED: ${err}`);
		console.log("[4] BUG: closeEvolutionDb closed the DB while session-2 still holds a reference!");
	}

	// Simulate: session 2 ends, calls close
	console.log("\n[5] Session-2 ends, calling closeEvolutionDb...");
	closeActivityLogger(TEST_CWD, GLOBAL);
	closeEvolutionDb(TEST_CWD, GLOBAL);
	console.log("[5] closeEvolutionDb returned (refcount now 0, DB actually closed)");

	// Verify all data persisted
	console.log("\n[6] Reopening DB to verify data...");
	const db3 = getEvolutionDb(TEST_CWD, GLOBAL);
	const count = (
		db3.query("SELECT COUNT(*) as c FROM episodes WHERE session_id = 'refcount-test'").get() as { c: number }
	).c;
	console.log(`[6] Total refcount-test episodes: ${count} (expected: 3)`);
	console.log(`[6] Result: ${count === 3 ? "PASS" : "FAIL"}`);
	closeEvolutionDb(TEST_CWD, GLOBAL);
}

main().catch(err => {
	console.error("Test failed:", err);
	process.exit(1);
});
