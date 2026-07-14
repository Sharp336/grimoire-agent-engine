import { describe, expect, it } from "bun:test";
import { DynamicTimeoutResolver } from "./dynamic-timeout";

describe("DynamicTimeoutResolver.commandSignature", () => {
	it("keys on the first two tokens so npm test ≠ npm install", () => {
		expect(DynamicTimeoutResolver.commandSignature("npm test")).toBe("npm test");
		expect(DynamicTimeoutResolver.commandSignature("npm install")).toBe("npm install");
		expect(DynamicTimeoutResolver.commandSignature("npm test")).not.toBe(
			DynamicTimeoutResolver.commandSignature("npm install"),
		);
	});

	it("strips leading env assignments (KEY=value)", () => {
		expect(DynamicTimeoutResolver.commandSignature("FOO=bar baz qux")).toBe("baz qux");
		expect(DynamicTimeoutResolver.commandSignature("A=1 B=2 C=3 git status")).toBe("git status");
	});

	it("strips sudo and path prefixes", () => {
		expect(DynamicTimeoutResolver.commandSignature("sudo /usr/bin/git status")).toBe("git status");
		expect(DynamicTimeoutResolver.commandSignature("sudo git status")).toBe("git status");
	});

	it("strips shell builtins: time, nohup, env", () => {
		expect(DynamicTimeoutResolver.commandSignature("time npm test")).toBe("npm test");
		expect(DynamicTimeoutResolver.commandSignature("nohup cargo build")).toBe("cargo build");
		expect(DynamicTimeoutResolver.commandSignature("env make all")).toBe("make all");
	});

	it("handles a single-token command", () => {
		expect(DynamicTimeoutResolver.commandSignature("git")).toBe("git");
		expect(DynamicTimeoutResolver.commandSignature("ls")).toBe("ls");
	});

	it("returns empty string for empty or whitespace-only input", () => {
		expect(DynamicTimeoutResolver.commandSignature("")).toBe("");
		expect(DynamicTimeoutResolver.commandSignature("   ")).toBe("");
		expect(DynamicTimeoutResolver.commandSignature("\t\n")).toBe("");
	});
});

describe("DynamicTimeoutResolver.resolve", () => {
	it("returns undefined when fewer than MIN_SAMPLES (3) samples exist", () => {
		const r = new DynamicTimeoutResolver();
		r.record("git status", 50);
		r.record("git status", 60);
		expect(r.resolve("git status", 2, 10, 600, 300)).toBeUndefined();
	});

	it("at 3 samples with fast wall times, floors at staticDefaultSec (conservative)", () => {
		const r = new DynamicTimeoutResolver();
		for (const ms of [50, 60, 55]) r.record("git status", ms);
		// p90 of [50,55,60] = 60ms; predicted = ceil(0.06 * 2) = 1s
		// confidenceRatio = 0 → floor = 300 → max(300, 1) = 300
		const result = r.resolve("git status", 2, 10, 600, 300);
		expect(result?.timeoutSec).toBe(300);
	});

	it("at 20 samples with fast wall times, floor drops to ~30s (aggressive)", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 20; i++) r.record("git status", 50);
		// confidenceRatio = 1 → floor = ceil(300 * 0.1) = 30
		// predicted = ceil(0.05 * 2) = 1 → max(30, 1) = 30
		const result = r.resolve("git status", 2, 10, 600, 300);
		expect(result?.timeoutSec).toBe(30);
	});

	it("extends beyond static default for slow commands", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 20; i++) r.record("npm test", 200_000); // 200s each
		// p90 = 200_000ms; predicted = ceil(200 * 2) = 400
		// floor = 30 → max(30, 400) = 400 → clamp(10, 600, 400) = 400
		const result = r.resolve("npm test", 2, 10, 600, 300);
		expect(result?.timeoutSec).toBe(400);
	});

	it("clamps to maxSec when predicted exceeds the ceiling", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 20; i++) r.record("npm test", 400_000); // 400s each
		// p90 = 400_000ms; predicted = ceil(400 * 2) = 800
		// max(30, 800) = 800 → clamp(10, 600, 800) = 600
		const result = r.resolve("npm test", 2, 10, 600, 300);
		expect(result?.timeoutSec).toBe(600);
	});

	it("clamps to minSec when the confidence floor would go below it", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 20; i++) r.record("ls", 5); // 5ms each
		// floor = 30; predicted = ceil(0.005 * 2) = 1 → max(30, 1) = 30
		// clamp(120, 600, 30) = 120
		const result = r.resolve("ls", 2, 120, 600, 300);
		expect(result?.timeoutSec).toBe(120);
	});

	it("returns a DynamicTimeoutResult with all fields", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 20; i++) r.record("git status", 50);
		const result = r.resolve("git status", 2, 10, 600, 300);
		expect(result).toBeDefined();
		expect(result).toEqual({
			timeoutSec: 30,
			sampleCount: 20,
			p90Ms: 50,
			signature: "git status",
		});
	});
});

describe("DynamicTimeoutResolver.record", () => {
	it("maintains a rolling window of the last 20 samples", () => {
		const r = new DynamicTimeoutResolver();
		// Record 25 samples at 10ms, then 5 at 5000ms.
		// If the window keeps only 20, the p90 reflects the recent slow batch.
		for (let i = 0; i < 25; i++) r.record("cargo build", 10);
		for (let i = 0; i < 5; i++) r.record("cargo build", 5000);
		// After 30 records, window should have 20 samples: 15 at 10ms + 5 at 5000ms.
		// Sorted: [10×15, 5000×5]. p90 index = floor(20 * 0.9) = 18 → 5000ms.
		const result = r.resolve("cargo build", 1, 10, 600, 300);
		expect(result?.sampleCount).toBe(20);
		expect(result?.p90Ms).toBe(5000);
	});

	it("keeps separate histories per command signature", () => {
		const r = new DynamicTimeoutResolver();
		for (let i = 0; i < 5; i++) r.record("git status", 50);
		for (let i = 0; i < 5; i++) r.record("npm test", 200_000);

		const gitResult = r.resolve("git status", 2, 10, 600, 300);
		const npmResult = r.resolve("npm test", 2, 10, 600, 300);

		// git status: fast → 5 samples, p90=50ms, floor=300 (conservative at 5 samples)
		// confidenceRatio = (5-3)/(20-3) = 2/17 ≈ 0.118
		// floor = ceil(300 * (1 - 0.9*0.118)) = ceil(300 * 0.894) = 269
		// predicted = ceil(0.05 * 2) = 1 → max(269, 1) = 269
		expect(gitResult?.timeoutSec).toBe(269);

		// npm test: slow → p90=200s, predicted=400, floor=269 → max(269, 400) = 400
		expect(npmResult?.timeoutSec).toBe(400);
	});
});
