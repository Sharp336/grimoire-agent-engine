import { describe, expect, test } from "bun:test";
import { SubagentBrowserComponent } from "../../src/modes/components/subagent-browser";
import { SelectorController } from "../../src/modes/controllers/selector-controller";
import { type ObserverTreeNode, SessionObserverRegistry } from "../../src/modes/session-observer-registry";
import type { InteractiveModeContext } from "../../src/modes/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../src/task";
import { EventBus } from "../../src/utils/event-bus";

describe("SessionObserverTree", () => {
	test("Hierarchy - handles nested subagents and correct children ordering", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		// Emit A (parentId "Main")
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "A",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Main",
		});

		// Emit B (parentId "A")
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "B",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 2,
			parentId: "A",
		});

		// Emit C (parentId "Main")
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "C",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 3,
			parentId: "Main",
		});

		const tree = registry.getTree();
		expect(tree.length).toBe(1);
		expect(tree[0].session.id).toBe("main");

		const rootChildren = tree[0].children;
		expect(rootChildren.map(c => c.session.id)).toEqual(["A", "C"]);

		const aNode = rootChildren.find(c => c.session.id === "A");
		expect(aNode).toBeDefined();
		expect(aNode!.children.map(c => c.session.id)).toEqual(["B"]);
	});

	test("Main-id normalization - attaches child with parentId 'Main' under 'main' root", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "A",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Main",
		});

		const tree = registry.getTree();
		expect(tree.length).toBe(1);
		expect(tree[0].session.id).toBe("main");
		expect(tree[0].children.map(c => c.session.id)).toEqual(["A"]);
	});

	test("Orphan fallback - attaches orphan child under the main root", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Orphan",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Ghost",
		});

		const tree = registry.getTree();
		expect(tree.length).toBe(1);
		expect(tree[0].session.id).toBe("main");
		expect(tree[0].children.map(c => c.session.id)).toEqual(["Orphan"]);
	});

	test("Cycle safety - resolves cycles without throwing/hanging and includes both sessions", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "X",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Y",
		});

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Y",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 2,
			parentId: "X",
		});

		// Ensure getTree() executes successfully and includes both X and Y.
		const tree = registry.getTree();
		expect(tree.length).toBe(1);
		expect(tree[0].session.id).toBe("main");

		// Find X and Y anywhere in the tree structure.
		const allIds: string[] = [];
		const traverse = (node: ObserverTreeNode) => {
			allIds.push(node.session.id);
			for (const child of node.children) {
				traverse(child);
			}
		};
		traverse(tree[0]);

		expect(allIds).toContain("X");
		expect(allIds).toContain("Y");
	});

	test("Order stability — progress updates do not reorder sessions", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		// Emit A, B, C under parentId "Main"
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "A",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Main",
		});

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "B",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 2,
			parentId: "Main",
		});

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "C",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 3,
			parentId: "Main",
		});

		// Capture the order: getSessions().map(s => s.id) -> expect ["main", "A", "B", "C"]
		expect(registry.getSessions().map(s => s.id)).toEqual(["main", "A", "B", "C"]);

		// Now emit a PROGRESS event for A
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 1,
			agent: "task",
			agentSource: "bundled",
			task: "test",
			parentId: "Main",
			progress: {
				index: 1,
				id: "A",
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "test",
				toolCount: 0,
				tokens: 1,
				cost: 0,
				durationMs: 0,
				recentTools: [],
				recentOutput: [],
			},
		});

		// Assert A did not move
		expect(registry.getSessions().map(s => s.id)).toEqual(["main", "A", "B", "C"]);

		// Assert the top-level getTree() children order is unchanged
		const tree = registry.getTree();
		expect(tree.length).toBe(1);
		expect(tree[0].session.id).toBe("main");
		expect(tree[0].children.map(c => c.session.id)).toEqual(["A", "B", "C"]);
	});

	test("Browser defaults Enter to the first subagent but still selects the main root", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "A",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Main",
		});

		const selectedIds: string[] = [];
		const browser = new SubagentBrowserComponent(registry, {
			onSelect: session => {
				selectedIds.push(session.id);
			},
			onDone: () => {},
			requestRender: () => {},
		});

		browser.handleInput("\n");
		expect(selectedIds.at(-1)).toBe("A");

		browser.handleInput("k");
		browser.handleInput("\n");
		expect(selectedIds.at(-1)).toBe("main");
	});

	test("Selecting the main root closes /observe instead of opening a transcript observer", () => {
		const registry = new SessionObserverRegistry();
		const bus = new EventBus();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/main.jsonl");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "A",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
			parentId: "Main",
		});

		let browser: SubagentBrowserComponent | undefined;
		let hideCount = 0;
		let renderCount = 0;
		let showOverlayCount = 0;
		const ctx = {
			ui: {
				showOverlay: (component: SubagentBrowserComponent) => {
					showOverlayCount++;
					browser = component;
					return {
						hide: () => {
							hideCount++;
						},
					};
				},
				setFocus: () => {},
				requestRender: () => {
					renderCount++;
				},
			},
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showSubagentBrowser(registry);
		expect(browser).toBeDefined();
		browser!.handleInput("k");
		browser!.handleInput("\n");

		expect(hideCount).toBe(1);
		expect(renderCount).toBeGreaterThan(0);
		expect(showOverlayCount).toBe(1);
	});
});
