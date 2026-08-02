import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { SideController } from "@oh-my-pi/pi-coding-agent/modes/controllers/side-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SIDE_BOUNDARY_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SIDE_AGENT_ID } from "@oh-my-pi/pi-coding-agent/session/side-conversation";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

interface SideSessionEvent {
	type: string;
	result?: unknown;
	aborted?: boolean;
}

/** The surface of the side-session stub that createAgentSessionSpy passes through. */
interface SideSessionStub {
	agent: { appendMessage: (message: unknown) => void };
	setTodoPhases: (phases: never[]) => void;
	subscribe: (listener: (event: SideSessionEvent) => void) => () => void;
	sendCustomMessage: (
		message: { customType?: string; content?: unknown; display?: boolean; attribution?: string },
		options?: { triggerTurn?: boolean; deliverAs?: string },
	) => Promise<void>;
	prompt: () => Promise<void>;
	dispose: () => Promise<void>;
	getActiveToolNames: () => string[];
	systemPrompt: string[];
}

/** Minimal side session stub covering the surface SideController drives. */
function createSideStub(overrides?: {
	prompt?: () => Promise<void>;
	systemPrompt?: string[];
	activeToolNames?: string[];
	/** Called by sendCustomMessage on the idle nextTurn path, mirroring
	 * AgentSession's sessionManager.appendCustomMessageEntry persistence seam. */
	persistCustomMessage?: (entry: {
		customType: string | undefined;
		content: unknown;
		display: boolean | undefined;
		attribution: string | undefined;
	}) => void;
}) {
	const appendMessage = vi.fn();
	let listener: ((event: SideSessionEvent) => void) | undefined;
	const stub = {
		agent: { appendMessage },
		setTodoPhases: vi.fn(),
		subscribe: vi.fn((l: (event: SideSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		sendCustomMessage: vi.fn(
			async (
				message: { customType?: string; content?: unknown; display?: boolean; attribution?: string },
				options?: { triggerTurn?: boolean; deliverAs?: string },
			) => {
				// Mirror the real AgentSession idle + nextTurn + triggerTurn:false
				// path (agent-session.ts:5666-5673): persist a custom_message entry
				// via the session manager seam. Re-injection does NOT go through
				// this path — it calls agent.appendMessage directly — so only the
				// boundary creation persists a side-boundary entry.
				if (options?.deliverAs === "nextTurn" && !options?.triggerTurn && overrides?.persistCustomMessage) {
					overrides.persistCustomMessage({
						customType: message.customType,
						content: message.content,
						display: message.display,
						attribution: message.attribution,
					});
				}
			},
		),
		prompt: vi.fn(overrides?.prompt ?? (async () => {})),
		dispose: vi.fn(async () => {}),
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		systemPrompt: overrides?.systemPrompt ?? ["system prompt"],
	};
	return {
		stub,
		appendMessage,
		get compactionListener() {
			return listener;
		},
	};
}

function createContext(tempDir: TempDir) {
	// Isolate the parent session inside the TempDir — the default session dir is
	// the real user store (~/.omp/agent/sessions), which tests would pollute.
	const parentManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const parentFile = parentManager.getSessionFile();
	if (!parentFile) throw new Error("parent session file was not created");

	const session = {
		model,
		sessionId: "parent-session",
		agent: { promptCacheKey: undefined },
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		getActiveToolNames: vi.fn(() => ["read", "bash", "task", "hub"]),
		modelRegistry: { authStorage: { marker: "auth" } },
		getAgentId: vi.fn(() => undefined),
	} as unknown as InteractiveModeContext["session"];

	const settings = Settings.isolated({ "task.enableLsp": true });
	const uiContext = { marker: "ui-context" } as unknown as ExtensionUIContext;
	// Mutable focus holder: tests flip it after creation to simulate the user
	// focusing into the side, since the ctx type marks focusedAgentId readonly.
	const focusState: { current: string | undefined } = { current: undefined };

	const ctx = {
		session,
		sessionManager: parentManager,
		settings,
		mcpManager: undefined,
		collabGuest: undefined,
		get focusedAgentId() {
			return focusState.current;
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		focusAgentSession: vi.fn(async () => {}),
		unfocusSession: vi.fn(async () => {}),
		getToolUIContext: vi.fn(() => uiContext),
		withLocalSubmission: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return { tempDir, parentManager, parentFile, ctx, uiContext, focusState };
}

/**
 * Build a createAgentSession spy that simulates the SDK registration protocol:
 * registerIfAvailable with expectedAgentRef:null, create the side file on disk,
 * attach the session, set status to idle, and return a CreateAgentSessionResult.
 */
function createAgentSessionSpy(
	stub: SideSessionStub,
	setToolUIContext: (ctx: unknown, focused: boolean) => void,
	sideFileFromManager: () => string | undefined,
) {
	return vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options?: CreateAgentSessionOptions) => {
		if (!options) throw new Error("options required");
		const registry = AgentRegistry.global();
		const sideFile = sideFileFromManager();
		const ref = registry.registerIfAvailable(
			{
				id: SIDE_AGENT_ID,
				displayName: options.agentDisplayName ?? "side",
				kind: "sub",
				parentId: options.parentAgentId,
				session: null,
				sessionFile: sideFile ?? null,
				status: "running",
			},
			options.expectedAgentRef ?? null,
		);
		if (!ref) {
			throw new Error(`Agent "${SIDE_AGENT_ID}" is already owned by another session generation.`);
		}
		// Create the side file on disk so removeSessionFiles can delete it.
		if (sideFile) {
			const dir = sideFile.slice(0, -6);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				sideFile,
				`${JSON.stringify({ type: "session", id: "side", timestamp: "2025-01-01T00:00:00Z", cwd: "." })}\n`,
			);
		}
		// Attach the live session (simulating sdk.ts:3380-3386).
		registry.attachSession(SIDE_AGENT_ID, stub as unknown as AgentSession, sideFile ?? null, ref);
		registry.setStatus(SIDE_AGENT_ID, "idle");
		return {
			session: stub,
			setToolUIContext,
			extensionsResult: { extensions: [], runtime: {}, errors: [] },
			eventBus: { emit: vi.fn(), on: vi.fn() },
		} as unknown as CreateAgentSessionResult;
	});
}

describe("SideController", () => {
	let tempDir: TempDir;

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		if (tempDir) tempDir.removeSync();
	});

	it("walks the full lifecycle: create, boundary, compaction re-injection, end, queue serialization", async () => {
		tempDir = TempDir.createSync("@omp-side-controller-");
		const harness = createContext(tempDir);

		// Recording side manager: models the persistence seam the production code
		// writes through. sendCustomMessage's idle nextTurn path calls
		// appendCustomMessageEntry (as AgentSession does at agent-session.ts:5667);
		// the controller calls appendCustomEntry directly for todo clearing. Both
		// record here so the test asserts on persisted entries, not mock call counts.
		const recordedEntries: Array<{ type: "custom_message" | "custom"; customType?: string; display?: boolean }> = [];
		const appendCustomMessageEntry = vi.fn(
			(customType?: string, _content?: unknown, display?: boolean, _details?: unknown, _attribution?: string) => {
				recordedEntries.push({ type: "custom_message", customType, display });
			},
		);
		const appendCustomEntry = vi.fn((customType: string) => {
			recordedEntries.push({ type: "custom", customType });
		});

		const sideStub = createSideStub({
			activeToolNames: ["read", "bash"],
			persistCustomMessage: ({ customType, content, display, attribution }) =>
				appendCustomMessageEntry(customType, content, display, undefined, attribution),
		});
		const { stub, appendMessage } = sideStub;
		const setToolUIContext = vi.fn();

		// --- Stage 1: Create path ---
		let capturedForkArgs: Parameters<typeof SessionManager.forkFrom> | undefined;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			capturedForkArgs = args;
			const opts = args[4];
			const sideFile = opts?.sessionFile;
			return {
				getSessionFile: () => sideFile,
				appendCustomEntry,
				appendCustomMessageEntry,
				appendSessionInit: vi.fn(),
			} as unknown as SessionManager;
		});

		let capturedCreateOpts: CreateAgentSessionOptions | undefined;
		const createSpy = createAgentSessionSpy(stub, setToolUIContext, () => {
			const opts = capturedForkArgs?.[4];
			return opts?.sessionFile;
		});
		const origImpl = createSpy.getMockImplementation();
		if (!origImpl) throw new Error("createAgentSession spy has no implementation");
		createSpy.mockImplementation(async (options?: CreateAgentSessionOptions) => {
			if (!options) throw new Error("options required");
			capturedCreateOpts = options;
			return origImpl(options);
		});

		const controller = new SideController(harness.ctx);
		await controller.start("what changed");

		// Stage 1: forkFrom received the parent file and a side.internal-*.jsonl.
		expect(capturedForkArgs?.[0]).toBe(harness.parentFile);
		expect(capturedForkArgs?.[4]?.sessionFile).toMatch(/side\.internal-[0-9a-f]+\.jsonl$/);

		// Stage 1: createAgentSession received the exact field set.
		expect(capturedCreateOpts?.expectedAgentRef).toBeNull();
		expect(capturedCreateOpts?.hasUI).toBe(true);
		expect(capturedCreateOpts?.spawns).toBe("");
		expect(capturedCreateOpts?.taskDepth).toBe(1);
		expect(capturedCreateOpts?.parentTaskPrefix).toBeUndefined();
		expect(capturedCreateOpts?.settings).toBe(harness.ctx.settings);
		const toolNames = capturedCreateOpts?.toolNames;
		expect(toolNames).not.toContain("task");
		expect(toolNames).not.toContain("hub");

		// Stage 1: setToolUIContext called exactly once with the
		// ctx.getToolUIContext() result and true — hasUI:true alone would pass
		// while prompt-gated tools still failed closed.
		expect(setToolUIContext).toHaveBeenCalledTimes(1);
		expect(setToolUIContext).toHaveBeenCalledWith(harness.uiContext, true);

		// --- Stage 2: Boundary persisted + focus called ---
		// Assert on the persisted session entries (the real seam), not on mock
		// call counts. Exactly one visible side-boundary custom_message entry.
		const boundaryEntries = recordedEntries.filter(
			e => e.type === "custom_message" && e.customType === SIDE_BOUNDARY_MESSAGE_TYPE,
		);
		expect(boundaryEntries).toHaveLength(1);
		expect(boundaryEntries[0]?.display).toBe(true);
		expect(harness.ctx.focusAgentSession).toHaveBeenCalledWith(SIDE_AGENT_ID);

		// Snapshot parent entry ids AFTER ensureOnDisk/flush (the create path
		// already ran them). The parent should not be modified by the side.
		const parentEntryIds = harness.parentManager.getEntries().map(e => e.id);

		// --- Stage 3: Boundary re-injection after compaction ---

		// 3a: The controller no longer subscribes to the session event stream —
		// automatic compaction's "auto_compaction_end" event must NOT re-inject.
		// The single mechanism is the inline "session_compact" extension handler,
		// which covers both manual and automatic compaction (both emit
		// "session_compact" on success). Assert no subscriber was registered,
		// and that emitting the event (a no-op with no listener) adds no message.
		expect(sideStub.compactionListener).toBeUndefined();
		const appendCountBefore = appendMessage.mock.calls.length;
		sideStub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
		expect(appendMessage.mock.calls.length).toBe(appendCountBefore);
		expect(
			recordedEntries.filter(e => e.type === "custom_message" && e.customType === SIDE_BOUNDARY_MESSAGE_TYPE),
		).toHaveLength(1);

		// 3b: session_compact path — invoke the registered extension handler.
		// The inline extension factory was passed to createAgentSession; since
		// the spy doesn't load extensions, capture and invoke it manually.
		const extensionFactories = capturedCreateOpts?.extensions ?? [];
		expect(extensionFactories.length).toBeGreaterThan(0);
		const compactHandlers: Array<() => void> = [];
		const fakeApi = {
			on: ((event: string, handler: () => void) => {
				if (event === "session_compact") compactHandlers.push(handler);
			}) as Partial<ExtensionAPI["on"]> as ExtensionAPI["on"],
		} as unknown as ExtensionAPI;
		for (const factory of extensionFactories) {
			await factory(fakeApi);
		}
		expect(compactHandlers).toHaveLength(1);

		const appendCountBeforeManual = appendMessage.mock.calls.length;
		const compactHandler = compactHandlers[0];
		if (!compactHandler) throw new Error("session_compact handler was not registered");
		compactHandler();
		expect(appendMessage.mock.calls.length).toBe(appendCountBeforeManual + 1);
		expect(appendMessage.mock.calls[appendMessage.mock.calls.length - 1]?.[0]).toEqual(
			expect.objectContaining({
				role: "developer",
				content: expect.stringContaining('<system-notice cause="side-conversation">'),
			}),
		);
		// Still no second persisted side-boundary entry.
		expect(
			recordedEntries.filter(e => e.type === "custom_message" && e.customType === SIDE_BOUNDARY_MESSAGE_TYPE),
		).toHaveLength(1);

		// --- Stage 4: start("end") destroys file + ref, parent entries unchanged ---
		const sideFile = capturedForkArgs?.[4]?.sessionFile;
		if (!sideFile) throw new Error("side file path was not captured");
		expect(fs.existsSync(sideFile)).toBe(true);

		await controller.start("end");

		expect(fs.existsSync(sideFile)).toBe(false);
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeUndefined();
		// Parent entry ids unchanged — the side conversation never wrote to the parent.
		expect(harness.parentManager.getEntries().map(e => e.id)).toEqual(parentEntryIds);

		// --- Stage 5: Queue serialization ---
		// Reset spies for the serialization test.
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();

		const harness2 = createContext(tempDir);
		const stub2 = createSideStub({ activeToolNames: ["read", "bash"] });
		const setToolUIContext2 = vi.fn();
		const gate = Promise.withResolvers<void>();
		const createStarted = Promise.withResolvers<void>();

		let capturedForkArgs2: Parameters<typeof SessionManager.forkFrom> | undefined;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			capturedForkArgs2 = args;
			const sideFile2 = args[4]?.sessionFile;
			return {
				getSessionFile: () => sideFile2,
				appendCustomEntry: vi.fn(),
				appendSessionInit: vi.fn(),
			} as unknown as SessionManager;
		});

		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options?: CreateAgentSessionOptions) => {
			if (!options) throw new Error("options required");
			createStarted.resolve();
			const registry = AgentRegistry.global();
			const sideFile2 = capturedForkArgs2?.[4]?.sessionFile;
			const ref = registry.registerIfAvailable(
				{
					id: SIDE_AGENT_ID,
					displayName: "side",
					kind: "sub",
					parentId: options.parentAgentId,
					session: null,
					sessionFile: sideFile2 ?? null,
					status: "running",
				},
				options.expectedAgentRef ?? null,
			);
			if (!ref) {
				throw new Error(`Agent "${SIDE_AGENT_ID}" is already owned by another session generation.`);
			}
			if (sideFile2) {
				const dir = sideFile2.slice(0, -6);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(
					sideFile2,
					`${JSON.stringify({ type: "session", id: "side", timestamp: "2025-01-01T00:00:00Z", cwd: "." })}\n`,
				);
			}
			// Block on the gate — simulate a slow createAgentSession.
			await gate.promise;
			registry.attachSession(SIDE_AGENT_ID, stub2.stub as unknown as AgentSession, sideFile2 ?? null, ref);
			registry.setStatus(SIDE_AGENT_ID, "idle");
			return {
				session: stub2.stub,
				setToolUIContext: setToolUIContext2,
				extensionsResult: { extensions: [], runtime: {}, errors: [] },
				eventBus: { emit: vi.fn(), on: vi.fn() },
			} as unknown as CreateAgentSessionResult;
		});

		// Spy on the static deletion method — restored in afterEach. Calls
		// through to the real implementation so the file is actually deleted.
		const removeSessionFilesSpy = vi.spyOn(SessionManager, "removeSessionFiles");

		const controller2 = new SideController(harness2.ctx);

		// Fire start (do not await) — it will block inside createAgentSession.
		const startPromise = controller2.start("q");
		await createStarted.promise;

		// The side file was created by the create spy before blocking on the gate.
		const sideFile2 = capturedForkArgs2?.[4]?.sessionFile;
		if (!sideFile2) throw new Error("side file path was not captured (stage 5)");
		expect(fs.existsSync(sideFile2)).toBe(true);

		// Fire dispose (do not await) — it queues behind start.
		const disposePromise = controller2.dispose();

		// Assert: dispose has NOT cleaned up while create is blocked.
		// The file still exists and the registry ref is untouched (running).
		expect(fs.existsSync(sideFile2)).toBe(true);
		const refDuringCreate = AgentRegistry.global().get(SIDE_AGENT_ID);
		expect(refDuringCreate).toBeDefined();
		expect(refDuringCreate?.status).toBe("running");
		// Deletion has NOT been attempted — proves dispose() is queued, not
		// running concurrently and declining to delete.
		expect(removeSessionFilesSpy).not.toHaveBeenCalled();

		// Resolve the gate — create finishes, then dispose runs.
		gate.resolve();
		await startPromise;
		await disposePromise;

		// Assert: the side file is gone, deletion was called with the side
		// file path, and the registry is empty.
		expect(fs.existsSync(sideFile2)).toBe(false);
		expect(removeSessionFilesSpy).toHaveBeenCalledWith(sideFile2, harness2.parentManager.getStorage());
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeUndefined();
	});

	it("unfocuses a focused side before disposal unregisters it", async () => {
		tempDir = TempDir.createSync("@omp-side-focused-");
		const harness = createContext(tempDir);
		const { stub } = createSideStub({ activeToolNames: ["read", "bash"] });

		// Wrap the real forkFrom so the side manager (and its file) is real;
		// only the path is captured for the assertions.
		let sideFile: string | undefined;
		const realForkFrom = SessionManager.forkFrom;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			sideFile = args[4]?.sessionFile;
			return realForkFrom(...args);
		});
		createAgentSessionSpy(stub, vi.fn(), () => sideFile);

		// Record the ordering of unfocus vs. file deletion.
		const order: string[] = [];
		harness.ctx.unfocusSession = vi.fn(async () => {
			order.push("unfocus");
		});
		const realRemove = SessionManager.removeSessionFiles;
		vi.spyOn(SessionManager, "removeSessionFiles").mockImplementation(async (sessionPath: string) => {
			order.push("delete");
			return realRemove(sessionPath);
		});

		const controller = new SideController(harness.ctx);
		await controller.start("question");
		// Simulate the user focused into the side (the focus stub is inert, so
		// the ctx still reports unfocused until flipped).
		harness.focusState.current = SIDE_AGENT_ID;
		await controller.dispose();

		// Unfocus must precede the file deletion; the ref and file are gone.
		expect(order).toEqual(["unfocus", "delete"]);
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeUndefined();
		if (!sideFile) throw new Error("side file path was not captured");
		expect(fs.existsSync(sideFile)).toBe(false);
	});

	it("disposes a foreign side and recreates when the parent session changes", async () => {
		tempDir = TempDir.createSync("@omp-side-foreign-");
		const harness = createContext(tempDir);
		const { stub } = createSideStub({ activeToolNames: ["read", "bash"] });
		const setToolUIContext = vi.fn();

		// Mutable side-file tracker — the createAgentSession spy reads through
		// this closure to create the file on disk.
		let currentSideFile: string | undefined;
		const realForkFrom = SessionManager.forkFrom;

		// Stage 1: Create side from parent A.
		let forkArgsA: Parameters<typeof SessionManager.forkFrom> | undefined;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			forkArgsA = args;
			currentSideFile = args[4]?.sessionFile;
			return realForkFrom(...args);
		});
		createAgentSessionSpy(stub, setToolUIContext, () => currentSideFile);

		const controller = new SideController(harness.ctx);
		await controller.start("question");

		// Side exists from parent A.
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeDefined();
		const sideFileA = currentSideFile;
		if (!sideFileA) throw new Error("side file A was not created");
		expect(fs.existsSync(sideFileA)).toBe(true);
		expect(forkArgsA?.[0]).toBe(harness.parentFile);

		// Simulate a parent-session transition that does NOT invoke this
		// controller's dispose (SelectorController.handleResumeSession from the
		// blank /resume picker, handoff): create a second parent in a different
		// session directory and swap it onto the ctx.
		const parentB = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions-b"));
		const parentBFile = parentB.getSessionFile();
		if (!parentBFile) throw new Error("parent B session file was not created");
		harness.ctx.sessionManager = parentB;

		// Stage 2: /side again — should detect the foreign side (its file is
		// in parent A's artifact dir, not parent B's), dispose it, and create
		// fresh from parent B.
		let forkArgsB: Parameters<typeof SessionManager.forkFrom> | undefined;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			forkArgsB = args;
			currentSideFile = args[4]?.sessionFile;
			return realForkFrom(...args);
		});

		await controller.start("another question");

		// Old side file (from parent A) is deleted.
		expect(fs.existsSync(sideFileA)).toBe(false);
		// New side file (from parent B) exists.
		const sideFileB = currentSideFile;
		if (!sideFileB) throw new Error("side file B was not created");
		expect(fs.existsSync(sideFileB)).toBe(true);
		// forkFrom received parent B's file, not parent A's.
		expect(forkArgsB?.[0]).toBe(parentBFile);
		// The new side file is inside parent B's artifact directory.
		const parentBArtifactDir = parentBFile.slice(0, -6) + path.sep;
		expect(sideFileB.startsWith(parentBArtifactDir)).toBe(true);
		// The old side file was NOT inside parent B's artifact directory.
		expect(sideFileA.startsWith(parentBArtifactDir)).toBe(false);
		// The registry holds a live ref (the new side, not the old one).
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeDefined();

		// Cleanup.
		await controller.start("end");
		expect(AgentRegistry.global().get(SIDE_AGENT_ID)).toBeUndefined();
	});
});
