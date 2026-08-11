import { describe, expect, test } from "bun:test";
import { SessionLoopController, SessionLoopScheduler } from "@oh-my-pi/pi-coding-agent/session/session-loop";

describe("session loop authority", () => {
	test("schedules bounded actions serially and preserves request causation", async () => {
		const controller = new SessionLoopController();
		controller.enable({
			action: "compact",
			prompt: "Continue",
			limit: { kind: "iterations", iterations: 2 },
		});
		const actions: string[] = [];
		const scheduler = new SessionLoopScheduler(
			{
				getLoopState: () => controller.snapshot,
				beginLoopIteration: () => controller.beginIteration(),
				disableLoop: () => controller.disable(),
			},
			{
				waitForIdle: async () => {},
				compact: async () => {
					actions.push("compact");
				},
				reset: async () => {
					actions.push("reset");
				},
				prompt: async (prompt, causationId) => {
					actions.push(`prompt:${prompt}:${causationId}`);
				},
				onStateChange: () => {},
				onError: cause => {
					throw cause;
				},
			},
		);

		scheduler.request("request-1");
		await scheduler.waitForSettled();

		expect(actions).toEqual(["compact", "prompt:Continue:request-1", "compact", "prompt:Continue:request-1"]);
		expect(controller.snapshot).toMatchObject({ enabled: false, phase: "disabled" });
	});

	test("pause prevents a stale prompt after a maintenance action", async () => {
		const controller = new SessionLoopController();
		controller.enable({ action: "reset", prompt: "Continue" });
		const prompts: string[] = [];
		const scheduler = new SessionLoopScheduler(
			{
				getLoopState: () => controller.snapshot,
				beginLoopIteration: () => controller.beginIteration(),
				disableLoop: () => controller.disable(),
			},
			{
				waitForIdle: async () => {},
				compact: async () => {},
				reset: async () => {
					controller.pause();
				},
				prompt: async prompt => {
					prompts.push(prompt);
				},
				onStateChange: () => {},
				onError: cause => {
					throw cause;
				},
			},
		);

		scheduler.request();
		await scheduler.waitForSettled();

		expect(prompts).toEqual([]);
		expect(controller.snapshot).toMatchObject({ enabled: true, phase: "paused" });
	});
});
