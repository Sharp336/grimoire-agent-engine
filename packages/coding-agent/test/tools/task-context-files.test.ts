import { describe, expect, it } from "bun:test";
import { inheritContextFilesForSubagent } from "../../src/task/context-files";
import type { ToolSession } from "../../src/tools";

describe("task context file inheritance", () => {
	it("preserves AGENTS.md files for subagents", () => {
		const contextFiles = [
			{ path: "/tmp/AGENTS.md", content: "repo rules" },
			{ path: "/tmp/notes.txt", content: "notes" },
		] satisfies NonNullable<ToolSession["contextFiles"]>;

		expect(inheritContextFilesForSubagent(contextFiles)).toEqual(contextFiles);
	});
});
