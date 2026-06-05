import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "../../../src/modes/components/tree-selector";
import * as themeModule from "../../../src/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "../../../src/session/session-manager";

// Ctrl+B is delivered as the legacy control byte; protocol-independent (no kitty state needed).
const CTRL_B = "\x02";
const ARROW_UP = "\x1b[A";

let counter = 0;
function makeMessageNode(message: AgentMessage, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function buildSelector(onBranch: (entryId: string) => void): {
	selector: TreeSelectorComponent;
	rootId: string;
	leafId: string;
} {
	const root = makeMessageNode({ role: "user", content: "first", timestamp: 1 });
	const child = makeMessageNode({ role: "user", content: "reply", timestamp: 2 }, root.entry.id);
	root.children.push(child);
	const selector = new TreeSelectorComponent(
		[root],
		child.entry.id,
		60,
		() => {},
		() => {},
		undefined,
		"default",
		onBranch,
	);
	return { selector, rootId: root.entry.id, leafId: child.entry.id };
}

describe("TreeSelectorComponent Ctrl+B branch shortcut", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("invokes onBranch with the highlighted entry, not the active leaf", () => {
		const branched: string[] = [];
		const { selector, rootId, leafId } = buildSelector(entryId => branched.push(entryId));
		// Selection starts on the leaf; move up to the root entry, then branch from it.
		selector.handleInput(ARROW_UP);
		selector.handleInput(CTRL_B);
		expect(branched).toEqual([rootId]);
		expect(branched).not.toContain(leafId);
	});

	it("does not branch on a plain printable key (it stays search input)", () => {
		const branched: string[] = [];
		const { selector } = buildSelector(entryId => branched.push(entryId));
		selector.handleInput("B");
		expect(branched).toEqual([]);
	});
});
