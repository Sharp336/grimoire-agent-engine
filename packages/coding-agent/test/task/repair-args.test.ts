import { describe, expect, it } from "bun:test";
import { repairTaskParams } from "@oh-my-pi/pi-coding-agent/task/repair-args";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";

describe("repairTaskParams", () => {
	it("should parse tasks array if it is double-encoded as a JSON string", () => {
		const params = {
			context: "shared context",
			tasks: JSON.stringify([
				{ name: "task1", task: "do A \\n then \\n do B" }
			])
		} as unknown as TaskParams; // Cast to TaskParams to satisfy type checking for test payload

		const repaired = repairTaskParams(params);
		expect(Array.isArray(repaired.tasks)).toBe(true);
		expect(repaired.tasks?.[0]?.task).toBe("do A \n then \n do B");
	});

	it("should parse individual tasks if they are double-encoded as JSON strings inside the array", () => {
		const params = {
			context: "shared context",
			tasks: [
				JSON.stringify({ name: "task1", task: "do A \\n then \\n do B" })
			]
		} as unknown as TaskParams; // Cast to TaskParams for test validation

		const repaired = repairTaskParams(params);
		expect(Array.isArray(repaired.tasks)).toBe(true);
		expect(typeof repaired.tasks?.[0]).toBe("object");
		expect(repaired.tasks?.[0]?.task).toBe("do A \n then \n do B");
	});
});
