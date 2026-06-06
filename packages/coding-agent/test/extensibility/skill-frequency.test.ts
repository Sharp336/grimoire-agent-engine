import { describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeFrequentSkillNames,
	resolveFrequentSkillNames,
} from "@oh-my-pi/pi-coding-agent/extensibility/skill-frequency";
import { AgentStorage } from "../../src/session/agent-storage";

const skills = (names: string[]) => names.map(name => ({ name, hide: false }));
const NOW = 1_700_000_000;

describe("computeFrequentSkillNames", () => {
	it("warmup gate: returns all skills when totalCount < 10", () => {
		const result = computeFrequentSkillNames({
			skills: skills(["a", "b", "c"]),
			usage: [{ name: "a", score: 5, lastUsedAt: NOW - 100, totalCount: 9 }],
			frequentCount: 1, // would only return 1 without gate
			alwaysInclude: [],
			nowSec: NOW,
		});
		expect([...result].sort()).toEqual(["a", "b", "c"]);
	});

	it("top-N applies once totalCount >= 10", () => {
		const result = computeFrequentSkillNames({
			skills: skills(["a", "b", "c", "d"]),
			usage: [{ name: "a", score: 5, lastUsedAt: NOW - 86400 * 30, totalCount: 10 }],
			frequentCount: 1,
			alwaysInclude: [],
			nowSec: NOW,
		});
		expect(result.has("a")).toBe(true);
		expect(result.size).toBe(1);
	});

	it("pin globs include matching skills regardless of score", () => {
		const result = computeFrequentSkillNames({
			skills: skills(["odin:foo", "other"]),
			usage: [{ name: "other", score: 10, lastUsedAt: NOW - 100, totalCount: 20 }],
			frequentCount: 1,
			alwaysInclude: ["odin:*"],
			nowSec: NOW,
		});
		expect(result.has("odin:foo")).toBe(true);
	});

	it("recent-7d override includes recently used skills", () => {
		const result = computeFrequentSkillNames({
			skills: skills(["new", "old"]),
			usage: [
				{ name: "new", score: 0.1, lastUsedAt: NOW - 86400, totalCount: 15 }, // 1 day ago
				{ name: "old", score: 10, lastUsedAt: NOW - 86400 * 30, totalCount: 15 }, // 30 days ago
			],
			frequentCount: 1,
			alwaysInclude: [],
			nowSec: NOW,
		});
		// "new" is recent (< 7d), included regardless of low score
		expect(result.has("new")).toBe(true);
	});

	it("alphabetical tiebreak for zero-score skills", () => {
		// Use a loaded skill ("zzz") to carry the warmup count so the gate passes.
		// All three have score 0 and stale timestamps; alphabetical top-2 picks "aaa" and "mmm".
		const result = computeFrequentSkillNames({
			skills: skills(["zzz", "aaa", "mmm"]),
			usage: [{ name: "zzz", score: 0, lastUsedAt: NOW - 86_400 * 30, totalCount: 10 }],
			frequentCount: 2,
			alwaysInclude: [],
			nowSec: NOW,
		});
		expect(result.has("aaa")).toBe(true);
		expect(result.has("mmm")).toBe(true);
		expect(result.has("zzz")).toBe(false);
	});

	it("hidden skills are excluded", () => {
		const result = computeFrequentSkillNames({
			skills: [
				{ name: "visible", hide: false },
				{ name: "hidden", hide: true },
			],
			usage: [{ name: "dummy", score: 0, lastUsedAt: 0, totalCount: 10 }],
			frequentCount: 5,
			alwaysInclude: [],
			nowSec: NOW,
		});
		expect(result.has("visible")).toBe(true);
		expect(result.has("hidden")).toBe(false);
	});

	it("warmup accumulates across multiple rows: 5+5=10 crosses threshold", () => {
		// Use stale timestamps (> 7 days) so neither skill qualifies via recent-7d path.
		// Only top-N applies; "a" wins with higher score, result size = 1.
		const result = computeFrequentSkillNames({
			skills: skills(["a", "b", "c"]),
			usage: [
				{ name: "a", score: 5, lastUsedAt: NOW - 86_400 * 30, totalCount: 5 },
				{ name: "b", score: 3, lastUsedAt: NOW - 86_400 * 30, totalCount: 5 },
			],
			frequentCount: 1,
			alwaysInclude: [],
			nowSec: NOW,
		});
		// Total loaded invocations = 10, threshold crossed → top-N applies (only 1)
		expect(result.has("a")).toBe(true);
		expect(result.size).toBe(1);
	});

	it("warmup: uninstalled-skill totalCount is excluded from threshold sum", () => {
		// "ghost" has 9 invocations but is not in the loaded skills list → should not count
		const result = computeFrequentSkillNames({
			skills: skills(["a", "b", "c"]), // no "ghost"
			usage: [
				{ name: "ghost", score: 5, lastUsedAt: NOW - 100, totalCount: 9 },
				{ name: "a", score: 1, lastUsedAt: NOW - 100, totalCount: 1 },
			],
			frequentCount: 1,
			alwaysInclude: [],
			nowSec: NOW,
		});
		// Only "a" counts toward warmup (totalCount=1), ghost is unloaded; total=1 < 10 → full list
		expect([...result].sort()).toEqual(["a", "b", "c"]);
	});
});

const CACHE_KEY = "skills.frequentSet";
// T0 is used for pure-computation tests only; SQLite cache tests use actual clock.
const T0 = 1_700_000_000;

describe("resolveFrequentSkillNames", () => {
	async function withStorage(fn: (storage: AgentStorage, dbPath: string) => Promise<void>): Promise<void> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-freq-"));
		try {
			const dbPath = path.join(tempDir, "agent.db");
			const storage = await AgentStorage.open(dbPath);
			await fn(storage, dbPath);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}

	it("cache hit: matching hash returns cached names without recomputing", async () => {
		await withStorage(async storage => {
			const skillList = [
				{ name: "alpha", hide: false },
				{ name: "beta", hide: false },
			];
			const settings = { frequentCount: 1, alwaysInclude: [] };

			// Prime the cache with a far-future expiry (SQLite strftime uses OS clock,
			// so we must set a TTL that's in the future by the real wall clock).
			const nowSec = Math.floor(Date.now() / 1000);
			const nonHiddenNames = ["alpha", "beta"].sort();
			const settingsHash = JSON.stringify({
				frequentCount: settings.frequentCount,
				alwaysInclude: [],
				skillNames: nonHiddenNames,
			});
			const payload = JSON.stringify({ settingsHash, names: ["alpha"] });
			storage.setCache(CACHE_KEY, payload, nowSec + 86_400 * 365);

			const result = resolveFrequentSkillNames(storage, skillList, settings, nowSec);
			expect([...result]).toEqual(["alpha"]);
		});
	});

	it("cache hit with hash mismatch (different frequentCount) triggers recompute", async () => {
		await withStorage(async storage => {
			const skillList = [
				{ name: "a", hide: false },
				{ name: "b", hide: false },
				{ name: "c", hide: false },
			];
			// Anchor TTL to real OS clock so SQLite's strftime('now') sees it as live.
			const nowSec = Math.floor(Date.now() / 1000);
			// Write cache with frequentCount: 2 — will mismatch the resolve call below
			const settingsHashOld = JSON.stringify({ frequentCount: 2, alwaysInclude: [], skillNames: ["a", "b", "c"] });
			storage.setCache(CACHE_KEY, JSON.stringify({ settingsHash: settingsHashOld, names: ["a"] }), nowSec + 86_400);

			// Advance fake clock 301s per iteration so the 300s throttle clears each time.
			const baseMs = Date.now();
			try {
				for (let i = 0; i < 10; i++) {
					setSystemTime(baseMs + i * 301_000);
					storage.recordSkillUsage("b");
				}
			} finally {
				setSystemTime();
			}

			// Now resolve with frequentCount: 1 — hash won't match (old had 2)
			const result = resolveFrequentSkillNames(storage, skillList, { frequentCount: 1, alwaysInclude: [] }, nowSec);
			// "b" wins top-1 (10 usages); "a" and "c" are pruned — proves top-N ran
			expect(result.has("b")).toBe(true);
			expect(result.has("a")).toBe(false);
			expect(result.size).toBe(1);
		});
	});

	it("null storage: computes without throwing and returns a Set", () => {
		const skillList = [{ name: "x", hide: false }];
		const settings = { frequentCount: 5, alwaysInclude: [] };
		// Should not throw; warmup gate fires (no usage) → all skills returned
		const result = resolveFrequentSkillNames(null, skillList, settings, T0);
		expect(result instanceof Set).toBe(true);
		expect(result.has("x")).toBe(true);
	});

	it("writes cache with TTL = nowSec + 86400 on recompute", async () => {
		await withStorage(async storage => {
			const skillList = [{ name: "a", hide: false }];
			const settings = { frequentCount: 5, alwaysInclude: [] };
			// Use actual wall-clock time so the written TTL (nowSec + 86400) is in the future
			// and SQLite's strftime('now') considers it unexpired on the subsequent getCache call.
			const nowSec = Math.floor(Date.now() / 1000);
			resolveFrequentSkillNames(storage, skillList, settings, nowSec);

			// Cache should now exist and be readable
			const raw = storage.getCache(CACHE_KEY);
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw!);
			expect(Array.isArray(parsed.names)).toBe(true);
		});
	});

	it("corrupt JSON in cache silently falls back to recompute", async () => {
		await withStorage(async storage => {
			// Use wall-clock-relative TTL so the corrupt row is live when getCache runs.
			// T0 + 86_400 is Nov 2023 + 1 day — already expired — so without this fix
			// getCache returns null from TTL expiry before JSON.parse is ever reached,
			// leaving the try/catch in resolveFrequentSkillNames untested.
			const nowSec = Math.floor(Date.now() / 1000);
			storage.setCache(CACHE_KEY, "not-valid-json{{{", nowSec + 86_400);
			const skillList = [{ name: "a", hide: false }];
			const settings = { frequentCount: 5, alwaysInclude: [] };
			// Should not throw — getCache returns the live corrupt row, JSON.parse fires, catch handles it
			expect(() => resolveFrequentSkillNames(storage, skillList, settings, nowSec)).not.toThrow();
			const result = resolveFrequentSkillNames(storage, skillList, settings, nowSec);
			expect(result.has("a")).toBe(true);
		});
	});
});
