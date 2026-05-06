import { describe, expect, test } from "bun:test";
import { UserProfiler } from "../src/user-profiler";
import type { SessionTrace } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "test-session",
		cwd: "/tmp",
		userPrompt: overrides.userPrompt ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
		entries: overrides.entries ?? [],
	};
}

describe("UserProfiler", () => {
	test("initial profile has empty stats", () => {
		const profiler = new UserProfiler();
		const profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(0);
		expect(profile.errorRate).toBe(0);
		expect(Object.keys(profile.toolFrequency)).toHaveLength(0);
	});

	test("updateProfile increments tool frequency", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolFrequency["read"]).toBe(2);
		expect(profile.toolFrequency["edit"]).toBe(1);
		expect(profile.sessionCount).toBe(1);
	});

	test("updateProfile tracks tool transitions", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolTransitions["read→edit"]).toBe(1);
	});

	test("updateProfile calculates error rate", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace({ errorCount: 1 }), "bugfix");
		profiler.updateProfile(makeTrace({ errorCount: 0 }), "feature-add");
		const profile = profiler.getProfile();
		expect(profile.errorRate).toBe(0.5);
	});

	test("updateProfile tracks intent distribution", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "bugfix");
		const profile = profiler.getProfile();
		expect(profile.intentDistribution["refactoring"]).toBe(2);
		expect(profile.intentDistribution["bugfix"]).toBe(1);
	});

	test("updateProfile detects preferred languages from files", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/auth.ts" } },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/main.rs" } },
			],
		});
		profiler.updateProfile(trace, "feature-add");
		const profile = profiler.getProfile();
		expect(profile.preferredLanguages).toContain("typescript");
		expect(profile.preferredLanguages).toContain("rust");
	});

	test("serialize and deserialize preserves data", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace({ entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} }] }), "exploration");
		const json = profiler.serialize();
		const restored = UserProfiler.deserialize(json);
		expect(restored.getProfile().toolFrequency["read"]).toBe(1);
		expect(restored.getProfile().sessionCount).toBe(1);
	});
});
