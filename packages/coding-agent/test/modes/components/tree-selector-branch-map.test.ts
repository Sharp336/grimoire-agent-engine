import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Component } from "@oh-my-pi/pi-tui";

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

function wideRootTree(): { tree: SessionTreeNode[]; currentLeafId: string } {
	const first = userNode("first root");
	const second = userNode("second root");
	const third = userNode("third root");
	return { tree: [first, second, third], currentLeafId: first.entry.id };
}

function treeWithOffBranchSearchMatches(): { tree: SessionTreeNode[]; currentLeafId: string } {
	const root = userNode("root");
	const activeParent = userNode("active parent", root.entry.id);
	const activeLeaf = userNode("active leaf", activeParent.entry.id);
	const otherParent = userNode("other parent", root.entry.id);
	const firstMatch = userNode("needle first", otherParent.entry.id);
	const secondMatch = userNode("needle second", otherParent.entry.id);
	root.children.push(activeParent, otherParent);
	activeParent.children.push(activeLeaf);
	otherParent.children.push(firstMatch, secondMatch);
	return { tree: [root], currentLeafId: activeLeaf.entry.id };
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

function treeWithHiddenMiddleSibling(): { tree: SessionTreeNode[]; currentLeafId: string; thirdChildId: string } {
	const root = userNode("root");
	const firstChild = userNode("first visible branch", root.entry.id);
	const hiddenEntry: SessionEntry = {
		type: "custom",
		id: `entry-${nextId++}`,
		parentId: root.entry.id,
		timestamp: new Date().toISOString(),
		customType: "internal-marker",
	};
	const hiddenChild: SessionTreeNode = { entry: hiddenEntry, children: [] };
	const thirdChild = userNode("third visible branch", root.entry.id);
	root.children.push(firstChild, hiddenChild, thirdChild);
	return { tree: [root], currentLeafId: firstChild.entry.id, thirdChildId: thirdChild.entry.id };
}

function treeWithPromotedHiddenBranches(hiddenType: "custom" | "label"): {
	tree: SessionTreeNode[];
	currentLeafId: string;
	rootId: string;
	firstChildId: string;
	secondChildId: string;
} {
	const root = userNode("root");
	const hiddenEntry: SessionEntry =
		hiddenType === "custom"
			? {
					type: "custom",
					id: `entry-${nextId++}`,
					parentId: root.entry.id,
					timestamp: new Date().toISOString(),
					customType: "internal-marker",
				}
			: {
					type: "label",
					id: `entry-${nextId++}`,
					parentId: root.entry.id,
					timestamp: new Date().toISOString(),
					targetId: root.entry.id,
					label: "bookmark",
				};
	const hiddenNode: SessionTreeNode = { entry: hiddenEntry, children: [] };
	const firstChild = userNode("first visible branch", hiddenNode.entry.id);
	const secondChild = userNode("second visible branch", hiddenNode.entry.id);
	root.children.push(hiddenNode);
	hiddenNode.children.push(firstChild, secondChild);
	return {
		tree: [root],
		currentLeafId: firstChild.entry.id,
		rootId: root.entry.id,
		firstChildId: firstChild.entry.id,
		secondChildId: secondChild.entry.id,
	};
}

function linearUserTree(
	count: number,
	textAt: (index: number) => string = index => `node ${index}`,
): {
	tree: SessionTreeNode[];
	currentLeafId: string;
} {
	const root = userNode(textAt(0));
	let current = root;
	for (let index = 1; index < count; index++) {
		const child = userNode(textAt(index), current.entry.id);
		current.children.push(child);
		current = child;
	}
	return { tree: [root], currentLeafId: current.entry.id };
}

function deepProjectedTree(): { tree: SessionTreeNode[]; currentLeafId: string } {
	const root = userNode("visible root");
	let current = root;
	for (let index = 1; index <= 20_000; index++) {
		let child: SessionTreeNode;
		if (index % 5 === 0) {
			child = userNode(`visible ${index}`, current.entry.id);
		} else {
			const entry: SessionEntry = {
				type: "custom",
				id: `entry-${nextId++}`,
				parentId: current.entry.id,
				timestamp: new Date().toISOString(),
				customType: "hidden-marker",
			};
			child = { entry, children: [] };
		}
		current.children.push(child);
		current = child;
	}
	return { tree: [root], currentLeafId: current.entry.id };
}

function render(selector: TreeSelectorComponent, width: number): string {
	return Bun.stripANSI(selector.render(width).join("\n"));
}

function renderStyled(selector: TreeSelectorComponent, width: number): string {
	return selector.render(width).join("\n");
}

function hasOnlyCompleteCsiSequences(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\x1b" || text[index + 1] !== "[") continue;
		index += 2;
		while (index < text.length) {
			const code = text.charCodeAt(index);
			if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
				index++;
				continue;
			}
			if (code < 0x40 || code > 0x7e) return false;
			break;
		}
		if (index === text.length) return false;
	}
	return true;
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

	it("preserves Container extension child rendering and lifecycle propagation", () => {
		const { tree, currentLeafId } = branchyTree();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);
		let invalidated = false;
		let disposed = false;
		let ignoresTight = false;
		const extension: Component = {
			render: () => ["extension child"],
			invalidate: () => {
				invalidated = true;
			},
			setIgnoreTight: ignore => {
				ignoresTight = ignore;
			},
			dispose: () => {
				disposed = true;
			},
		};

		selector.addChild(extension);
		expect(selector.children).toContain(extension);
		expect(render(selector, 120)).toContain("extension child");
		selector.setIgnoreTight(true);
		selector.invalidate();
		expect(ignoresTight).toBe(true);
		expect(invalidated).toBe(true);
		selector.disposeChildren();
		expect(disposed).toBe(true);
		expect(selector.children).toEqual([]);
	});

	it("uses the accent color for shortcut keys and muted text for their descriptions", () => {
		const { tree, currentLeafId } = branchyTree();
		const output = renderStyled(
			new TreeSelectorComponent(
				tree,
				currentLeafId,
				60,
				() => {},
				() => {},
			),
			120,
		);

		expect(output).toContain(themeModule.theme.fg("accent", "Shift+←/→"));
		expect(output).toContain(themeModule.theme.fg("muted", " sibling branch (wraps)   "));

		const compactOutput = renderStyled(
			new TreeSelectorComponent(
				tree,
				currentLeafId,
				20,
				() => {},
				() => {},
			),
			120,
		);
		expect(compactOutput).toContain(themeModule.theme.fg("accent", "Ctrl+G"));
		expect(compactOutput).toContain(themeModule.theme.fg("muted", " view   "));
	});

	it("falls back to the list on narrow terminals but shows message summaries in the standalone tree", () => {
		const { tree, currentLeafId } = branchyTree();
		const terminalColumns = 80;
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
			undefined,
			"default",
			() => 60,
			() => terminalColumns,
		);

		expect(render(selector, 80)).toContain("Session Tree");
		expect(render(selector, 80)).not.toContain("Branch Map");

		selector.handleInput("\x07"); // ctrl+g: split -> map
		const mapOnly = render(selector, 80);
		expect(mapOnly).toContain("Branch Map");
		expect(mapOnly).not.toContain("Session Tree");
		expect(mapOnly).toContain("left branch");
		expect(mapOnly).toContain("›#3 user");

		selector.handleInput("\x07"); // ctrl+g: map -> list
		expect(render(selector, terminalColumns)).toContain("Session Tree");
		expect(render(selector, terminalColumns)).not.toContain("Branch Map");

		selector.handleInput("\x07"); // ctrl+g: list -> map
		expect(render(selector, terminalColumns)).toContain("Branch Map");
	});

	it("keeps a selected branch root visible in narrow standalone maps", () => {
		const { tree, currentLeafId } = branchyTree();
		for (const width of [21, 34]) {
			const selector = new TreeSelectorComponent(
				tree,
				currentLeafId,
				60,
				() => {},
				() => {},
			);
			selector.handleInput("\x1b[A"); // leaf -> branch root
			selector.handleInput("\x07"); // ctrl+g: split -> map

			const output = render(selector, width);
			expect(output).toContain("›#1 user");
			for (const line of output.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps selected map nodes visible when a short viewport needs scroll indicators", () => {
		const { tree, currentLeafId } = linearUserTree(3);
		const leafSelector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			10,
			() => {},
			() => {},
		);
		leafSelector.handleInput("\x07"); // ctrl+g: split -> map
		expect(render(leafSelector, 120)).toContain("›#3 user");

		const middleSelector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			11,
			() => {},
			() => {},
		);
		middleSelector.handleInput("\x1b[A"); // up: leaf -> middle node
		middleSelector.handleInput("\x07"); // ctrl+g: split -> map
		const output = render(middleSelector, 120);
		expect(output).toContain("›#2 user");
		expect(output).toContain("↑↓");
	});

	it("crops a styled label at the horizontal map edge without emitting an incomplete ANSI sequence", () => {
		const { tree, currentLeafId } = wideRootTree();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);
		selector.handleInput("\x07"); // ctrl+g: split -> map

		const output = renderStyled(selector, 66);
		expect(Bun.stripANSI(output)).toContain("…");
		expect(hasOnlyCompleteCsiSequences(output)).toBe(true);
	});

	it("does not mark an off-branch search result as the current session", () => {
		const { tree, currentLeafId } = treeWithOffBranchSearchMatches();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);
		for (const character of "needle") selector.handleInput(character);
		selector.handleInput("\x07"); // ctrl+g: split -> map
		expect(render(selector, 80)).toContain("›#2 user: needle second");

		selector.handleInput("\x1b[A");
		const moved = render(selector, 80);
		expect(moved).toContain("›#1 user: needle first");
		expect(moved).not.toContain("•#");
	});

	it("keeps an active search query visible and editable in the standalone map", () => {
		const { tree, currentLeafId } = treeWithOffBranchSearchMatches();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);

		selector.handleInput("\x07"); // ctrl+g: split -> map
		for (const character of "needle") selector.handleInput(character);
		expect(render(selector, 80)).toContain("Search: needle");

		selector.handleInput("\x7f"); // backspace
		expect(render(selector, 80)).toContain("Search: needl");
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

	it("skips a fully hidden sibling branch with Shift+Right in the default filter", () => {
		const { tree, currentLeafId, thirdChildId } = treeWithHiddenMiddleSibling();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);

		selector.handleInput("\x1b[1;2C"); // shift+right: first visible branch -> third visible branch

		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(thirdChildId);
	});

	for (const hiddenType of ["custom", "label"] as const) {
		it(`follows branches promoted through a hidden ${hiddenType} node`, () => {
			const { tree, currentLeafId, rootId, firstChildId, secondChildId } =
				treeWithPromotedHiddenBranches(hiddenType);
			const selector = new TreeSelectorComponent(
				tree,
				currentLeafId,
				60,
				() => {},
				() => {},
			);
			selector.handleInput("\x07"); // ctrl+g: split -> map
			selector.handleInput("\x1b[A"); // up: first visible branch -> root
			expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(rootId);

			selector.handleInput("\x1b[1;2C"); // shift+right: root -> first promoted branch
			expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(firstChildId);

			selector.handleInput("\x1b[A"); // up: first visible branch -> root
			selector.handleInput("\x1b[1;2D"); // shift+left: root -> last promoted branch
			expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(secondChildId);
		});
	}

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

	it("renders a 20,001-entry chain iteratively when filtering leaves a map-sized projection", () => {
		const { tree, currentLeafId } = deepProjectedTree();
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);

		const splitView = render(selector, 120);
		expect(splitView).toContain("Branch Map");
		expect(splitView).toContain("›#4001 user");

		selector.handleInput("\x07"); // ctrl+g: split -> map
		const mapOnly = render(selector, 80);
		expect(mapOnly).toContain("›#4001 user");
	});

	it("falls back to the full-width list above the map node limit and restores the map after search", () => {
		const { tree, currentLeafId } = linearUserTree(5_001, index => (index === 0 ? "needle" : `node ${index}`));
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			60,
			() => {},
			() => {},
		);

		const limited = render(selector, 120);
		expect(limited).toContain("Branch Map unavailable for 5,001 visible entries");
		expect(limited).not.toContain("#1 user");
		selector.handleInput("\x07"); // ctrl+g: split -> map
		expect(render(selector, 120)).toContain("Branch Map unavailable for 5,001 visible entries");

		for (const key of "needle") selector.handleInput(key);
		const restored = render(selector, 120);
		expect(restored).not.toContain("Branch Map unavailable");
		expect(restored).toContain("Branch Map");
		expect(restored).toContain("#1 user");
	});

	it("keeps every view within the live terminal height while it shrinks", () => {
		const { tree, currentLeafId } = linearUserTree(10);
		let terminalRows = 30;
		const selector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			terminalRows,
			() => {},
			() => {},
			undefined,
			"default",
			() => terminalRows,
		);

		expect(selector.render(120)).toHaveLength(30);
		terminalRows = 20;
		for (let index = 0; index < 3; index++) {
			const output = render(selector, 120);
			expect(selector.render(120).length).toBeLessThanOrEqual(20);
			expect(output).toContain(index === 1 ? "Branch Map" : "Session Tree");
			expect(output).toContain("Filter:");
			selector.handleInput("\x07"); // ctrl+g: split -> map -> list -> split
		}
	});
});
