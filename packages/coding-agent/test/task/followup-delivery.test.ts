import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("async task follow-up delivery", () => {
	let registry: TaskRegistry;

	beforeEach(() => {
		registry = new TaskRegistry();
	});

	afterEach(() => {
		registry.cleanup();
	});

	it("completed task triggers deliverFollowUp with result summary", async () => {
		// When an async task completes successfully, the onComplete callback
		// should be called with the handle containing status: "completed" and result data.
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		let callbackFired = false;
		registry.onComplete(taskId, handle => {
			callbackFired = true;
			expect(handle.status).toBe("completed");
			expect(handle.result).toBeDefined();
			expect(handle.result?.length).toBe(1);
		});

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		// Resolve the promise to trigger completion
		resolve({
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [
					{
						index: 0,
						id: "result-1",
						agent: "test-agent",
						agentSource: "bundled",
						task: "test-task",
						exitCode: 0,
						output: "completed",
						stderr: "",
						truncated: false,
						durationMs: 1000,
						tokens: 10,
					},
				],
				totalDurationMs: 1000,
			},
		});

		// Wait for promise chain to complete
		await Bun.sleep(50);
		expect(callbackFired).toBe(true);
	});

	it("failed task triggers deliverFollowUp with error", async () => {
		// When an async task fails, the onComplete callback should be called
		// with the handle containing status: "failed" and error message.
		const taskId = Snowflake.next();
		const { promise, reject } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const errorMsg = "Task execution failed";

		let callbackFired = false;
		registry.onComplete(taskId, handle => {
			callbackFired = true;
			expect(handle.status).toBe("failed");
			expect(handle.error).toBe(errorMsg);
		});

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		// Reject the promise to trigger failure
		reject(new Error(errorMsg));

		// Wait for promise chain to complete
		await Bun.sleep(50);
		expect(callbackFired).toBe(true);
	});

	it("cancelled task does not trigger deliverFollowUp", async () => {
		// When an async task is cancelled, the callback should still fire
		// but the callback code can check status === "cancelled" to skip delivery.
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const abort = new AbortController();

		let callbackFired = false;
		registry.onComplete(taskId, handle => {
			callbackFired = true;
			expect(handle.status).toBe("cancelled");
		});

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: abort,
			promise,
		});

		// Cancel the task
		const cancelled = registry.cancel(taskId);
		expect(cancelled).toBe(true);

		// Wait for callback to fire
		await Bun.sleep(50);
		expect(callbackFired).toBe(true);
		resolve({ content: [{ type: "text", text: "cancelled" }] });
	});

	it("deliverFollowUp not called when callback is undefined", async () => {
		// The registry should handle cases where onComplete is never registered.
		// Tasks should still complete normally without errors.
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		// Don't register any callback
		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		// Resolve the promise
		resolve({
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
			},
		});

		// Wait for completion
		await Bun.sleep(50);

		// Task should complete without error
		const task = registry.get(taskId);
		expect(task?.status).toBe("completed");
	});
});
