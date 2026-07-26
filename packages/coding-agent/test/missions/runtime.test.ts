import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	MISSION_STATE_CUSTOM_TYPE,
	type MissionFeature,
	type MissionHandoff,
	MissionRuntime,
	MissionRuntimeError,
	type MissionRuntimeHost,
	type MissionState,
} from "../../src/missions";
import { MissionWorkspaceManager } from "../../src/missions/workspace";
import type { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import type { SessionEntry } from "../../src/session/session-entries";
import type { ToolSession } from "../../src/tools";

function state(overrides: Partial<MissionState> = {}): MissionState {
	const now = 1;
	return {
		version: 1,
		id: "mission-test",
		ownerSessionId: "owner",
		revision: 0,
		goal: "Ship the mission runtime",
		autoAccept: false,
		status: "running",
		runbook: { setup: [], services: [], userTests: [] },
		milestones: [],
		features: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function implementation(id: string, preconditions: string[] = []): MissionFeature {
	return {
		id,
		description: id,
		milestoneId: "milestone",
		preconditions,
		expectedBehavior: ["works"],
		kind: "implementation",
		status: "pending",
		workerSessionIds: [],
		retryBudgetUsed: 0,
	};
}

function validation(id: string): MissionFeature {
	return {
		...implementation(id),
		kind: "validation",
		validator: "scrutiny",
	};
}

function validatorFailure(): MissionHandoff {
	return {
		kind: "validation",
		role: "scrutiny",
		verdict: "fail",
		summary: "needs remediation",
		checks: [],
		issues: [],
	};
}

function runtime(
	initial: MissionState | null = null,
	failPersistence = false,
	released: string[] = [],
): MissionRuntime {
	const entries: SessionEntry[] = initial
		? [
				{
					type: "custom",
					id: "state",
					parentId: null,
					timestamp: "1",
					customType: MISSION_STATE_CUSTOM_TYPE,
					data: initial,
				},
			]
		: [];
	const sessionManager = {
		appendEntriesAtomically: async <T>(append: () => T): Promise<T> => {
			if (failPersistence) throw new Error("disk full");
			return append();
		},
		appendCustomEntry: (customType: string, data?: unknown) => {
			const id = `${entries.length}`;
			entries.push({ type: "custom", id, parentId: null, timestamp: "1", customType, data });
			return id;
		},
		appendModeChange: () => `${entries.length}`,
		getEntries: () => entries,
		flush: async () => undefined,
	};
	const host: MissionRuntimeHost = {
		ownerSessionId: () => "owner",
		cwd: () => process.cwd(),
		sessionManager: sessionManager satisfies MissionRuntimeHost["sessionManager"],
		emitUpdated: () => undefined,
		emitProgress: () => undefined,
		sendHiddenMessage: async () => undefined,
		getEnabledToolNames: () => [],
		setActiveToolsByName: async () => undefined,
		parentApprovalDelegate: () => undefined,
		resolveChildModels: async () => undefined,
		assertSkillsExist: () => undefined,
		getToolSession: () => ({}) as ToolSession,
		isPlanModeActive: () => false,
		isGoalModeActive: () => false,
		isVibeModeActive: () => false,
		registerPersistedReviver: () => undefined,
		agentLifecycle: () =>
			({
				release: async (workerSessionId: string) => {
					released.push(workerSessionId);
					return true;
				},
			}) as AgentLifecycleManager,
		now: () => 1,
	};
	return new MissionRuntime(host);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MissionRuntime", () => {
	test("rejects a blank goal before any mission state is persisted", async () => {
		const mission = runtime();
		await expect(mission.start(" \t ")).rejects.toBeInstanceOf(MissionRuntimeError);
		expect(mission.snapshot()).toBeNull();
	});

	test("rejects remediation dependency cycles before releasing validator workspaces", async () => {
		const failed = { ...validation("validate"), status: "in_progress" as const };
		const mission = runtime(
			state({
				status: "orchestrator_turn",
				milestones: [
					{
						id: "milestone",
						description: "M",
						featureIds: ["validate"],
						validators: ["scrutiny"],
						kind: "planned",
					},
				],
				features: [failed],
				pendingHandoff: validatorFailure(),
			}),
		);
		await mission.restore();

		await expect(
			mission.revisePending({
				addFeatures: [
					{ id: "repair-a", description: "a", preconditions: ["repair-b"], expectedBehavior: ["a"] },
					{ id: "repair-b", description: "b", preconditions: ["repair-a"], expectedBehavior: ["b"] },
				],
			}),
		).rejects.toThrow("cycle");
		expect(mission.snapshot()?.status).toBe("orchestrator_turn");
	});

	test("recovers an interrupted validator without redispatching it", async () => {
		const interrupted = {
			...validation("validate"),
			status: "in_progress" as const,
			currentWorkerSessionId: "worker",
		};
		const mission = runtime(
			state({
				milestones: [
					{
						id: "milestone",
						description: "M",
						featureIds: ["validate"],
						validators: ["scrutiny"],
						kind: "planned",
					},
				],
				features: [interrupted],
				activeRun: { featureId: "validate", workerSessionId: "worker", turn: 1 },
			}),
		);
		const restored = await mission.restore();
		expect(restored).toMatchObject({ status: "paused", pauseReason: "workspace_conflict" });
		expect(restored?.features[0]).toMatchObject({ status: "pending", nextRunIntent: { mode: "initial" } });
	});

	test("pause and cancel form dispatch barriers", async () => {
		const mission = runtime();
		await mission.start("goal");
		await mission.pause("user_requested");
		await expect(mission.runNext()).rejects.toThrow('status "running"');
		const cancelled = await mission.cancel();
		expect(cancelled.status).toBe("cancelled");
		expect(await mission.runNext()).toBeNull();
	});

	test("moves a failed worker handoff into an explicit retry transition", async () => {
		const worker = { ...implementation("worker"), status: "in_progress" as const, currentWorkerSessionId: "child" };
		const handoff: MissionHandoff = {
			kind: "implementation",
			outcome: "partial",
			summary: "unfinished",
			implementation: [],
			remaining: ["finish"],
			verification: { commands: [], interactiveChecks: [] },
			tests: { added: [], coverageNotes: [] },
			issues: [],
			skillDeviations: [],
			commits: [],
		};
		const mission = runtime(state({ status: "orchestrator_turn", features: [worker], pendingHandoff: handoff }));
		await mission.restore();
		const retried = await mission.resolveHandoff({ decision: "retry_same" });
		expect(retried).toMatchObject({ status: "running", pendingHandoff: undefined });
		expect(retried.features[0]).toMatchObject({ status: "pending", nextRunIntent: { mode: "follow_up" } });
	});

	test("restarts after a cleaned validator workspace without bypassing ordinary resume", async () => {
		const workspace = {
			id: "validator-workspace",
			ownerSessionId: "owner",
			repoRoot: "/repo",
			path: "/repo-validator",
			featureId: "validate",
			phase: "ready" as const,
			kind: "validator" as const,
			head: "abc123",
		};
		const validator = {
			...validation("validate"),
			status: "completed" as const,
			workspace,
			validatedHead: workspace.head,
		};
		const mission = runtime(
			state({
				status: "paused",
				pauseReason: "validator_workspace_dirty",
				milestones: [
					{
						id: "milestone",
						description: "M",
						featureIds: ["validate"],
						validators: ["scrutiny"],
						kind: "planned",
					},
				],
				features: [validator],
			}),
		);
		await mission.restore();
		await expect(mission.resume()).rejects.toThrow("restart the mission");
		const release = vi.spyOn(MissionWorkspaceManager.prototype, "releaseIfEmpty").mockResolvedValue(true);

		const resumed = await mission.resume({ restartWorker: true });

		expect(release).toHaveBeenCalledWith(workspace);
		expect(resumed).toMatchObject({ status: "running", pauseReason: undefined });
	});

	test("a fresh restart after a user pause releases and replaces the active worker", async () => {
		const released: string[] = [];
		const active = {
			...implementation("feature"),
			status: "in_progress" as const,
			currentWorkerSessionId: "worker",
			workerSessionIds: ["worker"],
		};
		const mission = runtime(
			state({
				status: "paused",
				pauseReason: "user_requested",
				features: [active],
			}),
			false,
			released,
		);
		await mission.restore();

		const resumed = await mission.resume({ restartWorker: true, messageToWorker: "try cleanly" });

		expect(released).toEqual(["worker"]);
		expect(resumed.features[0]).toMatchObject({
			status: "pending",
			currentWorkerSessionId: undefined,
			nextRunIntent: { mode: "fresh", messageToWorker: "try cleanly" },
		});
	});

	test("keeps prior state authoritative when persistence fails", async () => {
		const mission = runtime(null, true);
		await expect(mission.start("goal")).rejects.toThrow("disk full");
		expect(mission.snapshot()).toBeNull();
	});
});
