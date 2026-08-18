import { describe, expect, it } from "bun:test";
import {
	capIncompleteTodoRows,
	collectIncompleteTodoRows,
	formatIncompleteTodoSnapshotLines,
	formatIncompleteTodosSection,
	INCOMPLETE_TODOS_SNAPSHOT_CAP,
	upsertIncompleteTodosSection,
} from "@oh-my-pi/pi-coding-agent/session/incomplete-todos";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";

function phase(
	name: string,
	...tasks: Array<{ content: string; status: TodoPhase["tasks"][number]["status"] }>
): TodoPhase {
	return { name, tasks };
}

describe("incomplete todo snapshot helpers", () => {
	it("collects pending and in_progress rows with phase, status, and title", () => {
		const rows = collectIncompleteTodoRows([
			phase(
				"Work",
				{ content: "do the thing", status: "pending" },
				{ content: "wire it", status: "in_progress" },
				{ content: "shipped", status: "completed" },
				{ content: "blocked wait", status: "blocked" },
				{ content: "dropped", status: "abandoned" },
			),
			phase("Later", { content: "docs", status: "pending" }),
		]);
		expect(rows).toEqual([
			{ phase: "Work", status: "pending", title: "do the thing" },
			{ phase: "Work", status: "in_progress", title: "wire it" },
			{ phase: "Later", status: "pending", title: "docs" },
		]);
	});

	it("caps snapshot lines and appends + N more", () => {
		const rows = Array.from({ length: INCOMPLETE_TODOS_SNAPSHOT_CAP + 7 }, (_, index) => ({
			phase: "Work",
			status: index === 0 ? ("in_progress" as const) : ("pending" as const),
			title: `item ${index + 1}`,
		}));
		const lines = formatIncompleteTodoSnapshotLines(rows);
		expect(lines).toHaveLength(INCOMPLETE_TODOS_SNAPSHOT_CAP + 1);
		expect(lines[0]).toBe("[Work] [in_progress] item 1");
		expect(lines[1]).toBe("[Work] [pending] item 2");
		expect(lines.at(-1)).toBe("+ 7 more");
		expect(capIncompleteTodoRows(rows).overflow).toBe(7);
	});

	it("replaces a stale Incomplete Todos section and strips it when empty", () => {
		const stale = [
			"## Goal",
			"Ship the parser",
			"",
			"## Incomplete Todos",
			"These pending/in_progress items remain after compaction; continue them. A text-only stop is not completion.",
			"- Work",
			"  - [pending] old leftover",
			"",
			"## Next Steps",
			"1. Keep going",
			"",
		].join("\n");

		const replaced = upsertIncompleteTodosSection(
			stale,
			formatIncompleteTodosSection([{ phase: "Work", status: "in_progress", title: "new leftover" }]),
		);
		expect(replaced).toContain("## Goal");
		expect(replaced).toContain("## Next Steps");
		expect(replaced).toContain("[in_progress] new leftover");
		expect(replaced).not.toContain("old leftover");
		expect(replaced.indexOf("## Incomplete Todos")).toBeLessThan(replaced.indexOf("## Next Steps"));

		const stripped = upsertIncompleteTodosSection(replaced, undefined);
		expect(stripped).toContain("## Goal");
		expect(stripped).toContain("## Next Steps");
		expect(stripped).not.toContain("## Incomplete Todos");
		expect(stripped).not.toContain("new leftover");
	});
});
