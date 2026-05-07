import { describe, expect, test } from "bun:test";
import { ErrorPatternExtractor } from "../src/error-pattern-extractor";
import type { SessionTrace } from "../src/types";

function makeTrace(errorDetails: string[]): SessionTrace {
	return {
		sessionId: "test-session-1",
		cwd: "/test",
		userPrompt: "test",
		startTime: 0,
		endTime: 1,
		entries: [],
		toolCallCount: 0,
		errorCount: errorDetails.length,
		hadRecovery: false,
		completedSuccessfully: errorDetails.length === 0,
		errorDetails,
	};
}

describe("ErrorPatternExtractor", () => {
	const extractor = new ErrorPatternExtractor();

	test("edit-payload-format pattern detected", () => {
		const trace = makeTrace(["line 3: unrecognized op"]);
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(1);
		expect(patterns[0].id).toBe("edit-payload-format");
		expect(patterns[0].category).toBe("format");
		expect(patterns[0].affectedSessions).toContain("test-session-1");
	});

	test("file-not-found pattern detected", () => {
		const trace = makeTrace(["ENOENT: no such file or directory"]);
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(1);
		expect(patterns[0].id).toBe("file-not-found");
		expect(patterns[0].category).toBe("not_found");
	});

	test("multiple errors match multiple patterns", () => {
		const trace = makeTrace([
			"line 3: unrecognized op",
			"ENOENT: no such file or directory",
			"TypeError: Cannot read property 'foo' of undefined",
		]);
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(3);
		const ids = patterns.map(p => p.id);
		expect(ids).toContain("edit-payload-format");
		expect(ids).toContain("file-not-found");
		expect(ids).toContain("type-error");
	});

	test("same pattern deduplicated within single trace", () => {
		const trace = makeTrace(["ENOENT: file A missing", "ENOENT: file B missing"]);
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(1);
		expect(patterns[0].count).toBe(1);
		expect(patterns[0].affectedSessions).toEqual(["test-session-1"]);
	});

	test("no errorDetails returns empty array", () => {
		const trace = makeTrace([]);
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(0);
	});

	test("undefined errorDetails returns empty array", () => {
		const trace: SessionTrace = {
			sessionId: "test-session-2",
			cwd: "/test",
			userPrompt: "test",
			startTime: 0,
			endTime: 1,
			entries: [],
			toolCallCount: 0,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
		};
		const patterns = extractor.extract(trace);
		expect(patterns.length).toBe(0);
	});
});
