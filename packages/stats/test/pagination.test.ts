import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getRecentErrors, getRecentRequests } from "@oh-my-pi/omp-stats/aggregator";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-pagination-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function createStats(entryId: string, stopReason: "stop" | "error" | "aborted" = "stop"): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-4",
		provider: "openai",
		api: "openai-chat",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason,
		errorMessage: stopReason === "error" ? "test error" : null,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			premiumRequests: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("getRecentRequests pagination", () => {
	it("returns data array and total count", async () => {
		await initDb();
		insertMessageStats([createStats("1"), createStats("2"), createStats("3")]);

		const result = await getRecentRequests(10, 0);

		expect(result).toHaveProperty("data");
		expect(result).toHaveProperty("total");
		expect(Array.isArray(result.data)).toBe(true);
		expect(result.total).toBe(3);
		expect(result.data.length).toBe(3);
	});

	it("respects limit and offset parameters", async () => {
		await initDb();
		insertMessageStats([createStats("1"), createStats("2"), createStats("3"), createStats("4"), createStats("5")]);

		const page1 = await getRecentRequests(2, 0);
		const page2 = await getRecentRequests(2, 2);

		expect(page1.data.length).toBe(2);
		expect(page1.total).toBe(5);
		expect(page2.data.length).toBe(2);
		expect(page2.total).toBe(5);
		expect(page1.data[0].entryId).not.toBe(page2.data[0].entryId);
	});

	it("excludes error and aborted rows from total count", async () => {
		await initDb();
		insertMessageStats([
			createStats("ok1", "stop"),
			createStats("ok2", "stop"),
			createStats("err", "error"),
			createStats("abort", "aborted"),
		]);

		const result = await getRecentRequests(10, 0);

		expect(result.total).toBe(2);
		expect(result.data.length).toBe(2);
		expect(result.data.every(r => r.stopReason === "stop")).toBe(true);
	});

	it("returns empty data with zero total when no rows match", async () => {
		await initDb();

		const result = await getRecentRequests(10, 0);

		expect(result.data).toEqual([]);
		expect(result.total).toBe(0);
	});
});

describe("getRecentErrors pagination", () => {
	it("returns only error rows with correct total", async () => {
		await initDb();
		insertMessageStats([
			createStats("ok1", "stop"),
			createStats("err1", "error"),
			createStats("err2", "error"),
			createStats("abort", "aborted"),
		]);

		const result = await getRecentErrors(10, 0);

		expect(result.total).toBe(2);
		expect(result.data.length).toBe(2);
		expect(result.data.every(r => r.stopReason === "error")).toBe(true);
	});

	it("respects limit and offset for errors", async () => {
		await initDb();
		insertMessageStats([
			createStats("err1", "error"),
			createStats("err2", "error"),
			createStats("err3", "error"),
		]);

		const page1 = await getRecentErrors(2, 0);
		const page2 = await getRecentErrors(2, 2);

		expect(page1.data.length).toBe(2);
		expect(page1.total).toBe(3);
		expect(page2.data.length).toBe(1);
		expect(page2.total).toBe(3);
	});
});
