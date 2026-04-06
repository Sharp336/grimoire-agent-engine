#!/usr/bin/env bun
import * as os from "node:os";
/**
 * One-off LanceDB compaction + version pruning.
 *
 * Usage:
 *   bun scripts/lance-optimize.ts            # optimize recall + tasks
 *   bun scripts/lance-optimize.ts recall      # recall only
 *   bun scripts/lance-optimize.ts tasks       # tasks only
 * Safe to run while sessions are active — cleanupOlderThan preserves
 * recent versions that concurrent readers may reference.
 */
import * as path from "node:path";
import { connect } from "@lancedb/lancedb";

const agentDir = path.join(os.homedir(), ".oh-omp", "agent");
const filter = process.argv[2]; // "recall" | "tasks" | undefined (both)

const dbs: { name: string; dir: string; table: string }[] = [
	{ name: "recall", dir: path.join(agentDir, "recall.lance"), table: "recall" },
	{ name: "tasks", dir: path.join(agentDir, "tasks.lance"), table: "tasks" },
];

for (const entry of dbs) {
	if (filter && entry.name !== filter) continue;

	console.log(`\n=== ${entry.name} (${entry.dir}) ===`);

	const db = await connect(entry.dir);
	const names = await db.tableNames();
	if (!names.includes(entry.table)) {
		console.log("  table not found, skipping");
		db.close();
		continue;
	}

	const table = await db.openTable(entry.table);

	// Pre-stats
	const pre = await table.countRows();
	console.log(`  rows: ${pre}`);

	const t0 = performance.now();
	console.log("  optimizing (compact + prune)...");

	const stats = await table.optimize({
		// Prune everything older than 10 seconds — safe since no other sessions are running.
		cleanupOlderThan: new Date(Date.now() - 10_000),
	});

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

	console.log(`  done in ${elapsed}s`);
	console.log(
		`  compaction: ${stats.compaction.fragmentsRemoved} fragments removed, ${stats.compaction.filesAdded} files added`,
	);
	console.log(`  prune: ${stats.prune.bytesRemoved} bytes removed, ${stats.prune.oldVersions} old versions pruned`);

	table.close();
	db.close();
}

console.log("\ndone");
