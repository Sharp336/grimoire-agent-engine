/**
 * Contract tests for double-encoded JSON string repair.
 *
 * Models occasionally JSON-escape string values twice when emitting `task` tool
 * calls. `repairDoubleEncodedJsonString` detects and reverses this, while
 * leaving genuine prose (Windows paths, regexes, literal escape mentions)
 * untouched. `repairTaskParams` applies the repair to task tool params.
 */
import { describe, expect, it } from "bun:test";
import { repairDoubleEncodedJsonString, repairTaskParams } from "../../src/task/repair-args";
import type { TaskParams } from "../../src/task/types";

describe("repairDoubleEncodedJsonString", () => {
	it("repairs double-encoded newlines, quotes, and unicode", () => {
		// The literal text a double-encoded string would contain after one JSON decode:
		// \n (backslash-n), \" (backslash-quote), \u2014 (backslash-u2014)
		const input = '# Role\\nYou are a judge \u2026 \\"describe this\\" \u2026 return \\u2014';
		const expected = '# Role\nYou are a judge … "describe this" … return —';
		expect(repairDoubleEncodedJsonString(input)).toBe(expected);
	});

	it("leaves normal prose untouched", () => {
		const input = "Read the file and report back what you find.";
		expect(repairDoubleEncodedJsonString(input)).toBe(input);
	});

	it("leaves strings with no backslash untouched (fast path)", () => {
		const input = "No escapes here at all";
		expect(repairDoubleEncodedJsonString(input)).toBe(input);
	});

	it("leaves a lone \\n mention untouched (incidental, not double-encoded)", () => {
		// A single \n in prose like "split lines on \n" is likely a literal mention.
		// It has no structural escape (\", \\, \uXXXX) and only one backslash,
		// so hasDoubleEncodeSignature returns false.
		const input = "Split the output on \\n characters.";
		expect(repairDoubleEncodedJsonString(input)).toBe(input);
	});

	it("repairs strings with structural escapes (backslash-quote)", () => {
		// The \" triggers detection; the whole string is valid JSON when wrapped in quotes
		const input = 'She said \\"hello\\" and left';
		const expected = 'She said "hello" and left';
		expect(repairDoubleEncodedJsonString(input)).toBe(expected);
	});

	it("repairs strings with backslash-backslash", () => {
		// The \\ triggers detection (structural escape)
		const input = "Path is C:\\\\Users\\\\test";
		const expected = "Path is C:\\Users\\test";
		expect(repairDoubleEncodedJsonString(input)).toBe(expected);
	});

	it("leaves Windows paths with single backslash untouched", () => {
		// C:\Users — \U is not a valid JSON escape, so JSON.parse throws
		const input = "The file is at C:\\Users\\test\\file.txt";
		expect(repairDoubleEncodedJsonString(input)).toBe(input);
	});

	it("leaves regex patterns untouched", () => {
		// \d is not a valid JSON escape, so JSON.parse throws
		const input = "Match with /\\d+\\.\\d+/";
		expect(repairDoubleEncodedJsonString(input)).toBe(input);
	});

	it("returns same reference when nothing changed", () => {
		const input = "Normal text with no escapes";
		const result = repairDoubleEncodedJsonString(input);
		expect(result).toBe(input);
	});
});

describe("repairTaskParams", () => {
	it("repairs double-encoded assignment in flat form", () => {
		// The \" triggers detection; the \n is also decoded
		const params: TaskParams = {
			agent: "coder",
			assignment: 'Fix the \\"bug\\"\\n in src/main.ts',
		};
		const result = repairTaskParams(params);
		expect(result.assignment).toBe('Fix the "bug"\n in src/main.ts');
	});

	it("repairs double-encoded description in flat form", () => {
		const params: TaskParams = {
			agent: "coder",
			assignment: "Normal assignment",
			description: 'Fix bug \\"123\\"',
		};
		const result = repairTaskParams(params);
		expect(result.description).toBe('Fix bug "123"');
	});

	it("repairs double-encoded context in batch form", () => {
		const params: TaskParams = {
			agent: "coder",
			context: 'Background\\"info\\"\\nhere',
			tasks: [{ assignment: "Do thing" }],
		};
		const result = repairTaskParams(params);
		expect(result.context).toBe('Background"info"\nhere');
	});

	it("repairs double-encoded fields in batch task items", () => {
		const params: TaskParams = {
			agent: "coder",
			context: "shared context",
			tasks: [
				{ assignment: 'Task \\"one\\"\\nwith newline', description: 'Desc\\"1\\"' },
				{ assignment: "Task two", description: "Normal desc" },
			],
		};
		const result = repairTaskParams(params);
		expect(result.tasks![0].assignment).toBe('Task "one"\nwith newline');
		expect(result.tasks![0].description).toBe('Desc"1"');
		expect(result.tasks![1].assignment).toBe("Task two");
		expect(result.tasks![1].description).toBe("Normal desc");
	});

	it("returns same reference when nothing needs repair", () => {
		const params: TaskParams = {
			agent: "coder",
			assignment: "Normal assignment text",
			description: "Normal description",
		};
		const result = repairTaskParams(params);
		expect(result).toBe(params);
	});

	it("handles null/undefined params defensively", () => {
		expect(repairTaskParams(null as unknown as TaskParams)).toBeNull();
		expect(repairTaskParams(undefined as unknown as TaskParams)).toBeUndefined();
	});

	it("handles params with undefined optional fields", () => {
		const params: TaskParams = { agent: "coder" };
		const result = repairTaskParams(params);
		expect(result).toBe(params);
	});

	it("handles partially streamed params (missing fields)", () => {
		const params: TaskParams = {
			agent: "coder",
			assignment: 'Fix \\"bug\\"\\n here',
		};
		const result = repairTaskParams(params);
		expect(result.assignment).toBe('Fix "bug"\n here');
		expect(result.description).toBeUndefined();
		expect(result.context).toBeUndefined();
		expect(result.tasks).toBeUndefined();
	});
});
