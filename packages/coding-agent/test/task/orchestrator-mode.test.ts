import { describe, expect, it } from "bun:test";
import { resolveTaskIsolation, resolveTaskMergeMode } from "../../src/task/orchestrator-mode";
import { getTaskSchema } from "../../src/task/types";

describe("task orchestrator mode helpers", () => {
	it("auto-isolates edit-capable agents with a worktree fallback", () => {
		const result = resolveTaskIsolation({
			configuredMode: "none",
			isolationRequested: false,
			orchestratorMode: true,
			agent: { tools: ["read", "edit"] },
		});

		expect(result).toEqual({ autoIsolation: true, taskIsolationMode: "worktree" });
	});

	it("keeps read-only agents non-isolated in orchestrator mode", () => {
		const result = resolveTaskIsolation({
			configuredMode: "none",
			isolationRequested: false,
			orchestratorMode: true,
			agent: { tools: ["read", "grep", "find"] },
		});

		expect(result).toEqual({ autoIsolation: false, taskIsolationMode: "none" });
	});

	it("preserves explicit isolation failure semantics outside orchestrator mode", () => {
		const result = resolveTaskIsolation({
			configuredMode: "none",
			isolationRequested: true,
			orchestratorMode: false,
			agent: { tools: ["read", "edit"] },
		});

		expect(result).toEqual({ autoIsolation: false, taskIsolationMode: "none" });
	});

	it("disables isolation for sub-sub-tasks (taskDepth > 0) even when orchestrator and agent request it", () => {
		const result = resolveTaskIsolation({
			configuredMode: "reflink",
			isolationRequested: true,
			orchestratorMode: true,
			agent: { tools: ["read", "edit"] },
			taskDepth: 1,
		});

		// Nested isolation would stack snapshots or branch from an already-isolated worktree;
		// both degenerate. Sub-sub-tasks run inline in the parent task's worktree.
		expect(result).toEqual({ autoIsolation: false, taskIsolationMode: "none" });
	});

	it("forces branch integration for orchestrator sessions", () => {
		expect(resolveTaskMergeMode({ configuredMode: "patch", orchestratorMode: true })).toBe("branch");
		expect(resolveTaskMergeMode({ configuredMode: "branch", orchestratorMode: false })).toBe("branch");
		expect(resolveTaskMergeMode({ configuredMode: "patch", orchestratorMode: false })).toBe("patch");
	});

	it("forces patch integration for nested subagents regardless of configured merge mode", () => {
		expect(resolveTaskMergeMode({ configuredMode: "branch", orchestratorMode: true, taskDepth: 1 })).toBe("patch");
		expect(resolveTaskMergeMode({ configuredMode: "branch", orchestratorMode: false, taskDepth: 2 })).toBe("patch");
	});
});

describe("task schema isolation visibility", () => {
	it("exposes the isolated field at top-level, non-orchestrator sessions", () => {
		const schema = getTaskSchema({
			isolationEnabled: true,
			simpleMode: "default",
			orchestratorMode: false,
			taskDepth: 0,
		});
		expect("isolated" in schema.properties).toBe(true);
	});

	it("hides the isolated field in orchestrator mode", () => {
		const schema = getTaskSchema({
			isolationEnabled: true,
			simpleMode: "default",
			orchestratorMode: true,
			taskDepth: 0,
		});
		expect("isolated" in schema.properties).toBe(false);
	});

	it("hides the isolated field for nested subagents (taskDepth > 0)", () => {
		const schema = getTaskSchema({
			isolationEnabled: true,
			simpleMode: "default",
			orchestratorMode: false,
			taskDepth: 1,
		});
		expect("isolated" in schema.properties).toBe(false);
	});
});
