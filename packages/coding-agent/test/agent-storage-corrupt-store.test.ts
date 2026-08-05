import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { sqliteRepairGuidance } from "@oh-my-pi/pi-utils/sqlite";
import { removeWithRetries } from "../../utils/src/temp";

describe("AgentStorage corrupt-store schema init guidance", () => {
	afterEach(() => {
		AgentStorage.resetInstance();
	});

	it("F4: throws .recover guidance with the path when agent.db is malformed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-storage-corrupt-"));
		try {
			const dbPath = path.join(dir, "agent.db");
			// Write a deterministic malformed SQLite source — bytes that are not a
			// valid SQLite database — so #initializeSchema's PRAGMA/integrity calls
			// throw a real SQLITE_NOTADB error before the credential store is built.
			await fs.writeFile(dbPath, "this is not a sqlite database");

			let thrown: unknown;
			try {
				await AgentStorage.open(dbPath);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeDefined();
			const message = thrown instanceof Error ? thrown.message : String(thrown);
			expect(message).toContain(sqliteRepairGuidance(dbPath, { restrictPermissions: true }));
		} finally {
			await removeWithRetries(dir);
		}
	});
});
