import { describe, expect, it } from "bun:test";
import { formatBranchChain, formatBranchHistory, formatBranchLabel } from "../src/modes/components/branch-label";

const GLYPHS = { branch: "⑂" };

describe("formatBranchLabel", () => {
	it("returns an empty string when both branches are absent", () => {
		expect(formatBranchLabel({}, 80, GLYPHS)).toBe("");
	});

	it("renders the initial branch when only initial is present", () => {
		expect(formatBranchLabel({ initial: "main" }, 80, GLYPHS)).toBe("⑂ main");
	});

	it("renders the latest branch when only latest is present", () => {
		expect(formatBranchLabel({ latest: "main" }, 80, GLYPHS)).toBe("⑂ main");
	});

	it("renders a single label when initial and latest match", () => {
		expect(formatBranchLabel({ initial: "main", latest: "main" }, 80, GLYPHS)).toBe("⑂ main");
	});

	it("renders the full branch transition when it fits", () => {
		expect(formatBranchLabel({ initial: "main", latest: "feat/x" }, 80, GLYPHS)).toBe("⑂ main → feat/x");
	});

	it("falls back to the latest branch under width pressure", () => {
		expect(formatBranchLabel({ initial: "main", latest: "feat/x" }, 12, GLYPHS)).toBe("⑂ feat/x");
	});
});

describe("formatBranchChain", () => {
	it("returns an empty string for an empty chain", () => {
		expect(formatBranchChain([], 80, GLYPHS)).toBe("");
	});

	it("delegates single-entry chains to formatBranchLabel", () => {
		expect(formatBranchChain(["main"], 80, GLYPHS)).toBe("⑂ main");
	});

	it("delegates two-entry chains to formatBranchLabel", () => {
		expect(formatBranchChain(["main", "feat/x"], 80, GLYPHS)).toBe("⑂ main → feat/x");
	});

	it("renders the full chain when it fits", () => {
		expect(formatBranchChain(["a", "b", "c"], 80, GLYPHS)).toBe("⑂ a → b → c");
	});

	it("uses a middle ellipsis when the full chain is too wide", () => {
		expect(formatBranchChain(["aaa", "bbb", "ccc"], 16, GLYPHS)).toBe("⑂ aaa → … → ccc");
	});

	it("truncates the ellipsis form when it is still too wide", () => {
		expect(formatBranchChain(["aaa", "bbb", "ccc"], 8, GLYPHS)).toBe("⑂ aaa →…");
	});
});

describe("formatBranchHistory", () => {
	it("returns an empty string for an empty chronology", () => {
		expect(formatBranchHistory([], new Date(), GLYPHS)).toBe("");
	});

	it("suppresses single-entry chronology", () => {
		expect(formatBranchHistory([{ branch: "main" }], new Date(), GLYPHS)).toBe("");
	});

	it("renders dwell time in minutes when timestamps are ten minutes apart", () => {
		const mainAt = "2026-02-01T00:00:00.000Z";
		const featAt = "2026-02-01T00:10:00.000Z";
		expect(
			formatBranchHistory(
				[
					{ branch: "main", at: mainAt },
					{ branch: "feat/x", at: featAt },
				],
				new Date(featAt),
				GLYPHS,
			),
		).toBe("Branch history: main (10m) · feat/x (current)");
	});

	it("omits dwell text when timestamps are unavailable", () => {
		expect(formatBranchHistory([{ branch: "main" }, { branch: "feat/x" }], new Date(), GLYPHS)).toBe(
			"Branch history: main · feat/x (current)",
		);
	});

	it("formats longer dwell times in hours", () => {
		const mainAt = "2026-02-01T00:00:00.000Z";
		const featAt = "2026-02-01T01:30:00.000Z";
		expect(
			formatBranchHistory(
				[
					{ branch: "main", at: mainAt },
					{ branch: "feat/x", at: featAt },
				],
				new Date(featAt),
				GLYPHS,
			),
		).toBe("Branch history: main (1.5h) · feat/x (current)");
	});

	it("strips the trailing .0 when dwell is an exact number of hours", () => {
		const mainAt = "2026-02-01T00:00:00.000Z";
		const featAt = "2026-02-01T02:00:00.000Z";
		expect(
			formatBranchHistory(
				[
					{ branch: "main", at: mainAt },
					{ branch: "feat/x", at: featAt },
				],
				new Date(featAt),
				GLYPHS,
			),
		).toBe("Branch history: main (2h) · feat/x (current)");
	});

	it("renders sub-minute dwell as less than one minute", () => {
		const mainAt = "2026-02-01T00:00:00.000Z";
		const featAt = "2026-02-01T00:00:30.000Z";
		expect(
			formatBranchHistory(
				[
					{ branch: "main", at: mainAt },
					{ branch: "feat/x", at: featAt },
				],
				new Date(featAt),
				GLYPHS,
			),
		).toBe("Branch history: main (< 1m) · feat/x (current)");
	});
});
