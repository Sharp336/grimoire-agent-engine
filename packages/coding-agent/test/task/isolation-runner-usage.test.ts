import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type IsolatedRunOptions, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "UsageAccounting",
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function runOptions(overrides: Partial<IsolatedRunOptions> = {}) {
	return {
		baseOptions: {
			cwd: "/repo",
			agent: {
				name: "task",
				description: "Task agent",
				systemPrompt: "test",
				source: "bundled" as const,
			},
			task: "Do work",
			index: 0,
			id: "UsageAccounting",
		},
		context: {
			repoRoot: "/repo",
			baseline: {
				root: {
					repoRoot: "/repo",
					headCommit: "base",
					staged: "",
					unstaged: "",
					untracked: [],
					untrackedPatch: "",
				},
				nested: [],
			},
		},
		preferredBackend: undefined,
		agentId: "UsageAccounting",
		mergeMode: "patch" as const,
		artifactsDir: "/artifacts",
		buildFailureResult: (error: unknown) => createResult({ exitCode: 1, error: String(error) }),
		...overrides,
	};
}

describe("isolated subprocess usage observation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("charges real child output exactly once before fallible isolation cleanup", async () => {
		const subagentOutputTokens = 1_234;
		const turnBudgetTokens = 100_000;
		const childResult = createResult({
			exitCode: 1,
			error: "agent failed",
			usage: {
				input: 9_000,
				output: subagentOutputTokens,
				cacheRead: 8_000,
				cacheWrite: 7_000,
				totalTokens: 24_000 + subagentOutputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(turnBudgetTokens, true);
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult);
		vi.spyOn(worktreeModule, "cleanupIsolation").mockRejectedValue(new Error("cleanup failed"));
		const onSubprocessResult = vi.fn((result: SingleResult) => {
			sessionManager.recordEvalSubagentOutput(result.usage?.output ?? 0);
		});

		await expect(runIsolatedSubprocess(runOptions({ onSubprocessResult }))).rejects.toThrow("cleanup failed");

		expect(onSubprocessResult).toHaveBeenCalledTimes(1);
		expect(sessionManager.getTurnBudget()).toEqual({
			total: turnBudgetTokens,
			spent: subagentOutputTokens,
			hard: true,
		});
	});

	it("does not observe a synthetic failure when isolation setup fails before the child starts", async () => {
		vi.spyOn(worktreeModule, "ensureIsolation").mockRejectedValue(new Error("setup failed"));
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess");
		const onSubprocessResult = vi.fn();

		const outcome = await runIsolatedSubprocess(runOptions({ onSubprocessResult }));

		expect(runSubprocess).not.toHaveBeenCalled();
		expect(onSubprocessResult).not.toHaveBeenCalled();
		expect(outcome.error).toContain("setup failed");
	});
});
