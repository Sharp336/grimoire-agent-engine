import { describe, expect, it } from "bun:test";
import {
	createParentSubagentLifecycleRecorder,
	createSubagentLifecycleEmitter,
	createSubagentLifecycleRun,
} from "@oh-my-pi/pi-coding-agent/task/subagent-lifecycle";
import type { SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task/types";

describe("subagent run lifecycle timing", () => {
	it("emits one completion boundary independently from retained session lifetime", () => {
		const emitted: SubagentLifecyclePayload[] = [];
		const persisted: Array<{ customType: string; data: SubagentLifecyclePayload }> = [];
		const emit = createSubagentLifecycleEmitter({
			emitEvent: payload => emitted.push(payload),
			appendEntry: (customType, data) => persisted.push({ customType, data }),
		});
		const run = createSubagentLifecycleRun({
			id: "TimingScout",
			agent: "scout",
			agentSource: "bundled",
			index: 0,
			runKind: "initial",
			startedMonotonicAt: 500,
			startedAt: 1_000,
			emit,
		});
		const completed = run.complete("completed", 1_625, 1_125);

		expect(emitted).toHaveLength(2);
		expect(emitted[0]).toMatchObject({
			version: 1,
			runKind: "initial",
			status: "started",
			startedAt: 1_000,
		});
		expect(completed).toEqual(emitted[1]);
		expect(completed).toMatchObject({
			version: 1,
			runId: emitted[0]!.runId,
			runKind: "initial",
			status: "completed",
			startedAt: 1_000,
			completedAt: 1_625,
			durationMs: 625,
		});
		expect(persisted).toEqual([
			{ customType: "task_subagent_lifecycle", data: emitted[0]! },
			{ customType: "task_subagent_lifecycle", data: emitted[1]! },
		]);
	});

	it("stops recording into a parent session once disposal begins", () => {
		const persisted: Array<{ customType: string; data: SubagentLifecyclePayload }> = [];
		let disposed = false;
		const record = createParentSubagentLifecycleRecorder({
			getSessionManager: () => ({
				appendCustomEntry: (customType, data) => {
					persisted.push({ customType, data: data as SubagentLifecyclePayload });
					return "entry";
				},
			}),
			isDisposed: () => disposed,
		});
		const payload: SubagentLifecyclePayload = {
			version: 1,
			runId: "run-1",
			runKind: "irc_wake",
			id: "Worker",
			agent: "task",
			agentSource: "bundled",
			index: 0,
			status: "started",
			startedAt: 1_000,
		};

		record?.(payload);
		disposed = true;
		record?.({ ...payload, status: "completed", completedAt: 1_100, durationMs: 100 });

		expect(persisted).toEqual([{ customType: "task_subagent_lifecycle", data: payload }]);
	});

	it("rejects duplicate terminal boundaries", () => {
		const run = createSubagentLifecycleRun({
			id: "TimingScout",
			agent: "scout",
			agentSource: "bundled",
			index: 0,
			startedMonotonicAt: 1_000,
			runKind: "irc_wake",
			startedAt: 2_000,
			emit: () => {},
		});
		run.complete("failed", 2_100, 1_100);
		expect(() => run.complete("completed", 2_200, 1_200)).toThrow("already completed");
	});
});
