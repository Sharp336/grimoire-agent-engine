import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { taskSchema, taskSchemaNoIsolation } from "@oh-my-pi/pi-coding-agent/task/types";
import { Value } from "@sinclair/typebox/value";

describe("task schema async field", () => {
	test("taskSchema accepts async: true", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
			async: true,
		};

		const valid = Value.Check(taskSchema, taskParams);
		expect(valid).toBe(true);
	});

	test("taskSchema accepts async: false", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
			async: false,
		};

		const valid = Value.Check(taskSchema, taskParams);
		expect(valid).toBe(true);
	});

	test("taskSchema accepts missing async (optional)", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
		};

		const valid = Value.Check(taskSchema, taskParams);
		expect(valid).toBe(true);
	});

	test("taskSchemaNoIsolation accepts async: true", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
			async: true,
		};

		const valid = Value.Check(taskSchemaNoIsolation, taskParams);
		expect(valid).toBe(true);
	});

	test("taskSchemaNoIsolation accepts missing async (optional)", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
		};

		const valid = Value.Check(taskSchemaNoIsolation, taskParams);
		expect(valid).toBe(true);
	});

	test("taskSchema rejects non-boolean async field", () => {
		const taskParams = {
			agent: "general",
			tasks: [
				{
					id: "task1",
					description: "Test task",
					assignment: "Do something",
				},
			],
			async: "true",
		};

		const valid = Value.Check(taskSchema, taskParams);
		expect(valid).toBe(false);
	});
});

describe("task.maxAsyncTasks setting", () => {
	test("defaults to 15", () => {
		const settings = Settings.isolated();
		expect(settings.get("task.maxAsyncTasks")).toBe(15);
	});

	test("setting can be retrieved as a number", () => {
		const settings = Settings.isolated();
		const value = settings.get("task.maxAsyncTasks");
		expect(typeof value).toBe("number");
	});
});
