import { describe, expect, it } from "bun:test";
import { repairDoubleEncodedJsonString, repairTaskParams } from "@oh-my-pi/pi-coding-agent/task/repair-args";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";

describe("repairDoubleEncodedJsonString", () => {
	it("decodes a uniformly double-encoded prose value", () => {
		// One JSON decode already applied by the provider; the value still
		// carries literal `\n`, `\"`, and `\u2014` because the model escaped twice.
		const doubled = '# Role\\nYou are a judge \\"describe this\\" return \\u2014';
		expect(repairDoubleEncodedJsonString(doubled)).toBe('# Role\nYou are a judge "describe this" return —');
	});

	it("decodes a double-encoded multi-line plain-text value", () => {
		expect(repairDoubleEncodedJsonString("line one\\nline two\\nline three")).toBe("line one\nline two\nline three");
	});

	it("preserves a Windows path (bare backslashes are not valid escapes)", () => {
		expect(repairDoubleEncodedJsonString("C:\\Users\\me")).toBe("C:\\Users\\me");
	});

	it("preserves a regex with a backslash class", () => {
		expect(repairDoubleEncodedJsonString("match \\d+ digits")).toBe("match \\d+ digits");
	});

	it("preserves text containing a bare double quote", () => {
		expect(repairDoubleEncodedJsonString('she said "hi" loudly')).toBe('she said "hi" loudly');
	});

	it("leaves a lone literal \\n mention alone (no double-encode signature)", () => {
		expect(repairDoubleEncodedJsonString("split lines on \\n then count")).toBe("split lines on \\n then count");
	});

	it("is a no-op for plain text without escapes", () => {
		const plain = "just some normal instructions";
		expect(repairDoubleEncodedJsonString(plain)).toBe(plain);
	});

	it("leaves a partially-decoded value (real newline mixed with literal escape) untouched", () => {
		// A real newline cannot appear inside a JSON string literal unescaped, so
		// the round-trip parse throws and the value is preserved as-is.
		const mixed = "real\nnewline with \\t tab";
		expect(repairDoubleEncodedJsonString(mixed)).toBe(mixed);
	});
});

describe("repairDoubleEncodedJsonString — backslash-backslash", () => {
	it("decodes a double-encoded backslash-backslash sequence", () => {
		// The \\ triggers detection (structural escape); JSON.parse decodes \\ to \
		expect(repairDoubleEncodedJsonString("Path is C:\\\\Users\\\\test")).toBe("Path is C:\\Users\\test");
	});
});

describe("repairTaskParams — batch and defensive cases", () => {
	it("repairs double-encoded context in batch form", () => {
		const params = {
			agent: "coder",
			context: 'Background\\"info\\"\\nhere',
			tasks: [{ assignment: "Do thing" }],
		} as unknown as TaskParams;
		const result = repairTaskParams(params);
		expect(result.context).toBe('Background"info"\nhere');
	});

	it("repairs double-encoded fields in batch task items", () => {
		const params = {
			agent: "coder",
			context: "shared context",
			tasks: [
				{ assignment: 'Task \\"one\\"\\nwith newline', description: 'Desc\\"1\\"' },
				{ assignment: "Task two", description: "Normal desc" },
			],
		} as unknown as TaskParams;
		const result = repairTaskParams(params);
		expect(result.tasks![0].assignment).toBe('Task "one"\nwith newline');
		expect(result.tasks![0].description).toBe('Desc"1"');
		expect(result.tasks![1].assignment).toBe("Task two");
		expect(result.tasks![1].description).toBe("Normal desc");
	});

	it("handles null/undefined params defensively", () => {
		expect(repairTaskParams(null as unknown as TaskParams)).toBeNull();
		expect(repairTaskParams(undefined as unknown as TaskParams)).toBeUndefined();
	});

	it("handles params with undefined optional fields", () => {
		const params = { agent: "coder" } as unknown as TaskParams;
		expect(repairTaskParams(params)).toBe(params);
	});

	it("handles partially streamed params (missing fields)", () => {
		const params = {
			agent: "coder",
			assignment: 'Fix \\"bug\\"\\n here',
		} as unknown as TaskParams;
		const result = repairTaskParams(params);
		expect(result.assignment).toBe('Fix "bug"\n here');
		expect(result.description).toBeUndefined();
		expect(result.context).toBeUndefined();
		expect(result.tasks).toBeUndefined();
	});
});

describe("repairTaskParams", () => {
	it("repairs assignment and description, leaving agent/id intact", () => {
		const params = {
			agent: "task",
			id: "FirstTask",
			description: 'judge \\"sketch\\" accuracy',
			assignment: "Score 0-100.\\nUse the full range.\\nNo bunching.",
		} as unknown as TaskParams;

		const repaired = repairTaskParams(params);
		expect(repaired.agent).toBe("task");
		expect(repaired.id).toBe("FirstTask");
		expect(repaired.description).toBe('judge "sketch" accuracy');
		expect(repaired.assignment).toBe("Score 0-100.\nUse the full range.\nNo bunching.");
	});

	it("returns the same reference when nothing needs repair", () => {
		const params = {
			agent: "task",
			id: "A",
			description: "label",
			assignment: "do work",
		} as unknown as TaskParams;
		expect(repairTaskParams(params)).toBe(params);
	});
});
