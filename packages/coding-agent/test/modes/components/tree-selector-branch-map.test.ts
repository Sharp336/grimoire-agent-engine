import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let nextId = 0;

function userNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${nextId++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: nextId };
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function branchyTree(): { tree: SessionTreeNode[]; currentLeafId: string } {
	const root = userNode("start");
	const left = userNode("left branch", root.entry.id);
	const right = userNode("right branch", root.entry.id);
	root.children.push(left, right);
	return { tree: [root], currentLeafId: right.entry.id };
}

function treeWithHiddenInternalNode(): { tree: SessionTreeNode[]; currentLeafId: string } {
	const root = userNode("before internal event");
	const internalEntry: SessionEntry = {
		type: "custom",
		id: `entry-${nextId++}`,
		parentId: root.entry.id,
		timestamp: new Date().toISOString(),
		customType: "internal-marker",
	};
	const internal: SessionTreeNode = { entry: internalEntry, children: [] };
	const child = userNode("after internal event", internal.entry.id);
	root.children.push(internal);
	internal.children.push(child);
	return { tree: [root], currentLeafId: child.entry.id };
}

function render(selector: TreeSelectorComponent, width: number): string {
	return Bun.stripANSI(selector.render(width).join("\n"));
}

describe("TreeSelectorComponent branch map", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("draws a top-down tree beside the list with compact numbered role labels", () => {
		const { tree, currentLeafId } = branchyTree();
		const output = render(
			new TreeSelectorComponent(
				tree,
				currentLeafId,
				60,
				() => {},
				() => {},
			),
			120,
		);

		expect(output).toContain("Session Tree");
		expect(output).toContain("Branch Map");
		expect(output).toContain("Filter");
		expect(output).toContain("[Default]");
		expect(output).toContain("labels and internal events hidden");
		expect(output).toContain("Navigate");
		expect(output).toContain("Shift+←/→ sibling branch (wraps)");
		expect(output).toContain("Enter confirm");
		const graphRows = output
			.split("\n")
			.map(line => line.split(" │ ")[1])
			.filter((line): line is string => line !== undefined);
		const rootRow = graphRows.findIndex(line => line.includes("#1 user"));
		const forkRow = graphRows.findIndex(line => line.includes("┌"));
		const selectedRow = graphRows.findIndex(line => line.includes("›#3 user"));
		expect(rootRow).toBeGreaterThanOrEqual(0);
		expect(forkRow).toBeGreaterThan(rootRow);
		expect(selectedRow).toBeGreaterThan(forkRow);
		expect(graphRows.join("\n")).not.toContain("left branch");
	});

	it("falls back to the list on narrow terminals but shows message summaries in the standalone tree", () => {
		const { tree, currentLeafId } = branchyTree();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);

		expect(render(selector, 80)).toContain("Session Tree");
		expect(render(selector, 80)).not.toContain("Branch Map");

		selector.handleInput("\x07"); // ctrl+g: split -> map
		const mapOnly = render(selector, 80);
		expect(mapOnly).toContain("Branch Map");
		expect(mapOnly).not.toContain("Session Tree");
		expect(mapOnly).toContain("left branch");
		expect(mapOnly).toContain("›#3 user");
	});

	it("moves the tree highlight with the list selection", () => {
		const { tree, currentLeafId } = branchyTree();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);
		selector.handleInput("\x07"); // ctrl+g: split -> map
		expect(render(selector, 80)).toContain("›#3 user");

		selector.handleInput("\x1b[A"); // up: current leaf -> root
		const moved = render(selector, 80);
		expect(moved).toContain("›#1 user");
		expect(moved).not.toContain("›#3 user");
	});

	it("cycles sibling branches with Shift+Left before confirming with Enter", () => {
		const { tree, currentLeafId } = branchyTree();
		const selectedEntries: string[] = [];
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			entryId => selectedEntries.push(entryId),
			() => {},
		);
		selector.handleInput("\x07"); // ctrl+g: split -> map

		selector.handleInput("\x1b[1;2D"); // shift+left: right branch -> left branch
		const leftSelected = render(selector, 80);
		expect(leftSelected).toContain("›#2 user");
		expect(leftSelected).not.toContain("›#3 user");
		expect(selectedEntries).toEqual([]);

		selector.handleInput("\x1b[1;2D"); // shift+left wraps left branch -> right branch
		expect(render(selector, 80)).toContain("›#3 user");
		expect(selectedEntries).toEqual([]);

		selector.handleInput("\n");
		expect(selectedEntries).toEqual([currentLeafId]);
	});

	it("projects the same filtered nodes into the branch map and updates the filter status", () => {
		const { tree, currentLeafId } = treeWithHiddenInternalNode();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);
		selector.handleInput("\x07"); // ctrl+g: split -> map

		const defaultMap = render(selector, 80);
		expect(defaultMap).toContain("#1 user: before internal");
		expect(defaultMap).toContain("#2 user: after internal");
		expect(defaultMap).not.toContain("custom");

		for (let index = 0; index < 4; index++) selector.handleInput("\x0f"); // ctrl+o: default -> all
		const allMap = render(selector, 80);
		expect(allMap).toContain("[All]");
		expect(allMap).toContain("all persisted entries");
		expect(allMap).toContain("#2 custom");
	});
});
