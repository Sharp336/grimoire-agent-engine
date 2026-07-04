import { describe, expect, it } from "bun:test";
import {
	CURSOR_GREP_EMPTY_PATTERN_ERROR,
	mapCursorGrepExecArgs,
} from "../src/providers/cursor-grep-bridge";

describe("mapCursorGrepExecArgs", () => {
	it("maps path, glob, and case-insensitive flag to omp grep args", () => {
		const mapped = mapCursorGrepExecArgs({
			pattern: "foo",
			path: "src",
			glob: "**/*.ts",
			caseInsensitive: true,
		});
		expect(mapped.error).toBeUndefined();
		expect(mapped.ompArgs).toEqual({
			pattern: "foo",
			path: "src/**/*.ts",
			case: false,
		});
	});

	it("rejects empty patterns before the grep tool runs", () => {
		const mapped = mapCursorGrepExecArgs({
			pattern: "   ",
			path: "packages",
			glob: "**/*.ts",
		});
		expect(mapped.ompArgs).toEqual({ pattern: "", path: "packages/**/*.ts" });
		expect(mapped.error).toBe(CURSOR_GREP_EMPTY_PATTERN_ERROR);
	});
});
