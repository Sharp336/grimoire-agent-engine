import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	CouncilCoordinator,
	CouncilCoordinatorHost,
	CouncilCoordinatorSnapshot,
	CouncilMemberLiveProgress,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilPaneComponent } from "@oh-my-pi/pi-coding-agent/modes/components/council-pane";
import {
	CouncilController,
	projectCouncilPaneSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/council-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = "2026-08-05T12:00:00.000Z";

function manifest(state: CouncilManifest["state"] = "reviewing"): CouncilManifest {
	return {
		version: 1,
		runId: "run-1",
		sessionId: "session-1",
		mainAgentId: "Main",
		state,
		task: "Review the implementation",
		repoRoot: "/repo",
		outputPath: "plans/review-the-implementation.md",
		timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: NOW },
		config: { rounds: 1, members: [{ role: "council1", enabled: true, order: 0 }] },
		roster: [
			{
				role: "council1",
				enabled: true,
				order: 0,
				requestedSelector: "openai/gpt-5.6-sol:max",
				resolvedModel: "openai/gpt-5.6-sol:max",
				effort: "max",
				lens: "Adversarial correctness",
			},
		],
		planner: {
			requestedSelector: "openai/gpt-5.6-sol:max",
			resolvedModel: "openai/gpt-5.6-sol:max",
			effort: "max",
		},
		mainSnapshot: { model: "anthropic/claude-opus-4.1:high", effort: "high", capturedAt: NOW },
		instructionSnapshot: {
			artifact: {
				url: "local://council-run-1-instructions.json",
				sha256: "1".repeat(64),
				bytes: 128,
			},
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: NOW,
				finishedAt: null,
				members: [
					{
						role: "council1",
						order: 0,
						status: "running",
						attempts: 2,
						startedAt: NOW,
						finishedAt: null,
						artifact: null,
						resolvedModel: "openai/gpt-5.6-sol:max",
						authFallbackUsed: false,
						failureReason: null,
						findingIds: [],
					},
				],
			},
		],
		planVersions: [
			{
				version: 1,
				round: 0,
				kind: "draft",
				artifact: { url: "local://council-run-1-draft.md", sha256: "a".repeat(64), bytes: 5 },
				createdAt: NOW,
			},
		],
		usage: { requests: 2, tokens: 100, cost: 0.25 },
		adjudicationBudget: { injectedChars: 100, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
}

function coordinatorSnapshot(
	state: CouncilManifest["state"] = "reviewing",
	mainTurnOwned = state === "adjudicating",
): CouncilCoordinatorSnapshot {
	const progress: CouncilMemberLiveProgress = {
		round: 1,
		role: "council1",
		order: 0,
		attempt: 2,
		status: "running",
		lastIntent: "Inspecting the failure path",
		currentTool: "read",
		currentToolArgs: "src/service.ts:10-20",
		recentOutput: ["Found an unchecked transition"],
		requests: 3,
		tokens: 4_500,
		cost: 0.031,
		retryState: {
			attempt: 2,
			maxAttempts: 3,
			delayMs: 500,
			errorMessage: "rate limited",
			startedAtMs: Date.parse(NOW),
		},
	};
	return { manifest: manifest(state), members: [progress], mainTurnOwned };
}

describe("CouncilController", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("projects planner, Main, and live roster telemetry without mutating the coordinator snapshot", () => {
		const input = coordinatorSnapshot();
		const before = structuredClone(input);
		const projected = projectCouncilPaneSnapshot(input);
		expect(input).toEqual(before);
		expect(projected.rows.map(item => item.label)).toEqual(["Planner", "Main", "council1"]);
		expect(projected.rows[0]?.model).toBe("openai/gpt-5.6-sol:max");
		expect(projected.rows[1]?.model).toBe("anthropic/claude-opus-4.1:high");
		expect(projected.rows[2]).toMatchObject({
			status: "retry",
			attempts: 2,
			currentTool: "read",
			currentToolArgs: "src/service.ts:10-20",
			requests: 3,
			tokens: 4_500,
			cost: 0.031,
		});
	});
	it("projects bounded sanitized manifest and auth-fallback warnings into the live pane", () => {
		const input = coordinatorSnapshot();
		input.manifest.warnings = [
			`\u001b[31mduplicate\tmodel\n${"界".repeat(100)}MANIFEST_WARNING_TAIL`,
			...Array.from({ length: 6 }, (_, index) => `manifest warning ${index + 2}`),
		];
		input.manifest.rounds[0]!.members[0]!.authFallbackUsed = true;

		const projected = projectCouncilPaneSnapshot(input);
		const warnings = [...(projected.warnings ?? [])];
		expect(warnings).toHaveLength(6);
		expect(warnings).toContain("council1 used an authentication fallback");
		expect(warnings.some(warning => warning.includes("duplicate model"))).toBeTrue();
		for (const warning of warnings) {
			expect(warning).not.toContain("\t");
			expect(warning).not.toContain("\n");
			expect(warning).not.toContain("\u001b");
			expect(Bun.stringWidth(warning)).toBeLessThanOrEqual(80);
		}
		expect(warnings.join(" ")).not.toContain("MANIFEST_WARNING_TAIL");

		const pane = new CouncilPaneComponent({
			tui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			now: () => Date.parse(NOW),
		});
		pane.update(projected);
		expect(Bun.stripANSI(pane.render(140).join("\n"))).toContain("6w");
	});
	it("selects the lifecycle-owned round across planning, review, adjudication, and transition", () => {
		const stages: Array<{
			state: CouncilManifest["state"];
			firstStatus: CouncilManifest["rounds"][number]["status"];
			expectedRound: number;
			hasRoundOneTelemetry: boolean;
			roundOnePublished: boolean;
		}> = [
			{
				state: "planning",
				firstStatus: "pending",
				expectedRound: 1,
				hasRoundOneTelemetry: false,
				roundOnePublished: false,
			},
			{
				state: "reviewing",
				firstStatus: "running",
				expectedRound: 1,
				hasRoundOneTelemetry: true,
				roundOnePublished: false,
			},
			{
				state: "adjudicating",
				firstStatus: "settled",
				expectedRound: 1,
				hasRoundOneTelemetry: true,
				roundOnePublished: false,
			},
			{
				state: "round-transition",
				firstStatus: "settled",
				expectedRound: 2,
				hasRoundOneTelemetry: false,
				roundOnePublished: true,
			},
		];

		for (const stage of stages) {
			const input = coordinatorSnapshot(stage.state);
			const first = input.manifest.rounds[0]!;
			first.status = stage.firstStatus;
			first.finishedAt = stage.firstStatus === "settled" ? NOW : null;
			if (stage.firstStatus === "pending") {
				first.members[0]!.status = "pending";
				first.members[0]!.attempts = 0;
			}
			const second = structuredClone(first);
			second.round = 2;
			second.status = "pending";
			second.startedAt = null;
			second.finishedAt = null;
			second.members[0]!.status = "pending";
			second.members[0]!.attempts = 0;
			second.members[0]!.startedAt = null;
			second.members[0]!.finishedAt = null;
			input.manifest.rounds = [first, second];
			input.manifest.config.rounds = 2;
			input.members = stage.hasRoundOneTelemetry ? [{ ...input.members[0]!, currentTool: "round-one-tool" }] : [];
			if (stage.state === "planning") {
				input.manifest.planVersions = [];
			} else if (stage.roundOnePublished) {
				const draft = input.manifest.planVersions[0]!;
				input.manifest.planVersions = [draft, { ...draft, version: 2, round: 1, kind: "round" }];
			}

			const projected = projectCouncilPaneSnapshot(input);
			expect(projected.round).toBe(stage.expectedRound);
			if (stage.hasRoundOneTelemetry) {
				expect(projected.rows[2]?.currentTool).toBe("round-one-tool");
			} else {
				expect(projected.rows[2]?.currentTool).toBeUndefined();
			}
		}
	});
	it("keeps an interrupted unresolved round selected during resume hydration", () => {
		const input = coordinatorSnapshot("reviewing");
		const first = input.manifest.rounds[0]!;
		first.status = "interrupted";
		first.finishedAt = NOW;
		first.members[0]!.status = "interrupted";
		first.members[0]!.finishedAt = NOW;
		const second = structuredClone(first);
		second.round = 2;
		second.status = "pending";
		second.startedAt = null;
		second.finishedAt = null;
		second.members[0]!.status = "pending";
		second.members[0]!.attempts = 0;
		second.members[0]!.startedAt = null;
		second.members[0]!.finishedAt = null;
		input.manifest.rounds = [first, second];
		input.manifest.config.rounds = 2;
		input.members = [];

		const projected = projectCouncilPaneSnapshot(input);
		expect(projected.round).toBe(1);
		expect(projected.rows[2]?.status).toBe("interrupted");
	});

	it("uses the exact live host, subscribes once, repaints ticks locally, cancels, and detaches", async () => {
		const active = coordinatorSnapshot("adjudicating");
		let listener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		const unsubscribe = vi.fn();
		const inputUnsubscribe = vi.fn();
		const cancelGate = Promise.withResolvers<void>();
		const cancel = vi.fn(async () => {
			await cancelGate.promise;
		});
		const status = vi.fn(async () => active.manifest);
		const coordinator = {
			snapshot: active.manifest,
			coordinatorSnapshot: active,
			completion: undefined,
			subscribe: vi.fn((next: (value: CouncilCoordinatorSnapshot) => void) => {
				listener = next;
				next(active);
				return unsubscribe;
			}),
			status,
			cancel,
			cancelForSessionTransition: cancel,
		} as unknown as CouncilCoordinator;
		let coordinatorHost: CouncilCoordinatorHost | undefined;
		const getCoordinator = vi.fn((host: CouncilCoordinatorHost) => {
			coordinatorHost = host;
			return coordinator;
		});
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
		const toolSession = { marker: "live-tool-session" };
		const sessionManager = { getSessionId: () => "session-1" };
		const settings = { marker: "settings" };
		const modelRegistry = { marker: "registry" };
		const session = { getToolSession: () => toolSession, modelRegistry };
		const ui = {
			requestRender,
			requestComponentRender,
			addInputListener: vi.fn((input: (data: string) => { consume?: boolean } | undefined) => {
				inputListeners.push(input);
				return inputUnsubscribe;
			}),
		};
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
			now: () => Date.parse(NOW),
		});
		const showError = vi.fn();
		const controller = new CouncilController(
			{
				session,
				sessionManager,
				settings,
				ui,
				councilPane: pane,
				showError,
			} as unknown as InteractiveModeContext,
			{ getCoordinator },
		);

		controller.attach();
		controller.attach();
		expect(getCoordinator).toHaveBeenCalledTimes(1);
		expect(coordinatorHost).toMatchObject({
			session,
			toolSession,
			sessionManager,
			settings,
			modelRegistry,
		});
		expect(controller.hasActiveCouncil()).toBeTrue();
		expect(controller.isCouncilAdjudicating()).toBeTrue();
		listener?.({ ...active, mainTurnOwned: false });
		expect(controller.isCouncilAdjudicating()).toBeFalse();
		listener?.({ ...active, mainTurnOwned: true });
		expect(controller.isCouncilAdjudicating()).toBeTrue();
		expect(pane.render(120).length).toBeGreaterThan(0);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestComponentRender).toHaveBeenCalledWith(pane);
		expect(requestRender).not.toHaveBeenCalled();

		let transitionSettled = false;
		const transitionCancellation = controller.quiesceForSessionTransition().then(() => {
			transitionSettled = true;
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(controller.isCouncilAdjudicating()).toBeFalse();
		listener?.({ ...active, manifest: manifest("completed") });
		expect(controller.cancelCouncilRun()).toBeFalse();
		let concurrentTransitionSettled = false;
		const concurrentTransitionCancellation = controller.quiesceForSessionTransition().then(() => {
			concurrentTransitionSettled = true;
		});
		await Promise.resolve();
		expect(transitionSettled).toBeFalse();
		expect(concurrentTransitionSettled).toBeFalse();
		cancelGate.resolve();
		await Promise.all([transitionCancellation, concurrentTransitionCancellation]);
		expect(transitionSettled).toBeTrue();
		expect(concurrentTransitionSettled).toBeTrue();

		listener?.({ ...active, manifest: manifest("completed") });
		expect(controller.hasActiveCouncil()).toBeFalse();
		await controller.quiesceForSessionTransition();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(pane.render(120)).toEqual([]);
		controller.dispose();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(inputUnsubscribe).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});
	it("treats preflight-only execution as active and blocks transition until cancellation settles", async () => {
		let executionInFlight = true;
		const cancelGate = Promise.withResolvers<void>();
		const cancelForSessionTransition = vi.fn(async () => {
			await cancelGate.promise;
			executionInFlight = false;
		});
		const coordinator = {
			get executionInFlight() {
				return executionInFlight;
			},
			snapshot: undefined,
			coordinatorSnapshot: undefined,
			completion: undefined,
			subscribe: vi.fn(() => vi.fn()),
			status: vi.fn(async () => undefined),
			cancelForSessionTransition,
		} as unknown as CouncilCoordinator;
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
		});
		const controller = new CouncilController(
			{
				session: { getToolSession: () => ({}), modelRegistry: {} },
				sessionManager: { getSessionId: () => "session-preflight" },
				settings: {},
				ui: { addInputListener: vi.fn(() => vi.fn()), requestRender, requestComponentRender },
				councilPane: pane,
				showError: vi.fn(),
			} as unknown as InteractiveModeContext,
			{ getCoordinator: () => coordinator },
		);
		controller.attach();
		expect(controller.hasActiveCouncil()).toBeTrue();

		let storageMoved = false;
		const transition = controller.quiesceForSessionTransition().then(() => {
			storageMoved = true;
		});
		expect(cancelForSessionTransition).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(storageMoved).toBeFalse();

		cancelGate.resolve();
		await transition;
		expect(storageMoved).toBeTrue();
		expect(controller.hasActiveCouncil()).toBeFalse();
		controller.dispose();
	});
	it("rebinds by session generation without leaking old emissions or input listeners", async () => {
		let sessionId = "session-1";
		const oldSnapshot = coordinatorSnapshot("reviewing");
		oldSnapshot.manifest.outputPath = "plans/old-session.md";
		const newSnapshot = coordinatorSnapshot("adjudicating");
		newSnapshot.manifest.runId = "run-2";
		newSnapshot.manifest.sessionId = "session-2";
		newSnapshot.manifest.outputPath = "plans/new-session.md";
		const restoredSnapshot = coordinatorSnapshot("adjudicating");
		restoredSnapshot.manifest.runId = "run-3";
		restoredSnapshot.manifest.outputPath = "plans/restored-session.md";

		let oldListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let newListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let restoredListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let releaseOldStatus!: () => void;
		const oldStatusGate = new Promise<void>(resolve => {
			releaseOldStatus = resolve;
		});
		const oldUnsubscribe = vi.fn();
		const newUnsubscribe = vi.fn();
		const restoredUnsubscribe = vi.fn();
		const inputUnsubscribe = vi.fn();
		const oldCancel = vi.fn(async () => manifest("interrupted"));
		const newCancel = vi.fn(async () => manifest("interrupted"));
		const restoredCancel = vi.fn(async () => manifest("interrupted"));
		const oldCoordinator = {
			snapshot: oldSnapshot.manifest,
			coordinatorSnapshot: oldSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				oldListener = listener;
				listener(oldSnapshot);
				return oldUnsubscribe;
			}),
			status: vi.fn(async () => {
				await oldStatusGate;
				oldListener?.(oldSnapshot);
				return oldSnapshot.manifest;
			}),
			cancel: oldCancel,
			cancelForSessionTransition: oldCancel,
		} as unknown as CouncilCoordinator;
		const newCoordinator = {
			snapshot: newSnapshot.manifest,
			coordinatorSnapshot: newSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				newListener = listener;
				listener(newSnapshot);
				return newUnsubscribe;
			}),
			status: vi.fn(async () => newSnapshot.manifest),
			cancel: newCancel,
			cancelForSessionTransition: newCancel,
		} as unknown as CouncilCoordinator;
		const restoredCoordinator = {
			snapshot: restoredSnapshot.manifest,
			coordinatorSnapshot: restoredSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				restoredListener = listener;
				listener(restoredSnapshot);
				return restoredUnsubscribe;
			}),
			status: vi.fn(async () => restoredSnapshot.manifest),
			cancel: restoredCancel,
			cancelForSessionTransition: restoredCancel,
		} as unknown as CouncilCoordinator;
		const coordinatorHosts: CouncilCoordinatorHost[] = [];
		const coordinatorByToolSession = new Map<object, CouncilCoordinator>();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const addInputListener = vi.fn(() => inputUnsubscribe);
		const oldToolSession = { marker: "a-old-tool-session" };
		const bToolSession = { marker: "b-tool-session" };
		const restoredToolSession = { marker: "a-restored-tool-session" };
		const modelRegistry = { marker: "registry" };
		const oldSession = { marker: "a-old-session", getToolSession: () => oldToolSession, modelRegistry };
		const bSession = { marker: "b-session", getToolSession: () => bToolSession, modelRegistry };
		const restoredSession = {
			marker: "a-restored-session",
			getToolSession: () => restoredToolSession,
			modelRegistry,
		};
		let activeSession = oldSession;
		const sessionManager = { getSessionId: () => sessionId };
		coordinatorByToolSession.set(oldToolSession, oldCoordinator);
		coordinatorByToolSession.set(bToolSession, newCoordinator);
		coordinatorByToolSession.set(restoredToolSession, restoredCoordinator);
		const restoredHostLabels = new Map<object, string>([
			[restoredToolSession, "restored-tool"],
			[restoredSession, "restored-session"],
		]);
		const getCoordinator = vi.fn((host: CouncilCoordinatorHost) => {
			coordinatorHosts.push(host);
			const coordinator = coordinatorByToolSession.get(host.toolSession);
			if (!coordinator) throw new Error("Unexpected Council host");
			return coordinator;
		});
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
		});
		const controller = new CouncilController(
			{
				get session() {
					return activeSession;
				},
				sessionManager,
				settings: { marker: "settings" },
				ui: { addInputListener, requestRender, requestComponentRender },
				councilPane: pane,
				showError: vi.fn(),
			} as unknown as InteractiveModeContext,
			{ getCoordinator },
		);

		controller.attach();
		expect(pane.snapshot?.outputPath).toBe("plans/old-session.md");
		expect(addInputListener).toHaveBeenCalledTimes(1);

		sessionId = "session-2";
		activeSession = bSession;
		controller.rebindForSession();
		controller.rebindForSession();
		expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
		expect(getCoordinator).toHaveBeenCalledTimes(2);
		expect(newCoordinator.subscribe).toHaveBeenCalledTimes(1);
		expect(addInputListener).toHaveBeenCalledTimes(1);
		expect(pane.snapshot?.outputPath).toBe("plans/new-session.md");

		oldListener?.(oldSnapshot);
		expect(pane.snapshot?.outputPath).toBe("plans/new-session.md");
		releaseOldStatus();
		await Promise.resolve();
		await Promise.resolve();
		expect(pane.snapshot?.outputPath).toBe("plans/new-session.md");

		sessionId = "session-1";
		activeSession = restoredSession;
		controller.rebindForSession();
		expect(newUnsubscribe).toHaveBeenCalledTimes(1);
		expect(getCoordinator).toHaveBeenCalledTimes(3);
		const restoredHost = coordinatorHosts[2];
		expect(restoredHost).toBeDefined();
		if (!restoredHost) throw new Error("Expected restored Council host");
		expect(restoredHostLabels.get(restoredHost.toolSession)).toBe("restored-tool");
		expect(restoredHostLabels.get(restoredHost.session)).toBe("restored-session");
		expect(restoredCoordinator.subscribe).toHaveBeenCalledTimes(1);
		expect(pane.snapshot?.outputPath).toBe("plans/restored-session.md");

		oldListener?.(oldSnapshot);
		newListener?.(newSnapshot);
		expect(pane.snapshot?.outputPath).toBe("plans/restored-session.md");
		expect(controller.cancelCouncilRun()).toBeTrue();
		expect(restoredCancel).toHaveBeenCalledTimes(1);
		expect(newCancel).not.toHaveBeenCalled();
		expect(oldCancel).not.toHaveBeenCalled();
		restoredListener?.({ ...restoredSnapshot, manifest: { ...restoredSnapshot.manifest, state: "completed" } });
		controller.dispose();
		expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
		expect(inputUnsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode Council root placement", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-council-pane-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 fixture model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("mounts the blank Council pane directly after chat and before every other live container", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const chatIndex = mode.ui.children.indexOf(mode.chatContainer);
		expect(chatIndex).toBeGreaterThanOrEqual(0);
		expect(mode.ui.children[chatIndex + 1]).toBe(mode.councilPane);
		expect(mode.councilPane.render(100)).toEqual([]);
		expect(mode.ui.children.indexOf(mode.pendingMessagesContainer)).toBeGreaterThan(chatIndex + 1);
	});
});
