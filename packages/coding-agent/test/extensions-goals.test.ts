import { describe, expect, it } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ThreadGoal } from "../src/goals";

function goal(): ThreadGoal {
	return {
		threadId: "thread-a",
		goalId: "goal-a",
		objective: "finish",
		status: "active",
		tokenBudget: 100,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("extension goal hooks", () => {
	it("returns the first goal_status_change veto", async () => {
		const extension: Extension = {
			path: "goal-veto.ts",
			resolvedPath: "goal-veto.ts",
			handlers: new Map([
				[
					"goal_status_change",
					[
						async () => ({ allow: true }),
						async () => ({ allow: false, reason: "locked" }),
						async () => ({ allow: true }),
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const runtime: ExtensionRuntime = {
			flagValues: new Map(),
			pendingProviderRegistrations: [],
		} as unknown as ExtensionRuntime;
		const runner = new ExtensionRunner([extension], runtime, "/tmp", {} as SessionManager, {} as ModelRegistry);

		const result = await runner.emit({
			type: "goal_status_change",
			goal: goal(),
			proposed: { status: "complete" },
			reason: "tool",
		});

		expect(result).toEqual({ allow: false, reason: "locked" });
	});
});
