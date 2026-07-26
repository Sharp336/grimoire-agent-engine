import { beforeAll, describe, expect, it } from "bun:test";
import {
	buildSessionMapRows,
	renderSessionMapText,
	SessionMapComponent,
	sessionLineageKind,
} from "@oh-my-pi/pi-coding-agent/modes/components/session-map";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function makeSession(overrides: Partial<SessionInfo> & Pick<SessionInfo, "path" | "id">): SessionInfo {
	return {
		cwd: "/work",
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: "(no messages)",
		allMessagesText: "",
		title: overrides.id,
		...overrides,
	};
}

describe("buildSessionMapRows", () => {
	it("places children under their parent at depth 1", () => {
		const A = makeSession({
			path: "/sessions/A.jsonl",
			id: "A",
			title: "Session A",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const B = makeSession({
			path: "/sessions/B.jsonl",
			id: "B",
			title: "Session B",
			parentSessionPath: A.path,
			modified: new Date("2024-01-02T12:00:00Z"),
		});
		const C = makeSession({
			path: "/sessions/C.jsonl",
			id: "C",
			title: "Session C",
			parentSessionPath: A.path,
			modified: new Date("2024-01-02T00:00:00Z"),
		});

		const rows = buildSessionMapRows([A, B, C], () => []);
		expect(rows.map(r => ({ id: r.session.id, depth: r.depth }))).toEqual([
			{ id: "A", depth: 0 },
			{ id: "B", depth: 1 },
			{ id: "C", depth: 1 },
		]);
	});

	it("treats a session whose parent is absent as a root and keeps its subtree", () => {
		const orphanParentPath = "/sessions/missing-parent.jsonl";
		const child = makeSession({
			path: "/sessions/child.jsonl",
			id: "child",
			title: "Orphan Root",
			parentSessionPath: orphanParentPath,
		});
		const grand = makeSession({
			path: "/sessions/grand.jsonl",
			id: "grand",
			title: "Grandchild",
			parentSessionPath: child.path,
			modified: new Date("2024-01-01T12:00:00Z"),
		});

		const rows = buildSessionMapRows([child, grand], () => []);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.session.id).toBe("child");
		expect(rows[0]!.depth).toBe(0);
		expect(rows[1]!.session.id).toBe("grand");
		expect(rows[1]!.depth).toBe(1);
	});

	it("terminates parentSessionPath cycles by re-rooting instead of looping forever", () => {
		const A = makeSession({
			path: "/sessions/A.jsonl",
			id: "A",
			title: "Cycle A",
			parentSessionPath: "/sessions/B.jsonl",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const B = makeSession({
			path: "/sessions/B.jsonl",
			id: "B",
			title: "Cycle B",
			parentSessionPath: "/sessions/A.jsonl",
			modified: new Date("2024-01-02T00:00:00Z"),
		});

		const rows = buildSessionMapRows([A, B], () => []);

		expect(rows).toHaveLength(2);
		expect(rows.every(r => r.session.id === "A" || r.session.id === "B")).toBe(true);
		// One node is promoted to a depth-0 root; the other hangs under it.
		const depths = rows.map(r => r.depth).sort();
		expect(depths).toEqual([0, 1]);
		expect(rows.filter(r => r.depth === 0)).toHaveLength(1);
		expect(rows.filter(r => r.depth === 1)).toHaveLength(1);
	});

	it("attaches tags from tagsFor only to the matching session", () => {
		const tagged = makeSession({
			path: "/sessions/tagged.jsonl",
			id: "tagged",
			title: "Tagged",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const plain = makeSession({
			path: "/sessions/plain.jsonl",
			id: "plain",
			title: "Plain",
			modified: new Date("2024-01-02T00:00:00Z"),
		});

		const rows = buildSessionMapRows([tagged, plain], sessionId => (sessionId === "tagged" ? ["hot", "wip"] : []));

		const taggedRow = rows.find(r => r.session.id === "tagged");
		const plainRow = rows.find(r => r.session.id === "plain");
		expect(taggedRow?.tags).toEqual(["hot", "wip"]);
		expect(plainRow?.tags).toEqual([]);
	});
});

describe("sessionLineageKind", () => {
	it("classifies a file-path parent as handoff and a bare session-id parent as fork", () => {
		expect(sessionLineageKind("/sessions/parent.jsonl")).toBe("handoff");
		expect(sessionLineageKind("C:\\sessions\\parent.jsonl")).toBe("handoff");
		expect(sessionLineageKind("parent-session-id")).toBe("fork");
	});
});

describe("renderSessionMapText", () => {
	it("returns the empty-state string for an empty session list", () => {
		expect(renderSessionMapText([])).toBe("No sessions.");
	});
});


describe("SessionMapComponent", () => {
	it("renders lineage metadata, switches scope, and selects the navigated row", async () => {
		const parent = makeSession({ path: "/sessions/parent.jsonl", id: "parent", title: "Parent" });
		const child = makeSession({
			path: "/sessions/child.jsonl",
			id: "child",
			title: "Child",
			parentSessionPath: parent.path,
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const remote = makeSession({ path: "/sessions/remote.jsonl", id: "remote", title: "Remote", cwd: "/other" });
		const selected: string[] = [];
		const map = new SessionMapComponent(
			[parent, child],
			session => selected.push(session.id),
			() => {},
			() => {},
			{ loadAllSessions: async () => [parent, child, remote], tagsFor: id => (id === "child" ? ["hot"] : []) },
		);

		expect(map.render(100).join("\n")).toContain("#hot");
		expect(map.render(100).join("\n")).toContain("handoff");
		map.handleInput("\x1b[B");
		map.handleInput("\n");
		expect(selected).toEqual(["child"]);

		map.handleInput("\t");
		await Bun.sleep(0);
		const rendered = map.render(100).join("\n");
		expect(rendered).toContain("(all projects)");
		expect(rendered).toContain("/other");
	});
});
