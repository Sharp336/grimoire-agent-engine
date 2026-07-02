/**
 * Hub Enter contract: activating a non-remote agent row delegates to the
 * `focusAgent` dep (session focus proxy) and closes the hub on success; a
 * focus failure keeps the hub open and surfaces the error as a notice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { AgentHubOverlayComponent } from "../src/modes/components/agent-hub";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";

const AGENT_ID = "Worker";
const TEST_CWD = path.resolve("agent-hub-cwd");

function makeHub(focusAgent: (id: string) => Promise<void>) {
	const agents = new AgentRegistry();
	agents.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: "Main",
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
	let doneCalls = 0;
	const done = Promise.withResolvers<void>();
	const renderRequested = Promise.withResolvers<void>();
	const hub = new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {
			doneCalls++;
			done.resolve();
		},
		requestRender: () => renderRequested.resolve(),
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent,
	});
	return { hub, doneCalls: () => doneCalls, done: done.promise, renderRequested: renderRequested.promise };
}

describe("Agent hub Enter activation", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("Enter focuses the selected agent and closes the hub", async () => {
		const focusedIds: string[] = [];
		const { hub, doneCalls, done } = makeHub(async id => {
			focusedIds.push(id);
		});

		hub.handleInput("\r");
		await done; // activation is fire-and-forget async; onDone signals completion

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(doneCalls()).toBe(1);
		hub.dispose();
	});

	it("a focus failure keeps the hub open and shows the error as a notice", async () => {
		const message = 'Agent "X" is aborted and cannot be revived';
		const { hub, doneCalls, renderRequested } = makeHub(() => Promise.reject(new Error(message)));

		hub.handleInput("\r");
		await renderRequested; // the rejection path requests a render after setting the notice

		expect(doneCalls()).toBe(0);
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain(message);
		hub.dispose();
	});

	it("lists persisted subagent session files after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("parked");
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		hub.dispose();
	});

	it("selector controller restores focus to the editor after Enter focuses an agent", async () => {
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});

		const editor = {};
		let capturedHub: AgentHubOverlayComponent | undefined;
		let editorRestoredCount = 0;
		const focusedIds: string[] = [];
		const focusResolved = Promise.withResolvers<void>();
		const editorFocused = Promise.withResolvers<void>();
		const focusTargets: unknown[] = [];
		const editorContainer = {
			clear: () => {},
			addChild: (child: unknown) => {
				if (child === editor) editorRestoredCount++;
				else capturedHub = child as AgentHubOverlayComponent;
			},
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: (target: unknown) => {
					focusTargets.push(target);
					if (target === editor) editorFocused.resolve();
				},
				requestRender: () => {},
			},
			editor,
			editorContainer,
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async (id: string) => {
				focusedIds.push(id);
				focusResolved.resolve();
			},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());

		expect(capturedHub).toBeDefined();
		expect(focusTargets[0]).toBe(capturedHub);

		capturedHub!.handleInput("\r");
		await focusResolved.promise;
		await editorFocused.promise;

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(editorRestoredCount).toBe(1);
		expect(focusTargets.at(-1)).toBe(editor);
		capturedHub!.dispose();
	});
});

describe("Agent hub double-← gating", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function setup(agents: AgentRegistry) {
		let shown: AgentHubOverlayComponent | undefined;
		const editor = {};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				clear: () => {},
				addChild: (child: unknown) => {
					if (child !== editor) shown = child as AgentHubOverlayComponent;
				},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		return { controller, shown: () => shown };
	}

	function registerWorker(agents: AgentRegistry) {
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
	}

	it("requireContent keeps the hub closed when only Main is registered", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
			status: "running",
		});
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeUndefined();
	});

	it("requireContent opens the hub once a subagent exists", () => {
		const agents = new AgentRegistry();
		registerWorker(agents);
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeDefined();
		shown()!.dispose();
	});

	it("the explicit hub key opens the empty roster even with no subagents", () => {
		const agents = new AgentRegistry();
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry());

		expect(shown()).toBeDefined();
		shown()!.dispose();
	});
});

describe("Agent hub showAgentHub requireContent deferred gating", () => {
	beforeAll(() => {
		initTheme();
	});

	let capturedHubs: AgentHubOverlayComponent[] = [];
	let capturedPromises: Promise<void>[] = [];
	const originalIsEmpty = Object.getOwnPropertyDescriptor(AgentHubOverlayComponent.prototype, "isEmpty")!.get!;

	beforeEach(() => {
		capturedHubs = [];
		capturedPromises = [];

		Object.defineProperty(AgentHubOverlayComponent.prototype, "isEmpty", {
			configurable: true,
			get() {
				if (!capturedHubs.includes(this)) {
					capturedHubs.push(this);
					capturedPromises.push(this.persistedSubagentsReady);
				}
				return originalIsEmpty.call(this);
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(AgentHubOverlayComponent.prototype, "isEmpty", {
			configurable: true,
			get: originalIsEmpty,
		});
		resetSettingsForTest();
	});

	it("empty live registry + a session file containing a persisted subagent => the hub MOUNTS after persistedSubagentsReady settles", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-deferred-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await fs.promises.mkdir(path.join(tempDir.path(), "main"), { recursive: true });
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const agents = new AgentRegistry();

		let shown: AgentHubOverlayComponent | undefined;
		const editor = {};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor] as unknown[],
				clear() {
					this.children = [];
				},
				addChild(child: unknown) {
					this.children.push(child);
					if (child !== editor) shown = child as AgentHubOverlayComponent;
				},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		// Initially, it shouldn't be mounted
		expect(shown).toBeUndefined();

		// Wait for the hub's persistedSubagentsReady to resolve
		expect(capturedPromises.length).toBe(1);
		await capturedPromises[0];

		// Flush microtasks to let the hub mount
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		// Now it should be mounted!
		expect(shown).toBeDefined();
		expect(shown!.isEmpty).toBe(false);
		shown!.dispose();
	});

	it("empty live registry + no persisted subagents => the hub is disposed and never mounts", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-empty-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await fs.promises.mkdir(path.join(tempDir.path(), "main"), { recursive: true });
		await Bun.write(sessionFile, "");

		const agents = new AgentRegistry();

		let shown: AgentHubOverlayComponent | undefined;
		const editor = {};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor] as unknown[],
				clear() {
					this.children = [];
				},
				addChild(child: unknown) {
					this.children.push(child);
					if (child !== editor) shown = child as AgentHubOverlayComponent;
				},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		// Intercept onChange to track disposal
		let disposed = false;
		const originalOnChange = agents.onChange.bind(agents);
		agents.onChange = cb => {
			const unsub = originalOnChange(cb);
			return () => {
				disposed = true;
				unsub();
			};
		};

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown).toBeUndefined();

		// Wait for the hub's persistedSubagentsReady to resolve
		expect(capturedPromises.length).toBe(1);
		await capturedPromises[0];

		// Flush microtasks
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		// It should never have mounted, and the hub should be disposed
		expect(disposed).toBe(true);
		expect(shown).toBeUndefined();
	});

	it("a second showAgentHub call during the pending wait supersedes the first (stale hub never mounts)", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-supersede-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await fs.promises.mkdir(path.join(tempDir.path(), "main"), { recursive: true });
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const agents = new AgentRegistry();

		const mountedHubs: AgentHubOverlayComponent[] = [];
		const editor = {};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor] as unknown[],
				clear() {
					this.children = [];
				},
				addChild(child: unknown) {
					this.children.push(child);
					if (child !== editor) mountedHubs.push(child as AgentHubOverlayComponent);
				},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		// Deliberate documented escape hatch: InteractiveModeContext is far wider
		// than the slice showAgentHub touches; a structural fake cannot satisfy it.
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		let totalDisposedCount = 0;
		const originalOnChange = agents.onChange.bind(agents);
		agents.onChange = cb => {
			const unsub = originalOnChange(cb);
			return () => {
				totalDisposedCount++;
				unsub();
			};
		};

		// Call 1
		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });
		// Call 2 immediately after
		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		// We should have captured two hubs
		expect(capturedPromises.length).toBe(2);

		// Wait for both to resolve
		await Promise.all(capturedPromises);

		// Flush microtasks
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		// Only one hub should have mounted (the second one)
		expect(mountedHubs.length).toBe(1);

		// First hub must be disposed (totalDisposedCount should be 1, which was done synchronously in showAgentHub 2)
		expect(totalDisposedCount).toBe(1);

		// Dispose the second (active) hub to clean up
		mountedHubs[0].dispose();
		expect(totalDisposedCount).toBe(2);
	});

	it("a pending requireContent hub is superseded by another selector opening (showSelector) before it settles, so the pending hub never mounts", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-cross-supersede-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await fs.promises.mkdir(path.join(tempDir.path(), "main"), { recursive: true });
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const agents = new AgentRegistry();

		const mountedComponents: any[] = [];
		const editor = { id: "editor" };
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor] as unknown[],
				clear() {
					this.children = [];
				},
				addChild(child: unknown) {
					this.children.push(child);
					mountedComponents.push(child);
				},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		let totalDisposedCount = 0;
		const originalOnChange = agents.onChange.bind(agents);
		agents.onChange = cb => {
			const unsub = originalOnChange(cb);
			return () => {
				totalDisposedCount++;
				unsub();
			};
		};

		// 1. Trigger pending showAgentHub (requireContent: true)
		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		// We should have captured one hub
		expect(capturedPromises.length).toBe(1);
		const pendingHub = capturedHubs[0];

		// 2. Open another selector before the promise resolves
		const otherComponent = { id: "other-selector", render: () => [] as string[] };
		controller.showSelector(() => ({
			component: otherComponent,
			focus: otherComponent,
		}));

		// The pending hub should have been disposed immediately when superseded
		expect(totalDisposedCount).toBe(1);

		// Now await the pending hub's scan to settle
		await capturedPromises[0];

		// Flush microtasks
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		// The pending hub must NOT be in the mounted components list
		expect(mountedComponents).toContain(otherComponent);
		expect(mountedComponents).not.toContain(pendingHub);

		// The container children should still have only the other selector
		expect(ctx.editorContainer.children).toEqual([otherComponent]);
	});
});
