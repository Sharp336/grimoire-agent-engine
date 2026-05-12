import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ENTRY_SOURCE = String.raw`
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { closeDb, getMessageCount } from "./src/db";
import { syncAllSessions } from "./src/aggregator";

const root = process.env.OMP_STATS_SMOKE_DIR;
if (!root) throw new Error("missing OMP_STATS_SMOKE_DIR");

const configDir = path.relative(os.homedir(), path.join(root, "config"));
process.env.PI_CONFIG_DIR = configDir;
setAgentDir(path.join(os.homedir(), configDir, "agent"));

const sessionDir = path.join(getAgentDir(), "sessions", "--tmp--stats");
await fs.mkdir(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "session.jsonl");
const assistant = {
	type: "message",
	id: "assistant-1",
	parentId: null,
	timestamp: new Date().toISOString(),
	message: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		duration: 10,
		ttft: 5,
	},
};
await Bun.write(sessionFile, JSON.stringify(assistant) + "\\n");
const synced = await syncAllSessions();
const total = getMessageCount();
console.log(JSON.stringify({ synced, total }));
closeDb();
`;

describe("compiled stats sync", () => {
	it("syncs session files from a compiled binary", async () => {
		const packageDir = path.resolve(import.meta.dir, "..");
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-compiled-sync-"));
		const entryPath = path.join(packageDir, `.tmp-compiled-sync-${Bun.hash(tempDir).toString(16)}.ts`);
		const binaryPath = path.join(tempDir, process.platform === "win32" ? "stats-smoke.exe" : "stats-smoke");
		try {
			await Bun.write(entryPath, ENTRY_SOURCE);

			const build = Bun.spawnSync(["bun", "build", "--compile", entryPath, "--outfile", binaryPath], {
				cwd: packageDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(build.exitCode, `build stderr=${build.stderr.toString()}`).toBe(0);

			const run = Bun.spawnSync([binaryPath], {
				env: { ...Bun.env, OMP_STATS_SMOKE_DIR: path.join(tempDir, "run") },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode, `run stderr=${run.stderr.toString()}`).toBe(0);

			const lastLine = run.stdout.toString().trim().split("\n").at(-1);
			expect(lastLine).toBeDefined();
			const payload = JSON.parse(lastLine!) as { synced: { processed: number; files: number }; total: number };
			expect(payload).toEqual({ synced: { processed: 1, files: 1 }, total: 1 });
		} finally {
			await fs.rm(entryPath, { force: true });
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
