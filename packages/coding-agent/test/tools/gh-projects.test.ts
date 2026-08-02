import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	findProjectItemByContentUrl,
	formatProjectBoard,
	GithubTool,
	getProjectItemFieldValue,
	normalizeGithubContentUrl,
	parseProjectReference,
	resolveProjectBoardField,
	resolveProjectTemplate,
} from "@oh-my-pi/pi-coding-agent/tools/gh";

describe("parseProjectReference", () => {
	it("accepts a bare number when owner is supplied", () => {
		expect(parseProjectReference("2", "kourierai")).toEqual({ owner: "kourierai", number: 2 });
	});

	it("accepts a full orgs project URL and derives the owner from it", () => {
		expect(parseProjectReference("https://github.com/orgs/kourierai/projects/2", undefined)).toEqual({
			owner: "kourierai",
			number: 2,
		});
	});

	it("accepts a full users project URL", () => {
		expect(parseProjectReference("https://github.com/users/monalisa/projects/7", undefined)).toEqual({
			owner: "monalisa",
			number: 7,
		});
	});

	it("keeps trailing path segments out of the parsed number", () => {
		expect(parseProjectReference("https://github.com/orgs/kourierai/projects/2/views/1", undefined)).toEqual({
			owner: "kourierai",
			number: 2,
		});
	});

	it("prefers the owner embedded in a URL over an explicit owner argument", () => {
		// A URL is self-describing; an explicit owner is ignored so the two
		// cannot silently disagree.
		expect(parseProjectReference("https://github.com/orgs/kourierai/projects/2", "someone-else")).toEqual({
			owner: "kourierai",
			number: 2,
		});
	});

	it("rejects a bare number without an owner", () => {
		expect(() => parseProjectReference("2", undefined)).toThrow(/owner is required/);
	});

	it("rejects a malformed URL", () => {
		expect(() => parseProjectReference("https://github.com/kourierai/whatever", undefined)).toThrow();
		expect(() => parseProjectReference("not a project ref", undefined)).toThrow();
	});

	it("rejects an empty value", () => {
		expect(() => parseProjectReference(undefined, "kourierai")).toThrow(/project must be/);
	});
});

describe("resolveProjectTemplate", () => {
	it("distinguishes kanban (3-state) from team_planning (6-state)", () => {
		expect(resolveProjectTemplate("kanban")?.statusOptions).toEqual(["Todo", "In progress", "Done"]);
		expect(resolveProjectTemplate("kanban")?.fields).toBeUndefined();
		expect(resolveProjectTemplate("team_planning")?.statusOptions).toEqual([
			"No status",
			"Backlog",
			"Ready",
			"In progress",
			"In review",
			"Done",
		]);
		// "No status" is a real preset option (real boards carry it); the renderer
		// de-duplicates it against the synthetic bucket (see formatProjectBoard tests).
		expect(resolveProjectTemplate("team_planning")?.statusOptions).toContain("No status");
	});

	it("resolves the bug_tracker preset with single_select Priority + Severity", () => {
		const bug = resolveProjectTemplate("bug_tracker");
		expect(bug?.statusOptions).toEqual(["No status", "Needs triage", "In progress", "Done"]);
		expect(bug?.fields?.map(f => ({ name: f.name, dataType: f.dataType }))).toEqual([
			{ name: "Priority", dataType: "SINGLE_SELECT" },
			{ name: "Severity", dataType: "SINGLE_SELECT" },
		]);
	});

	it("resolves roadmap to a DATE Target date field with no single_selects", () => {
		const roadmap = resolveProjectTemplate("roadmap");
		expect(roadmap?.fields).toEqual([{ name: "Target date", dataType: "DATE" }]);
		expect(roadmap?.fields?.some(f => f.dataType === "SINGLE_SELECT")).toBe(false);
	});

	it("resolves iterative_development to a NUMBER Story points field", () => {
		expect(resolveProjectTemplate("iterative_development")?.fields).toEqual([
			{ name: "Story points", dataType: "NUMBER" },
		]);
	});

	it("keeps product_launch and roadmap distinct (different date field names + status sets)", () => {
		const launch = resolveProjectTemplate("product_launch");
		const roadmap = resolveProjectTemplate("roadmap");
		expect(launch?.fields?.[0]?.name).toBe("Launch date");
		expect(roadmap?.fields?.[0]?.name).toBe("Target date");
		expect(launch?.statusOptions).not.toEqual(roadmap?.statusOptions);
	});

	it("treats omitted, empty, and 'blank' as a blank project", () => {
		expect(resolveProjectTemplate(undefined)).toBeUndefined();
		expect(resolveProjectTemplate("blank")).toBeUndefined();
		expect(resolveProjectTemplate("  ")).toBeUndefined();
	});

	it("matches template ids case-insensitively", () => {
		expect(resolveProjectTemplate("ROADMAP")?.label).toBe("Roadmap");
		expect(resolveProjectTemplate("Bug_Tracker")?.label).toBe("Bug tracker");
	});

	it("rejects an unknown template name, listing the valid ids", () => {
		expect(() => resolveProjectTemplate("scrum")).toThrow(/unknown project template/);
		for (const id of ["kanban", "team_planning", "bug_tracker", "roadmap"]) {
			expect(() => resolveProjectTemplate("scrum")).toThrow(new RegExp(id));
		}
	});
});

describe("GithubTool approval gating", () => {
	// `approval` is a read-only field that never inspects the session, so a stub suffices.
	// Pins the read-vs-exec contract per op (guards the run_watch regression).
	const tool = new GithubTool({} as unknown as ToolSession);

	it("approves read-only ops as read", () => {
		expect(tool.approval({ op: "run_watch" })).toBe("read");
		expect(tool.approval({ op: "project_view" })).toBe("read");
	});

	it("approves mutating ops as exec", () => {
		expect(tool.approval({ op: "project_item_edit" })).toBe("exec");
		expect(tool.approval({ op: "pr_create" })).toBe("exec");
	});
});

describe("normalizeGithubContentUrl", () => {
	it("strips trailing slash, query, and fragment", () => {
		expect(normalizeGithubContentUrl("https://x/y/z")).toBe("https://x/y/z");
		expect(normalizeGithubContentUrl("https://x/y/z/")).toBe("https://x/y/z");
		expect(normalizeGithubContentUrl("https://x/y/z?q=1")).toBe("https://x/y/z");
		expect(normalizeGithubContentUrl("https://x/y/z#frag")).toBe("https://x/y/z");
		expect(normalizeGithubContentUrl("https://x/y/z/?q=1#frag")).toBe("https://x/y/z");
	});

	it("canonicalizes issue/PR subpage URLs down to /issues/<n> or /pull/<n>", () => {
		expect(normalizeGithubContentUrl("https://github.com/o/r/pull/7/files")).toBe("https://github.com/o/r/pull/7");
		expect(normalizeGithubContentUrl("https://github.com/o/r/pull/7/commits")).toBe("https://github.com/o/r/pull/7");
		expect(normalizeGithubContentUrl("https://github.com/o/r/issues/42")).toBe("https://github.com/o/r/issues/42");
		expect(normalizeGithubContentUrl("https://github.com/o/r/issues/42/#comment")).toBe(
			"https://github.com/o/r/issues/42",
		);
		expect(normalizeGithubContentUrl("https://github.com/o/r/pull/7/files?q=1#diff")).toBe(
			"https://github.com/o/r/pull/7",
		);
	});

	it("leaves non-issue/PR URLs unchanged (still strips slash/query/fragment)", () => {
		expect(normalizeGithubContentUrl("https://example.com/a/b/c")).toBe("https://example.com/a/b/c");
	});
});

describe("findProjectItemByContentUrl", () => {
	const items = [
		{ id: "PVTI_1", content: { type: "Issue", url: "https://github.com/o/r/issues/42", number: 42 } },
		{ id: "PVTI_2", content: { type: "PullRequest", url: "https://github.com/o/r/pull/7" } },
	];
	it("matches ignoring trailing slash, query, and fragment", () => {
		expect(findProjectItemByContentUrl(items, "https://github.com/o/r/issues/42")?.id).toBe("PVTI_1");
		expect(findProjectItemByContentUrl(items, "https://github.com/o/r/issues/42/")?.id).toBe("PVTI_1");
		expect(findProjectItemByContentUrl(items, "https://github.com/o/r/issues/42?foo=bar")?.id).toBe("PVTI_1");
		expect(findProjectItemByContentUrl(items, "https://github.com/o/r/issues/42#frag")?.id).toBe("PVTI_1");
	});
	it("returns undefined for no match", () => {
		expect(findProjectItemByContentUrl(items, "https://github.com/o/r/issues/999")).toBeUndefined();
	});
});

describe("getProjectItemFieldValue", () => {
	it("matches the board field name case- and whitespace-insensitively", () => {
		const item = { id: "PVTI_1", status: "Done", Priority: "P0" };
		expect(getProjectItemFieldValue(item, "Status")).toBe("Done");
		expect(getProjectItemFieldValue(item, "status")).toBe("Done");
		expect(getProjectItemFieldValue(item, "Priority")).toBe("P0");
		expect(getProjectItemFieldValue(item, "priority")).toBe("P0");
		expect(getProjectItemFieldValue(item, "Missing")).toBeUndefined();
	});
});

describe("resolveProjectBoardField", () => {
	it("resolves a single-select field case-insensitively and returns its options", () => {
		const fields = [
			{ id: "F1", name: "Status", type: "ProjectV2Field" },
			{ id: "F2", name: "Priority", type: "ProjectV2SingleSelectField", options: [{ id: "o1", name: "P0" }] },
		];
		const { field, options } = resolveProjectBoardField(fields, "priority");
		expect(field.id).toBe("F2");
		expect(options.map(o => o.name)).toEqual(["P0"]);
	});
	it("throws listing single-select names when the field is missing or not single-select", () => {
		const fields = [
			{ id: "F1", name: "Status", type: "ProjectV2Field" },
			{ id: "F2", name: "Priority", type: "ProjectV2SingleSelectField", options: [{ id: "o1", name: "P0" }] },
		];
		// Status exists but is not a single-select -> lists the available single-selects.
		expect(() => resolveProjectBoardField(fields, "Status")).toThrow(/Priority/);
		// No field with that name -> lists the available single-selects.
		expect(() => resolveProjectBoardField(fields, "Nonexistent")).toThrow(/Priority/);
	});
});

describe("formatProjectBoard", () => {
	const project = { title: "Demo", number: 4, url: "https://github.com/orgs/o/projects/4" };
	const options = [{ name: "Todo" }, { name: "Done" }];

	it("renders a synthetic No status bucket for empty-value items when no real option matches", () => {
		const items = [
			{ id: "PVTI_a", title: "first", status: "Done" },
			{ id: "PVTI_b", title: "second" },
			{ id: "PVTI_c", title: "third", status: "Todo" },
		];
		const out = formatProjectBoard(project, "Status", options, items, Number.POSITIVE_INFINITY);
		expect(out.split("\n").filter(line => line.startsWith("## "))).toEqual([
			"## Todo (1)",
			"## Done (1)",
			"## No status (1)",
		]);
		expect(out.match(/## No status/g)).toHaveLength(1);
	});

	it("merges empty-value items into a real 'No status' option — exactly one group, no duplicate header", () => {
		// Defends the render-path fix: a board whose Status field has a real "No status"
		// option (e.g. kourierai #2) must render ONE "No status" column holding both the
		// explicitly-"No status" items and the empty-value items — never two headers.
		const withRealNoStatus = [{ name: "Todo" }, { name: "No status" }, { name: "Done" }];
		const items = [
			{ id: "PVTI_a", title: "explicit-ns", status: "No status" },
			{ id: "PVTI_b", title: "empty-value" },
			{ id: "PVTI_c", title: "done", status: "Done" },
		];
		const out = formatProjectBoard(project, "Status", withRealNoStatus, items, Number.POSITIVE_INFINITY);
		expect(out.match(/## No status/g)).toHaveLength(1);
		expect(out.split("\n").filter(line => line.startsWith("## "))).toEqual([
			"## Todo (0)",
			"## No status (2)",
			"## Done (1)",
		]);
	});

	it("caps each column to itemsPerColumn and reports X of Y when totalCount exceeds shown", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({
			id: `PVTI_${index}`,
			title: `t${index}`,
			status: "Todo",
		}));
		const out = formatProjectBoard(project, "Status", options, items, 8, 50);
		expect(out).toContain("Items: 12 of 50");
		expect(out).toContain("... and 4 more");
	});
});

describe("GithubTool project op approval matrix", () => {
	const tool = new GithubTool({} as unknown as ToolSession);
	const mutatingProjectOps = [
		"project_item_add",
		"project_item_create",
		"project_item_edit",
		"project_item_delete",
		"project_create",
	];

	it("approves project_view as read", () => {
		expect(tool.approval({ op: "project_view" })).toBe("read");
	});

	it("approves every mutating project op as exec", () => {
		for (const op of mutatingProjectOps) {
			expect(tool.approval({ op })).toBe("exec");
		}
	});
});
