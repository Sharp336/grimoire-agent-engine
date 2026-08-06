import { afterEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	COUNCIL_ADJUDICATION_INJECTION_CAP,
	CouncilCoordinator,
	type CouncilCoordinatorHost,
	type CouncilCoordinatorSnapshot,
	getCouncilCoordinator,
	resetCouncilCoordinatorsForTests,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import type { CouncilDispatchPlan } from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as preflight from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as publication from "@oh-my-pi/pi-coding-agent/council/publication";
import { type CouncilManifest, parseCouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilStorage } from "@oh-my-pi/pi-coding-agent/council/storage";
import type {
	StructuredSubagentRequest,
	StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as subagents from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { CouncilAdjudicationHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { TempDir } from "@oh-my-pi/pi-utils";

const PLAN = [
	"## Context",
	"Repository evidence.",
	"## Approach",
	"1. Make the change.",
	"## Critical files & anchors",
	"`src/example.ts`: established invariant.",
	"## Verification",
	"Exercise the changed path.",
	"## Assumptions & contingencies",
	"No unresolved assumptions.",
].join("\n\n");

const plannerModel = { provider: "planner", id: "fixed" } as Model<Api>;
const mainModel = { provider: "main", id: "fixed" } as Model<Api>;

interface AdjudicationTestState {
	pending?: Promise<void>;
	skipHandler: boolean;
	onPrompt?: () => void;
	onAbort?: () => void;
	busyFailures?: number;
	busyPending?: Promise<void>;
	onBusyAttempt?: () => void;
	plan?: string;
	afterAcceptedError?: Error;
}

interface SummaryTestState {
	failures: number;
	attempts: number;
	declines?: number;
	pending?: Promise<void>;
	onAttempt?: () => void;
}

interface Harness {
	host: CouncilCoordinatorHost;
	dispatch: CouncilDispatchPlan;
	toolSession: ToolSession;
	summaries: unknown[];
	prompts: string[];
	summaryState: SummaryTestState;
	adjudicationState: AdjudicationTestState;
	journal: CouncilManifest[];
}

const temporaryDirectories: TempDir[] = [];

afterEach(async () => {
	vi.useRealTimers();
	mock.restore();
	resetCouncilCoordinatorsForTests();
	await Promise.all(temporaryDirectories.splice(0).map(directory => directory.remove()));
});

function memberModel(role: string): Model<Api> {
	return { provider: "member", id: role } as Model<Api>;
}
function makeHarness(rounds: 1 | 2 = 1, roles = ["correctness", "architecture"]): Harness {
	const temp = TempDir.createSync("@pi-council-coordinator-");
	temporaryDirectories.push(temp);
	const repoRoot = temp.path();
	const settings = Settings.isolated({ "task.maxConcurrency": 2 });
	const journal: CouncilManifest[] = [];
	let handler: CouncilAdjudicationHandler | undefined;
	const toolSession = {
		cwd: repoRoot,
		settings,
		localProtocolOptions: {
			getArtifactsDir: () => temp.join("artifacts"),
			getSessionId: () => "session-one",
		},
		sessionManager: {
			getSessionId: () => "session-one",
			appendCustomEntry: (_type: string, data: unknown) => {
				journal.push(parseCouncilManifest(structuredClone(data)));
				return `${journal.length}`;
			},
		},
		peekCouncilHandler: () => handler ?? undefined,
		setCouncilHandler: (value: CouncilAdjudicationHandler | null) => {
			handler = value ?? undefined;
		},
	} as unknown as ToolSession;
	const summaries: unknown[] = [];
	const prompts: string[] = [];
	const summaryState: SummaryTestState = { failures: 0, attempts: 0 };
	const adjudicationState: AdjudicationTestState = { skipHandler: false };
	const session = {
		model: mainModel,
		thinkingLevel: undefined,
		isStreaming: false,
		messages: [],
		getActiveToolNames: () => ["read", "write"],
		waitForIdle: mock(async () => {}),
		abort: mock(async () => adjudicationState.onAbort?.()),
		promptCustomMessage: mock(async (message: { content: string }, options?: { onPromptStart?: () => void }) => {
			prompts.push(message.content);
			adjudicationState.onPrompt?.();
			if ((adjudicationState.busyFailures ?? 0) > 0) {
				adjudicationState.onBusyAttempt?.();
				if (adjudicationState.busyPending) await adjudicationState.busyPending;
				adjudicationState.busyFailures = (adjudicationState.busyFailures ?? 1) - 1;
				throw new AgentBusyError();
			}
			options?.onPromptStart?.();
			if (adjudicationState.pending) await adjudicationState.pending;
			if (adjudicationState.skipHandler) return;
			const active = toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const ids = [...message.content.matchAll(/"id":"([A-Z]+\d+)"/g)].map(match => match[1]!);
			const result = await active(
				JSON.stringify({
					plan: adjudicationState.plan ?? PLAN,
					dispositions: ids.map(id => ({ id, disposition: "accepted", reason: "Supported", step: "Approach 1" })),
				}),
			);
			if (result.isError) throw new Error("Test adjudication was rejected");
			if (adjudicationState.afterAcceptedError) throw adjudicationState.afterAcceptedError;
		}),
		sendCustomMessage: mock(
			async (
				message: unknown,
				options?: { expectedSessionId?: string; deliveryReceipt?: { delivered: boolean } },
			) => {
				summaryState.attempts++;
				summaryState.onAttempt?.();
				if (summaryState.pending) await summaryState.pending;
				if ((summaryState.declines ?? 0) > 0) {
					summaryState.declines = (summaryState.declines ?? 1) - 1;
					return false;
				}
				if (options?.expectedSessionId && sessionManager.getSessionId() !== options.expectedSessionId) return false;
				if (summaryState.failures > 0) {
					summaryState.failures--;
					throw new Error("transient summary failure");
				}
				summaries.push(message);
				if (options?.deliveryReceipt) options.deliveryReceipt.delivered = true;
				return false;
			},
		),
	};
	const sessionManager = {
		getSessionId: () => "session-one",
		getCwd: () => repoRoot,
	};
	const configMembers = roles.map((role, order) => ({ role, enabled: true, order }));
	const members = configMembers.map(member => ({
		...member,
		requestedSelector: `member/${member.role}`,
		resolvedSelector: `member/${member.role}`,
		model: memberModel(member.role),
		effort: undefined,
		lens: `Inspect ${member.role}`,
	}));
	const instructions = { repoRoot, contextFiles: [], files: [], totalBytes: 0 };
	const dispatch = {
		task: "Implement council coordination",
		cwd: repoRoot,
		repoRoot,
		sessionId: "session-one",
		publicationTarget: {
			repoRoot,
			plansDirectory: temp.join("plans"),
			slug: "implement-council-coordination",
			relativePath: "plans/implement-council-coordination.md",
			absolutePath: temp.join("plans", "implement-council-coordination.md"),
		},
		config: { rounds, members: configMembers },
		rounds,
		roster: configMembers,
		members,
		planner: {
			role: "slow",
			requestedSelector: "planner/fixed",
			resolvedSelector: "planner/fixed",
			model: plannerModel,
			effort: undefined,
		},
		main: { selector: "main/fixed", model: mainModel, effort: undefined },
		instructions,
		warnings: [],
		plannerRequest: {
			session: toolSession,
			invocationKind: "task",
			assignment: "placeholder",
			agent: "council-planner",
			model: "planner/fixed",
			tools: ["read", "grep", "glob", "lsp", "ast_grep"],
			restrictToolNames: true,
			inheritContextFiles: true,
			additionalContextFiles: [],
			skills: [],
			rules: [],
			autoloadSkills: [],
			pinModel: true,
			outputSchema: {},
			schemaMode: "strict",
			enableIrc: false,
		},
		memberRequests: members.map(member => ({
			session: toolSession,
			invocationKind: "task" as const,
			assignment: "placeholder",
			agent: "council-member" as const,
			model: member.resolvedSelector,
			tools: ["read", "grep", "glob", "lsp", "ast_grep"],
			restrictToolNames: true,
			inheritContextFiles: true,
			additionalContextFiles: [],
			skills: [],
			rules: [],
			autoloadSkills: [],
			pinModel: true,
			outputSchema: {},
			schemaMode: "strict" as const,
			enableIrc: false,
		})),
	} satisfies CouncilDispatchPlan;
	const host = {
		session,
		toolSession,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: mock(async () => "test-key") },
		now: () => new Date().toISOString(),
		runId: "run-one",
	} as unknown as CouncilCoordinatorHost;
	return { host, dispatch, toolSession, summaries, summaryState, adjudicationState, prompts, journal };
}

function structuredResult(
	request: StructuredSubagentRequest,
	data: unknown,
	options?: { exitCode?: number },
): StructuredSubagentResult {
	const model = Array.isArray(request.model) ? request.model[0]! : request.model!;
	return {
		result: {
			index: request.index ?? 0,
			id: request.identity?.label ?? "child",
			agent: request.agent ?? "task",
			agentSource: "bundled",
			task: request.assignment,
			assignment: request.assignment,
			exitCode: options?.exitCode ?? 0,
			output: JSON.stringify(data),
			stderr: options?.exitCode ? "schema violation" : "",
			truncated: false,
			durationMs: 1,
			tokens: 10,
			requests: 1,
			resolvedModel: model,
			authFallbackUsed: false,
			structuredOutput: { source: "caller", mode: "strict", status: options?.exitCode ? "invalid" : "valid", data },
		},
		policy: {} as StructuredSubagentResult["policy"],
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "",
		temporaryArtifacts: true,
	};
}

function installDispatch(harness: Harness): void {
	spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
	spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
		const target = path.join(options.repoRoot, ...options.outputPath.split("/"));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, options.content);
		return {
			path: options.outputPath,
			sha256: sha256CouncilContent(options.content),
			bytes: Buffer.byteLength(options.content),
			publishedAt: "2026-08-05T00:00:00.000Z",
			idempotent: false,
		};
	});
}

describe("CouncilCoordinator", () => {
	it("preflights before spend and creates no storage when preflight blocks", async () => {
		const harness = makeHarness();
		const blocker = new Error("blocked before spend");
		spyOn(preflight, "preflightCouncilDispatch").mockRejectedValue(blocker);
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.start("blocked task")).rejects.toBe(blocker);
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("persists dispatch warnings in every coordinator snapshot and terminal summary", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const duplicateWarning = "Council roles correctness and architecture resolve to the same model.";
		harness.dispatch.warnings = [duplicateWarning];
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = await coordinator.start(harness.dispatch.task);
		expect(started.warnings).toEqual([duplicateWarning]);
		await coordinator.completion;
		expect(coordinator.snapshot?.warnings).toEqual([duplicateWarning]);
		expect(JSON.stringify(harness.summaries[0])).toContain(duplicateWarning);
	});

	it("uses an unprefixed UUID as the default run identity", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.host.runId = undefined;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = await coordinator.start(harness.dispatch.task);
		expect(started.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(started.runId).not.toStartWith("council-");
		await coordinator.completion;
	});

	it("refreshes Main identity and overlap warnings from the model that owns adjudication", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const switchedMain = memberModel("correctness");
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			(harness.host.session as { model: Model<Api> }).model = switchedMain;
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.mainSnapshot.model).toBe("member/correctness");
		expect(coordinator.snapshot?.warnings).toContain(
			"Council roles correctness resolve to the Main model member/correctness.",
		);
		expect(coordinator.snapshot?.state).toBe("completed-degraded");
	});
	it("retries Main acquisition when effective effort changes before ownership", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const reasoningMain = {
			provider: "main",
			id: "reasoning",
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "high"] },
		} as unknown as Model<Api>;
		const mutableSession = harness.host.session as unknown as {
			model: Model<Api>;
			thinkingLevel: "low" | "high";
		};
		mutableSession.model = reasoningMain;
		mutableSession.thinkingLevel = "low";
		let acquisitions = 0;
		harness.adjudicationState.onPrompt = () => {
			if (acquisitions++ === 0) mutableSession.thinkingLevel = "high";
		};
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts).toHaveLength(2);
		expect(coordinator.snapshot?.mainSnapshot).toMatchObject({
			model: "main/reasoning",
			effort: "high",
		});
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("fails before prompting when the live adjudication model lacks required capabilities", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const unavailable = { provider: "offline", id: "no-tools", supportsTools: false } as Model<Api>;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			(harness.host.session as { model: Model<Api> }).model = unavailable;
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts).toHaveLength(0);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.reason).toContain("does not support tools");
	});

	it("rejects a stale adjudication handler before manifest creation or model spend", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		harness.toolSession.setCouncilHandler?.(async () => ({
			content: [{ type: "text", text: "stale handler" }],
		}));
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.start(harness.dispatch.task)).rejects.toThrow("already active");
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("aborts a pending preflight before storage or model spend", async () => {
		const harness = makeHarness();
		const preflightPending = Promise.withResolvers<CouncilDispatchPlan>();
		spyOn(preflight, "preflightCouncilDispatch").mockReturnValue(preflightPending.promise);
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);
		const starting = coordinator.start(harness.dispatch.task);
		expect(coordinator.executionInFlight).toBe(true);

		let startError: unknown;
		const observedStart = starting.catch(error => {
			startError = error;
		});
		const cancelling = coordinator.cancelForSessionTransition();
		preflightPending.resolve(harness.dispatch);

		await Promise.all([observedStart, cancelling]);
		expect(startError).toMatchObject({ name: "AbortError" });
		expect(coordinator.executionInFlight).toBe(false);
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("terminalizes a setup cancellation after manifest creation and leaves the next start unblocked", async () => {
		const harness = makeHarness(1, ["correctness"]);
		let run = 0;
		harness.host.runId = () => `run-${++run}`;
		installDispatch(harness);
		const createPersisted = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		let deferFirstCreate = true;
		const create = CouncilStorage.prototype.create;
		spyOn(CouncilStorage.prototype, "create").mockImplementation(async function (
			this: CouncilStorage,
			manifest: CouncilManifest,
		) {
			const created = await create.call(this, manifest);
			if (deferFirstCreate) {
				deferFirstCreate = false;
				createPersisted.resolve();
				await releaseCreate.promise;
			}
			return created;
		});
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		let startError: unknown;
		const starting = coordinator.start(harness.dispatch.task).catch(error => {
			startError = error;
		});
		await createPersisted.promise;

		const cancellation = coordinator.cancelForSessionTransition();
		releaseCreate.resolve();
		await Promise.all([starting, cancellation]);
		expect(startError).toMatchObject({ name: "AbortError" });
		expect(coordinator.snapshot?.state).toBe("interrupted");

		const next = await coordinator.start(harness.dispatch.task);
		expect(next.runId).toBe("run-2");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("keeps an operational planner failure resumable instead of misclassifying missing output as schema failure", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const instructionFile = {
			path: path.join(harness.dispatch.repoRoot, "AGENTS.md"),
			content: "persisted council instructions",
			depth: 0,
		};
		harness.dispatch.instructions = {
			repoRoot: harness.dispatch.repoRoot,
			contextFiles: [instructionFile],
			files: [{ path: instructionFile.path, sha256: sha256CouncilContent(instructionFile.content) }],
			totalBytes: Buffer.byteLength(instructionFile.content),
		};
		installDispatch(harness);
		let plannerFailed = false;
		const resumedContexts: unknown[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				if (!plannerFailed) {
					plannerFailed = true;
					return structuredResult(request, undefined, { exitCode: 1 });
				}
				resumedContexts.push(structuredClone(request.additionalContextFiles));
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			resumedContexts.push(structuredClone(request.additionalContextFiles));
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure?.phase).toBe("planner");
		harness.dispatch.plannerRequest.additionalContextFiles = [
			{ path: instructionFile.path, content: "stale request context", depth: 0 },
		];
		for (const request of harness.dispatch.memberRequests) {
			request.additionalContextFiles = [{ path: instructionFile.path, content: "stale request context", depth: 0 }];
		}
		await coordinator.resume("run-one");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(resumedContexts).toEqual([[instructionFile], [instructionFile]]);
	});

	it.each(["planner", "member", "round"] as const)(
		"adopts a %s artifact crash window without duplicating its model call",
		async phase => {
			const harness = makeHarness(1, ["correctness"]);
			installDispatch(harness);
			let plannerCalls = 0;
			let memberCalls = 0;
			spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
				if (request.agent === "council-planner") {
					plannerCalls++;
					return structuredResult(request, {
						plan: PLAN,
						assumptions: [],
						blockers: [],
						evidenceVersion: "1.0.0",
					});
				}
				memberCalls++;
				return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
			});
			const completed = new CouncilCoordinator(harness.host);
			await completed.start(harness.dispatch.task);
			await completed.completion;

			const rewind = [...harness.journal].reverse().find(candidate => {
				if (phase === "planner") return candidate.planVersions.length === 0 && candidate.state === "planning";
				if (phase === "member") {
					const member = candidate.rounds[0]?.members[0];
					return (
						candidate.planVersions.length === 1 &&
						member?.status === "running" &&
						member.resolvedModel !== null &&
						member.artifact === null
					);
				}
				return candidate.planVersions.length === 1 && candidate.rounds[0]?.status === "settled";
			});
			if (!rewind) throw new Error(`Missing ${phase} crash-window manifest fixture`);
			const storage = new CouncilStorage(harness.toolSession);
			await storage.checkpoint(structuredClone(rewind));
			const artifactsDirectory = harness.toolSession.localProtocolOptions!.getArtifactsDir!();
			if (!artifactsDirectory) throw new Error("Council test harness has no artifacts directory");
			const localRoot = path.join(artifactsDirectory, "local");
			if (phase === "planner") {
				await fs.rm(path.join(localRoot, "council-run-one-correctness-r1.json"), { force: true });
			}
			if (phase !== "round") {
				await fs.rm(path.join(localRoot, "council-run-one-round1.md"), { force: true });
				await fs.rm(harness.dispatch.publicationTarget.absolutePath, { force: true });
			}
			plannerCalls = 0;
			memberCalls = 0;
			harness.prompts.length = 0;

			const resumed = new CouncilCoordinator(harness.host);
			await resumed.resume("run-one");
			await resumed.completion;

			expect(plannerCalls).toBe(0);
			expect(memberCalls).toBe(phase === "planner" ? 1 : 0);
			expect(harness.prompts).toHaveLength(phase === "round" ? 0 : 1);
			expect(resumed.snapshot?.state).toBe("completed");
		},
	);

	it("keeps strict-invalid planner output terminal even when strict finalization sets exit code one", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, {}, { exitCode: 1 })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure?.phase).toBe("planner-schema");
		await expect(coordinator.resume("run-one")).rejects.toThrow("cannot be resumed");
	});

	it("single-flights concurrent starts before preflight or storage allocation", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const first = coordinator.start(harness.dispatch.task);
		const competing = coordinator.start(harness.dispatch.task);
		await expect(competing).rejects.toThrow("still settling");
		await first;
		await coordinator.completion;

		expect(preflight.preflightCouncilDispatch).toHaveBeenCalledTimes(1);
		expect(run.mock.calls.filter(([request]) => request.agent === "council-planner")).toHaveLength(1);
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("fails an escape-heavy planner basis before dispatching any member", async () => {
		const harness = makeHarness(1, ["correctness", "architecture"]);
		installDispatch(harness);
		let memberCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent !== "council-planner") {
				memberCalls++;
				return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
			}
			return structuredResult(request, {
				plan: `${PLAN}\n${`"\\`.repeat(25_000)}`,
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(memberCalls).toBe(0);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.reason).toContain("fixed context exceeds");
	});

	it("checkpoints the planner before concurrent pinned and confined members, then publishes once", async () => {
		const harness = makeHarness();
		installDispatch(harness);
		const calls: StructuredSubagentRequest[] = [];
		let activeMembers = 0;
		let maximumActiveMembers = 0;
		const allMembersStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			calls.push(request);
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			activeMembers++;
			maximumActiveMembers = Math.max(maximumActiveMembers, activeMembers);
			if (activeMembers === harness.dispatch.members.length) allMembersStarted.resolve();
			await allMembersStarted.promise;
			activeMembers--;
			return structuredResult(request, {
				readiness: "revise",
				findings: [
					{
						classification: "must-fix",
						severity: "high",
						confidence: "high",
						evidence: [
							{ path: "src/example.ts", observation: "The existing path establishes the required invariant." },
						],
						impact: "Incorrect behavior",
						required: true,
						recommendation: "Use the established path",
						rejectedAssumptions: [],
						verification: ["Exercise the path"],
					},
				],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure).toBeUndefined();
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(calls[0]?.agent).toBe("council-planner");
		expect(maximumActiveMembers).toBe(2);
		for (const request of calls) {
			expect(request.pinModel).toBe(true);
			expect(request.identity?.inspectOnly).toBe(true);
			expect(request.restrictToolNames).toBe(true);
			expect(request.skills).toEqual([]);
			expect(request.rules).toEqual([]);
			expect(request.autoloadSkills).toEqual([]);
			expect(request.signal).toBeDefined();
		}
		const draftCheckpoint = harness.journal.findIndex(entry => entry.planVersions.length === 1);
		const memberCheckpoint = harness.journal.findIndex(entry =>
			entry.rounds[0]?.members.some(member => member.attempts > 0),
		);
		expect(draftCheckpoint).toBeGreaterThanOrEqual(0);
		expect(memberCheckpoint).toBeGreaterThan(draftCheckpoint);
		expect(coordinator.snapshot?.rounds[0]?.members.map(member => member.findingIds)).toEqual([["A1"], ["B1"]]);
		expect(harness.summaries).toHaveLength(1);
	});

	it("degrades under oversized aggregate member errors without exceeding adjudication injection bounds", async () => {
		const roles = Array.from({ length: 80 }, (_, index) => `reviewer${index}`);
		const harness = makeHarness(1, roles);
		installDispatch(harness);
		const oversizedReason = `provider failure ${"x".repeat(2_000)}`;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			throw new Error(oversizedReason);
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed-degraded");
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]!.length).toBeLessThanOrEqual(COUNCIL_ADJUDICATION_INJECTION_CAP);
		expect(harness.prompts[0]).toContain("Member reviewer0 (slot 1) failed:");
		expect(harness.prompts[0]).not.toContain(oversizedReason);
	});

	it("retries one malformed member payload and keeps deterministic global IDs across two rounds", async () => {
		const harness = makeHarness(2, ["correctness"]);
		installDispatch(harness);
		let plannerCalls = 0;
		let malformedReturned = false;
		const memberAssignments: string[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				plannerCalls++;
				return structuredResult(request, {
					plan: PLAN,
					assumptions: ["one"],
					blockers: [],
					evidenceVersion: "1.0.0",
				});
			}
			memberAssignments.push(request.assignment);
			if (!malformedReturned) {
				malformedReturned = true;
				return structuredResult(request, {}, { exitCode: 1 });
			}
			return structuredResult(request, {
				readiness: "ready",
				findings: [
					{
						classification: "improvement",
						severity: "low",
						confidence: "high",
						evidence: [
							{ path: "src/example.ts", observation: "The plan should name the established invariant." },
						],
						impact: "Clarity",
						required: false,
						recommendation: "Name the invariant",
						rejectedAssumptions: [],
						verification: ["Read the final plan"],
					},
				],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts.every(value => value.length <= COUNCIL_ADJUDICATION_INJECTION_CAP)).toBe(true);
		expect(
			harness.prompts.every(value => value.includes(`# Canonical repository root\n${harness.dispatch.repoRoot}`)),
		).toBe(true);
		expect(harness.prompts[1]).not.toContain('"reason":"Supported"');
		expect(plannerCalls).toBe(1);

		expect(memberAssignments).toHaveLength(3);
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.attempts).toBe(2);
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.findingIds).toEqual(["A1"]);
		expect(coordinator.snapshot?.rounds[1]?.members[0]?.findingIds).toEqual(["B1"]);
		expect(memberAssignments.at(-1)).toContain(PLAN);
		expect(harness.prompts).toHaveLength(2);
		expect(harness.summaries).toHaveLength(1);
	});
	it("does not spend the schema retry on a provider failure with partial output", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		let memberCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberCalls++;
			const failed = structuredResult(request, { partial: "provider text" }, { exitCode: 1 });
			failed.result.error = "provider unavailable";
			failed.result.structuredOutput = {
				source: "caller",
				mode: "strict",
				status: "unavailable",
				data: { partial: "provider text" },
				error: "provider unavailable",
			};
			return failed;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(memberCalls).toBe(1);
		expect(coordinator.snapshot?.rounds[0]?.members[0]).toMatchObject({
			attempts: 1,
			status: "failed",
			failureReason: "provider unavailable",
		});
		expect(coordinator.snapshot?.state).toBe("completed-degraded");
	});

	it("rejects a round-two duplicate target that was itself a prior duplicate", async () => {
		const harness = makeHarness(2, ["correctness"]);
		installDispatch(harness);
		let memberRound = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberRound++;
			const finding = {
				classification: "must-fix",
				severity: "high",
				confidence: "high",
				evidence: [
					{ path: "src/example.ts", observation: "The implementation violates the established invariant." },
				],
				impact: "Incorrect behavior",
				required: true,
				recommendation: "Restore the invariant",
				rejectedAssumptions: [],
				verification: ["Exercise the path"],
			};
			return structuredResult(request, {
				readiness: "revise",
				findings: memberRound === 1 ? [finding, { ...finding, impact: "Duplicate impact" }] : [finding],
				strengths: [],
				missingContext: [],
			});
		});
		let roundOneAccepted = false;
		const rejectionMessages: string[] = [];
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			options?.onPromptStart?.();
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const payload = roundOneAccepted
				? {
						plan: PLAN,
						dispositions: [
							{
								id: "B1",
								disposition: "duplicate",
								reason: "Same root cause.",
								step: "Approach 1",
								duplicateOf: "A1",
							},
						],
					}
				: {
						plan: PLAN,
						dispositions: [
							{
								id: "A1",
								disposition: "duplicate",
								reason: "Same root cause.",
								step: "Approach 1",
								duplicateOf: "A2",
							},
							{ id: "A2", disposition: "accepted", reason: "Supported", step: "Approach 1" },
						],
					};
			const result = await active(JSON.stringify(payload));
			if (result.isError) rejectionMessages.push(JSON.stringify(result.content));
			else roundOneAccepted = true;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(roundOneAccepted).toBeTrue();
		expect(rejectionMessages).toEqual([
			expect.stringContaining("unknown duplicate target A1"),
			expect.stringContaining("unknown duplicate target A1"),
		]);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();
	});
	it("resumes succeeded artifacts, reruns cancelled slots, and preserves failed slots", async () => {
		const harness = makeHarness(1, ["success", "failed", "cancelled"]);
		installDispatch(harness);
		const calls = new Map<string, number>();
		let resuming = false;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				calls.set("planner", (calls.get("planner") ?? 0) + 1);
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			const role = String(request.model).slice("member/".length);
			calls.set(role, (calls.get(role) ?? 0) + 1);
			if (role === "failed") {
				const failed = structuredResult(request, undefined, { exitCode: 1 });
				failed.result.structuredOutput = { source: "caller", mode: "strict", status: "unavailable" };
				return failed;
			}
			if (role === "cancelled" && !resuming) {
				const pending = Promise.withResolvers<StructuredSubagentResult>();
				const abort = () => {
					const error = new Error("cancelled member");
					error.name = "AbortError";
					pending.reject(error);
				};
				request.signal?.addEventListener("abort", abort, { once: true });
				return pending.promise;
			}
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);
		const terminalSlots = Promise.withResolvers<void>();
		const unsubscribe = coordinator.subscribe(snapshot => {
			const members = snapshot.manifest.rounds[0]?.members;
			if (
				members?.[0]?.status === "succeeded" &&
				members[1]?.status === "failed" &&
				members[2]?.status === "running"
			) {
				terminalSlots.resolve();
			}
		});
		await coordinator.start(harness.dispatch.task);
		await terminalSlots.promise;
		const interrupted = await coordinator.cancel();
		unsubscribe();
		expect(interrupted.rounds[0]?.members.map(member => member.status)).toEqual(["succeeded", "failed", "cancelled"]);

		resuming = true;
		const resumed = coordinator.resume("run-one");
		const competingResume = coordinator.resume("run-one");
		await expect(competingResume).rejects.toThrow("still settling");
		await resumed;
		await coordinator.completion;

		expect(calls.get("planner")).toBe(1);
		expect(calls.get("success")).toBe(1);
		expect(calls.get("failed")).toBe(1);
		expect(calls.get("cancelled")).toBe(2);
		expect(coordinator.snapshot?.state).toBe("completed-degraded");
	});

	it("aborts an in-flight child before a deferred cancelling checkpoint resolves", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const checkpointPending = Promise.withResolvers<CouncilManifest>();
		let deferredCheckpoint: CouncilManifest | undefined;
		let deferCancellingCheckpoint = false;
		const checkpoint = CouncilStorage.prototype.checkpoint;
		spyOn(CouncilStorage.prototype, "checkpoint").mockImplementation(function (
			this: CouncilStorage,
			manifest: CouncilManifest,
		) {
			if (deferCancellingCheckpoint && manifest.state === "cancelling") {
				deferredCheckpoint = structuredClone(manifest);
				return checkpointPending.promise;
			}
			return checkpoint.call(this, manifest);
		});
		const memberStarted = Promise.withResolvers<void>();
		const childAborted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			const pending = Promise.withResolvers<StructuredSubagentResult>();
			request.signal?.addEventListener(
				"abort",
				() => {
					childAborted.resolve();
					const error = new Error("cancelled member");
					error.name = "AbortError";
					pending.reject(error);
				},
				{ once: true },
			);
			return pending.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		deferCancellingCheckpoint = true;

		const cancellation = coordinator.cancel();
		await childAborted.promise;
		expect(coordinator.snapshot?.state).toBe("cancelling");
		if (!deferredCheckpoint) throw new Error("Expected deferred cancelling checkpoint");
		checkpointPending.resolve(deferredCheckpoint);
		const cancelled = await cancellation;

		expect(cancelled.state).toBe("interrupted");
	});

	it("clears timed-out reviewer telemetry before emitting the terminal interrupted snapshot", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		const releaseMember = Promise.withResolvers<StructuredSubagentResult>();
		let memberRequest: StructuredSubagentRequest | undefined;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberRequest = request;
			request.onProgress?.({
				index: request.index ?? 1,
				id: request.identity?.label ?? "reviewer",
				agent: "council-member",
				agentSource: "bundled",
				status: "running",
				task: request.assignment,
				assignment: request.assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 10,
				cost: 0,
				durationMs: 1,
			});
			memberStarted.resolve();
			return releaseMember.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		expect(coordinator.coordinatorSnapshot?.members).toHaveLength(1);

		const cancellation = coordinator.cancel();
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_001);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		const cancelled = await cancellation;

		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.manifest.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
		expect(coordinator.coordinatorSnapshot?.manifest.rounds[0]?.members[0]?.status).toBe("interrupted");

		if (!memberRequest) throw new Error("Expected member request");
		releaseMember.resolve(
			structuredResult(memberRequest, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			}),
		);
		await coordinator.completion;
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
	});

	it("checkpoints returned child usage before settling cancellation", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			const pending = Promise.withResolvers<StructuredSubagentResult>();
			request.signal?.addEventListener(
				"abort",
				() => {
					const result = structuredResult(request, undefined, { exitCode: 1 });
					result.result.aborted = true;
					result.result.tokens = 37;
					result.result.requests = 2;
					pending.resolve(result);
				},
				{ once: true },
			);
			return pending.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;

		const cancelled = await coordinator.cancel();

		expect(cancelled.state).toBe("interrupted");
		expect(cancelled.usage.requests).toBe(3);
		expect(cancelled.usage.tokens).toBe(47);
	});
	it("keeps a validated adjudication when the provider fails after the tool write", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.adjudicationState.afterAcceptedError = new Error("provider failed after accepted tool result");
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(harness.prompts).toHaveLength(1);
		expect(coordinator.snapshot?.published).toBeDefined();
	});

	it("rejects adjudication payloads until the Council Main turn owns the prompt", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const idleEntered = Promise.withResolvers<void>();
		const releaseIdle = Promise.withResolvers<void>();
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.host.session.waitForIdle = mock(async () => {
			idleEntered.resolve();
			await releaseIdle.promise;
		});
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await idleEntered.promise;
		const installed = harness.toolSession.peekCouncilHandler?.();
		if (!installed) throw new Error("Expected installed Council handler");
		const payload = JSON.stringify({ plan: PLAN, dispositions: [] });

		const beforeOwnership = await installed(payload);
		expect(beforeOwnership.isError).toBeTrue();
		releaseIdle.resolve();
		await promptEntered.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(true);
		const afterOwnership = await installed(payload);
		expect(afterOwnership.isError).not.toBeTrue();
		releasePrompt.resolve();
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("does not claim or abort an unrelated turn that wins the idle-to-prompt race", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const busyAttempted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		harness.adjudicationState.busyFailures = 1;
		harness.adjudicationState.busyPending = releaseBusy.promise;
		harness.adjudicationState.onBusyAttempt = busyAttempted.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await busyAttempted.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(false);

		const cancellation = coordinator.cancel();
		releaseBusy.resolve();
		const cancelled = await cancellation;

		expect(harness.host.session.abort).not.toHaveBeenCalled();
		expect(cancelled.state).toBe("interrupted");
	});

	it("aborts an owned Main turn reserved before its custom message is appended", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		harness.adjudicationState.onAbort = releasePrompt.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(true);

		const cancelled = await coordinator.cancel();

		expect(harness.host.session.abort).toHaveBeenCalledTimes(1);
		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.snapshot?.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(false);
	});

	it("rejects a session transition when an owned Main turn misses the cancellation deadline", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;

		const transition = coordinator.cancelForSessionTransition();
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_001);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		await expect(transition).rejects.toThrow("Council cancellation timed out");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();

		releasePrompt.resolve();
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("interrupted");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();
	});

	it("keeps an interrupted snapshot immutable when a non-cooperative Main turn returns late", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const cancelling = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		const unsubscribe = coordinator.subscribe(snapshot => {
			if (snapshot.manifest.state === "cancelling") cancelling.resolve();
		});
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;

		const cancellation = coordinator.cancel();
		await cancelling.promise;
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_000);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		const cancelled = await cancellation;
		const terminalSnapshot = structuredClone(coordinator.snapshot);
		const terminalJournalLength = harness.journal.length;
		harness.host.sessionManager.getSessionId = () => "session-two";
		const nextSessionHandler: CouncilAdjudicationHandler = async () => ({
			content: [{ type: "text", text: "next session" }],
		});
		harness.toolSession.setCouncilHandler?.(nextSessionHandler);

		releasePrompt.resolve();
		await coordinator.completion;
		unsubscribe();

		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.snapshot).toEqual(terminalSnapshot);
		expect(harness.journal).toHaveLength(terminalJournalLength);
		expect(coordinator.snapshot?.planVersions.map(version => version.kind)).toEqual(["draft"]);
		expect(coordinator.snapshot?.published).toBeUndefined();
		expect(harness.toolSession.peekCouncilHandler?.()).toBe(nextSessionHandler);
		expect(harness.summaries).toHaveLength(0);
	});

	it("does not duplicate a confirmed queued summary when sendCustomMessage reports no started turn", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(1);
		await Promise.all([coordinator.status(), coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(1);
	});

	it("omits a summary whose async delivery crosses into another session", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const summaryStarted = Promise.withResolvers<void>();
		const releaseSummary = Promise.withResolvers<void>();
		harness.summaryState.onAttempt = summaryStarted.resolve;
		harness.summaryState.pending = releaseSummary.promise;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await summaryStarted.promise;

		harness.host.sessionManager.getSessionId = () => "session-two";
		releaseSummary.resolve();

		await coordinator.completion;
		expect(harness.summaries).toHaveLength(0);
		expect(harness.summaryState.attempts).toBe(1);

		harness.summaryState.pending = undefined;
		harness.summaryState.onAttempt = undefined;
		harness.host.sessionManager.getSessionId = () => "session-one";
		await Promise.all([coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});
	it("retries an unconfirmed terminal summary without duplicating the confirmed delivery", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.declines = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(0);
		await Promise.all([coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});

	it("retries a failed terminal summary through concurrent status calls without duplicating success", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.failures = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaries).toHaveLength(0);
		await Promise.all([coordinator.status(), coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});

	it("blocks a new run until terminal summary delivery finishes", async () => {
		const harness = makeHarness(1, ["correctness"]);
		let run = 0;
		harness.host.runId = () => `run-${++run}`;
		const summaryAttempted = Promise.withResolvers<void>();
		const releaseSummary = Promise.withResolvers<void>();
		harness.summaryState.pending = releaseSummary.promise;
		harness.summaryState.onAttempt = summaryAttempted.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);

		const coordinator = getCouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await summaryAttempted.promise;
		expect(coordinator.snapshot?.state).toBe("completed");
		const reboundDuringSummary = getCouncilCoordinator({
			...harness.host,
			session: { ...harness.host.session } as typeof harness.host.session,
		});
		expect(reboundDuringSummary).toBe(coordinator);

		await expect(coordinator.start(harness.dispatch.task)).rejects.toThrow("still settling");

		releaseSummary.resolve();
		await coordinator.completion;
		harness.summaryState.pending = undefined;
		harness.summaryState.onAttempt = undefined;
		const second = await coordinator.start(harness.dispatch.task);
		expect(second.runId).toBe("run-2");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
	});
	it("replaces an inactive same-ID coordinator when restored session surfaces change", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.failures = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const original = getCouncilCoordinator(harness.host);
		await original.start(harness.dispatch.task);
		await original.completion;
		expect(harness.summaries).toHaveLength(0);

		const restoredSummaries: unknown[] = [];
		const restoredSession = {
			...harness.host.session,
			sendCustomMessage: mock(async (message: unknown, options?: { deliveryReceipt?: { delivered: boolean } }) => {
				restoredSummaries.push(message);
				if (options?.deliveryReceipt) options.deliveryReceipt.delivered = true;
				return false;
			}),
		} as unknown as typeof harness.host.session;
		const replacement = getCouncilCoordinator({ ...harness.host, session: restoredSession });
		expect(replacement).not.toBe(original);
		const status = await replacement.status();
		const snapshots: CouncilCoordinatorSnapshot[] = [];
		const unsubscribe = replacement.subscribe(snapshot => snapshots.push(snapshot));

		expect(status?.state).toBe("completed");
		expect(restoredSummaries).toHaveLength(1);
		expect(snapshots[0]?.manifest.runId).toBe("run-one");
		unsubscribe();
	});

	it("terminalizes an occupied promised path before rerunning an interrupted reviewer", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		let resuming = false;
		let childCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			childCalls++;
			if (resuming) throw new Error("resume must not dispatch a child");
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			return await new Promise<StructuredSubagentResult>((_resolve, reject) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						const error = new Error("cancelled reviewer");
						error.name = "AbortError";
						reject(error);
					},
					{ once: true },
				);
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		const interrupted = await coordinator.cancel();
		expect(interrupted.planVersions.map(version => version.kind)).toEqual(["draft"]);
		const target = path.join(interrupted.repoRoot, ...interrupted.outputPath.split("/"));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "external collision");

		resuming = true;
		await expect(coordinator.resume(interrupted.runId)).rejects.toThrow("publication target already exists");

		expect(childCalls).toBe(2);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.code).toBe("EEXIST");
	});

	it("resumes against its occupied promised path and terminalizes the collision without rerunning children", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const realPublish = publication.publishCouncilPlan;
		const publicationEntered = Promise.withResolvers<void>();
		let firstPublication = true;
		const preflightSpy = spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
			if (!firstPublication) return realPublish(options);
			firstPublication = false;
			publicationEntered.resolve();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
			throw new Error("unreachable");
		});
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await publicationEntered.promise;
		const interrupted = await coordinator.cancel();
		expect(interrupted.state).toBe("interrupted");
		const childCalls = run.mock.calls.length;
		const promisedPath = interrupted.outputPath;
		const absolutePromisedPath = path.join(interrupted.repoRoot, ...promisedPath.split("/"));
		await fs.mkdir(path.dirname(absolutePromisedPath), { recursive: true });
		await Bun.write(absolutePromisedPath, "unrelated occupant");

		await expect(coordinator.resume(interrupted.runId)).rejects.toThrow("publication target already exists");

		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.code).toBe("EEXIST");
		expect(coordinator.snapshot?.outputPath).toBe(promisedPath);
		expect(run).toHaveBeenCalledTimes(childCalls);
		expect(preflightSpy.mock.calls[1]?.[2]).toEqual({ promisedOutputPath: promisedPath });
	});

	it("preserves a final trailing newline through publication crash identity recovery", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const trailingPlan = `${PLAN}\n`;
		harness.adjudicationState.plan = trailingPlan;
		spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		const publishedContents: string[] = [];
		let crashAfterPublish = true;
		spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
			publishedContents.push(options.content);
			const target = path.join(options.repoRoot, ...options.outputPath.split("/"));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await Bun.write(target, options.content);
			if (crashAfterPublish) {
				crashAfterPublish = false;
				throw new Error("simulated crash after atomic publication");
			}
			return {
				path: options.outputPath,
				sha256: sha256CouncilContent(options.content),
				bytes: Buffer.byteLength(options.content),
				publishedAt: "2026-08-05T00:00:00.000Z",
				idempotent: true,
			};
		});
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(await Bun.file(harness.dispatch.publicationTarget.absolutePath).text()).toBe(trailingPlan);

		harness.dispatch.publicationTarget = {
			...harness.dispatch.publicationTarget,
			slug: "different-fresh-target",
			relativePath: "plans/different-fresh-target.md",
			absolutePath: path.join(harness.dispatch.repoRoot, "plans", "different-fresh-target.md"),
		};
		await coordinator.resume("run-one");
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(publishedContents).toEqual([trailingPlan, trailingPlan]);
		expect(coordinator.snapshot?.published?.sha256).toBe(sha256CouncilContent(trailingPlan));
	});

	it("keys shared coordinators by session and immediately hydrates subscribers with cloned snapshots", async () => {
		const harness = makeHarness();
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = getCouncilCoordinator(harness.host);
		expect(getCouncilCoordinator({ ...harness.host, sessionManager: harness.host.sessionManager })).toBe(coordinator);
		await coordinator.start(harness.dispatch.task);
		const snapshots: CouncilCoordinatorSnapshot[] = [];
		const unsubscribe = coordinator.subscribe(snapshot => snapshots.push(snapshot));
		expect(snapshots).toHaveLength(1);
		snapshots[0]!.manifest.task = "mutated listener copy";
		expect(coordinator.snapshot?.task).toBe(harness.dispatch.task);
		unsubscribe();
		await coordinator.completion;
		expect(snapshots).toHaveLength(1);
	});
});
