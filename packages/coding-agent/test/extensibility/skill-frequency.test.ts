import { describe, expect, it } from "bun:test";
import { computeFrequentSkillNames } from "@oh-my-pi/pi-coding-agent/extensibility/skill-frequency";

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
		const result = computeFrequentSkillNames({
			skills: skills(["zzz", "aaa", "mmm"]),
			usage: [{ name: "dummy", score: 0, lastUsedAt: 0, totalCount: 10 }],
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
});
