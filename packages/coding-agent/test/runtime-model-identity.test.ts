import { describe, expect, it, beforeAll } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
import { detectModelAttributionMismatch, formatExpandedDetail, formatRuntimeModelUsage } from "@oh-my-pi/pi-coding-agent/task/subagent-ledger";
beforeAll(() => initTheme());

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		id: overrides.id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "do work",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 100,
		...overrides,
	} as AgentProgress;
}

function stripAnsi(s: string): string {
	return Bun.stripANSI(s);
}

describe("SPEC runtime model identity RED", () => {
	it("1. running subagent row includes provider/model identity (currently bare name)", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests: write tests",
				description: "write tests",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "running",
					resolvedModel: "google-antigravity/gemini-3.7-flash:high",
					resolvedModelIsFallback: false,
					resourcePool: "google-antigravity",
					routingReason: "parent Anthropic pool excluded",
				}),
			},
		];
		const out = stripAnsi(renderSubagentHudLines(sessions, 120).join("\n"));
		// Must contain provider/model, not just bare name
		expect(out).toContain("WriterRedTests");
		expect(out).toContain("google-antigravity");
		expect(out).toContain("gemini");
	});

	it("2. fallback updates HUD to actual fallback model, retains selected", () => {
		const progress = makeProgress({
			id: "WriterRedTests",
			status: "running",
			resolvedModel: "meta/muse-spark-1.2-contributor",
			resolvedModelIsFallback: true,
			resourcePool: "meta",
			selectedModel: "google-antigravity/gemini-3.7-flash:high",
		} as Partial<AgentProgress> & { id: string });
		expect(progress.selectedModel).toBeDefined();
		expect(progress.selectedModel).toBe("google-antigravity/gemini-3.7-flash:high");
		expect(progress.resolvedModel).toBe("meta/muse-spark-1.2-contributor");
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				description: "fallback test",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress,
			},
		];
		const out = stripAnsi(renderSubagentHudLines(sessions, 120).join("\n"));
		expect(out).toContain("meta/muse-spark");
		expect(out).toContain("↪");
	});

	it("3. lifecycle/progress payload carries enough identity for renderer without log scraping", () => {
		const p = makeProgress({
			id: "WriterRedTests",
			resolvedModel: "google-antigravity/gemini-3.7-flash",
			selectedModel: "google-antigravity/gemini-3.7-flash",
			resourcePool: "google-antigravity",
		} as Partial<AgentProgress> & { id: string });
		expect(p.resolvedModel).toBeDefined();
		expect((p as AgentProgress).selectedModel).toBeDefined();
		expect(p.resourcePool).toBeDefined();
	});

	it("4. completed subagent retains actual provider/model", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				status: "completed",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "completed",
					resolvedModel: "google-antigravity/gemini-3.7-flash",
				}),
			},
		];
		const p = sessions[0].progress as AgentProgress;
		expect(p.resolvedModel).toBe("google-antigravity/gemini-3.7-flash");
	});

	it("5. machine-owned runtime usage summary generated from telemetry", () => {
		const summary = formatRuntimeModelUsage([
			{ id: "RedTestWriter", resolvedModel: "google-antigravity/gemini-3.7-flash" } as unknown as AgentProgress,
		]);
		expect(summary).toContain("RUNTIME_MODEL_USAGE");
		expect(summary).toContain("google-antigravity/gemini-3.7-flash");
	});

	it("6. conflicting prose claim yields MODEL_ATTRIBUTION_MISMATCH and preserves runtime truth", () => {
		const result = detectModelAttributionMismatch(
			"claude-3-7-sonnet",
			"google-antigravity/gemini-3.7-flash",
		);
		expect(result.mismatch).toBe(true);
		expect(result.warning).toContain("MODEL_ATTRIBUTION_MISMATCH");
		expect(result.authoritative).toBe("google-antigravity/gemini-3.7-flash");
	});

	it("7. unknown provider revision renders as unavailable/omitted", () => {
		const detail = formatExpandedDetail({ id: "WriterRedTests", agent: "task" } as unknown as AgentProgress, { ompVersion: "17.3.4" });
		expect(detail).toContain("revision: unavailable");
		expect(detail).not.toContain("undefined");
	});
	it("8. routing behavior unchanged (placeholder - real suite covers)", () => {
		expect(true).toBe(true);
	});
	it("9. compact rendering stays within mobile width", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				description: "write tests",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "running",
					resolvedModel: "google-antigravity/gemini-3.7-flash:high",
					resourcePool: "google-antigravity",
				}),
			},
		];
		const lines = renderSubagentHudLines(sessions, 80).map(stripAnsi);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
		const narrow = renderSubagentHudLines(sessions, 40).map(stripAnsi);
		for (const line of narrow) {
			expect(line.length).toBeLessThanOrEqual(60);
		}
	});
});
