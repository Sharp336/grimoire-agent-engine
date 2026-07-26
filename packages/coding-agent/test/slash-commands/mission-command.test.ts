import { describe, expect, it, vi } from "bun:test";
import { MISSION_BUSY, MissionRuntimeError } from "@oh-my-pi/pi-coding-agent/missions/runtime";
import type {
	MissionFeature,
	MissionHandoff,
	MissionHandoffDecision,
	MissionPauseReason,
	MissionState,
} from "@oh-my-pi/pi-coding-agent/missions/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function feature(id: string, status: MissionFeature["status"]): MissionFeature {
	return {
		id,
		description: `${id} work`,
		milestoneId: "m1",
		preconditions: [],
		expectedBehavior: [],
		kind: "implementation",
		status,
		workerSessionIds: [],
		retryBudgetUsed: 0,
	};
}

function missionState(overrides: Partial<MissionState> = {}): MissionState {
	return {
		version: 1,
		id: "mission-1",
		ownerSessionId: "session-1",
		revision: 3,
		goal: "Ship the widget",
		autoAccept: false,
		status: "running",
		runbook: { setup: [], services: [], userTests: [] },
		milestones: [],
		features: [],
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

const PENDING_HANDOFF: MissionHandoff = {
	kind: "validation",
	role: "scrutiny",
	verdict: "fail",
	summary: "needs another pass",
	checks: [],
	issues: [],
};

/** A verb outcome: the state the runtime returns, or the failure it raises. */
type MissionOutcome = MissionState | Error;

function settle(outcome: MissionOutcome | undefined, fallback: MissionState): MissionState {
	if (outcome instanceof Error) throw outcome;
	return outcome ?? fallback;
}

interface MissionOutcomes {
	snapshot?: MissionState | null;
	busy?: boolean;
	start?: MissionOutcome;
	accept?: MissionOutcome;
	pause?: MissionOutcome;
	resume?: MissionOutcome;
	cancel?: MissionOutcome;
	resolveHandoff?: MissionOutcome;
}

function missionDouble(outcomes: MissionOutcomes = {}) {
	const fallback = missionState();
	return {
		isBusy: vi.fn(() => outcomes.busy ?? false),
		snapshot: vi.fn((): MissionState | null => outcomes.snapshot ?? null),
		start: vi.fn(async (_goal: string): Promise<MissionState> => settle(outcomes.start, fallback)),
		accept: vi.fn(async (): Promise<MissionState> => settle(outcomes.accept, fallback)),
		pause: vi.fn(async (_reason: MissionPauseReason): Promise<MissionState> => settle(outcomes.pause, fallback)),
		resume: vi.fn(
			async (_input?: { restartWorker?: boolean; messageToWorker?: string }): Promise<MissionState> =>
				settle(outcomes.resume, fallback),
		),
		cancel: vi.fn(async (): Promise<MissionState> => settle(outcomes.cancel, fallback)),
		resolveHandoff: vi.fn(
			async (_input: { decision: MissionHandoffDecision; messageToWorker?: string }): Promise<MissionState> =>
				settle(outcomes.resolveHandoff, fallback),
		),
	};
}

type MissionDouble = ReturnType<typeof missionDouble>;

/**
 * `AgentSession` and the TUI editor are classes with private state, so no plain
 * object satisfies their declared types. Both dispatchers only touch the members
 * built here, so each host double takes exactly one documented assertion.
 */
function acpHost(outcomes: MissionOutcomes = {}) {
	const mission = missionDouble(outcomes);
	const output = vi.fn(async (_text: string): Promise<void> => {});
	const runtime = { session: { missionRuntime: mission }, output } as unknown as SlashCommandRuntime;
	return { mission, output, runtime };
}

function tuiHost(outcomes: MissionOutcomes = {}) {
	const mission = missionDouble(outcomes);
	const setText = vi.fn((_text: string): void => {});
	const showStatus = vi.fn((_text: string): void => {});
	const showError = vi.fn((_text: string): void => {});
	const ctx = {
		editor: { setText },
		session: { missionRuntime: mission },
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { mission, setText, showStatus, showError, runtime: { ctx } };
}

function acpText(host: ReturnType<typeof acpHost>): string | undefined {
	return host.output.mock.calls[0]?.[0];
}

function callArgs(mission: MissionDouble): Record<string, unknown[][]> {
	return {
		snapshot: mission.snapshot.mock.calls,
		start: mission.start.mock.calls,
		accept: mission.accept.mock.calls,
		pause: mission.pause.mock.calls,
		resume: mission.resume.mock.calls,
		cancel: mission.cancel.mock.calls,
		resolveHandoff: mission.resolveHandoff.mock.calls,
	};
}

describe("/mission slash command", () => {
	it("is advertised to ACP clients with the verb hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "mission");

		expect(advertised).toBeDefined();
		expect(advertised?.input).toEqual({ hint: "[goal|status|accept|pause|resume|restart|cancel]" });
	});

	it("reports no active mission for a session that never started one", async () => {
		const acp = acpHost({ snapshot: null });
		const tui = tuiHost({ snapshot: null });

		expect(await executeAcpBuiltinSlashCommand("/mission status", acp.runtime)).toEqual({ consumed: true });
		expect(await executeBuiltinSlashCommand("/mission status", tui.runtime)).toBe(true);

		expect(acpText(acp)).toBe("No active mission.");
		expect(tui.showStatus).toHaveBeenCalledWith("No active mission.");
		expect(tui.setText).toHaveBeenCalledWith("");
		expect(acp.mission.start).not.toHaveBeenCalled();
		expect(tui.mission.start).not.toHaveBeenCalled();
	});

	it("renders the pause reason, active feature, and completion count in the status summary", async () => {
		const snapshot = missionState({
			status: "paused",
			pauseReason: "worker_inactive",
			features: [feature("f1", "completed"), feature("f2", "in_progress"), feature("f3", "pending")],
		});
		const acp = acpHost({ snapshot });

		await executeAcpBuiltinSlashCommand("/mission status", acp.runtime);

		expect(acpText(acp)).toBe(
			[
				"Mission: paused (worker_inactive)",
				"Goal: Ship the widget",
				"Current: f2 — f2 work",
				"Features: 1/3 completed",
			].join("\n"),
		);
	});

	it("omits the pause reason and current feature when neither applies", async () => {
		const acp = acpHost({ snapshot: missionState({ features: [feature("f1", "pending")] }) });

		await executeAcpBuiltinSlashCommand("/mission status", acp.runtime);

		expect(acpText(acp)).toBe(["Mission: running", "Goal: Ship the widget", "Features: 0/1 completed"].join("\n"));
	});

	it("bounds model-authored goal and feature text to one summary screen", async () => {
		const active = {
			...feature("f1", "in_progress"),
			description: `first\tline\n${"detail ".repeat(100)}`,
		};
		const acp = acpHost({
			snapshot: missionState({ goal: `ship\n${"goal ".repeat(100)}`, features: [active] }),
		});

		await executeAcpBuiltinSlashCommand("/mission status", acp.runtime);

		const output = acpText(acp);
		if (output === undefined) throw new Error("expected mission status output");
		expect(output.split("\n")).toHaveLength(4);
		expect(output).not.toContain("\t");
		expect(output.length).toBeLessThan(300);
	});

	it("accepts a proposed plan and reports the post-accept status", async () => {
		const acp = acpHost({ accept: missionState({ status: "initializing" }) });

		await executeAcpBuiltinSlashCommand("/mission accept", acp.runtime);

		expect(acp.mission.accept).toHaveBeenCalledTimes(1);
		expect(acp.mission.start).not.toHaveBeenCalled();
		expect(acpText(acp)).toBe(
			["Mission: initializing", "Goal: Ship the widget", "Features: 0/0 completed"].join("\n"),
		);
	});

	it("pauses with the user_requested reason", async () => {
		const acp = acpHost({ pause: missionState({ status: "paused", pauseReason: "user_requested" }) });

		await executeAcpBuiltinSlashCommand("/mission pause", acp.runtime);

		expect(acp.mission.pause).toHaveBeenCalledWith("user_requested");
		expect(acpText(acp)).toBe(
			["Mission: paused (user_requested)", "Goal: Ship the widget", "Features: 0/0 completed"].join("\n"),
		);
	});

	it("resumes with no worker message when none was typed", async () => {
		const acp = acpHost();

		await executeAcpBuiltinSlashCommand("/mission resume", acp.runtime);

		expect(acp.mission.resume).toHaveBeenCalledWith({ messageToWorker: undefined });
	});

	it("passes trailing resume text to the worker", async () => {
		const acp = acpHost();

		await executeAcpBuiltinSlashCommand("/mission resume focus on the failing test", acp.runtime);

		expect(acp.mission.resume).toHaveBeenCalledWith({ messageToWorker: "focus on the failing test" });
	});

	it("refuses resume and restart while mission work is in flight", async () => {
		for (const verb of ["resume", "restart"]) {
			const acp = acpHost({
				busy: true,
				snapshot: missionState({ status: "paused", pauseReason: "user_requested" }),
			});

			await executeAcpBuiltinSlashCommand(`/mission ${verb}`, acp.runtime);

			expect(acpText(acp)).toContain(`${MISSION_BUSY}: cannot ${verb} while work is in flight.`);
			expect(acp.mission.resume).not.toHaveBeenCalled();
		}
	});

	it("cancels the mission", async () => {
		const acp = acpHost({ cancel: missionState({ status: "cancelled" }) });

		await executeAcpBuiltinSlashCommand("/mission cancel", acp.runtime);

		expect(acp.mission.cancel).toHaveBeenCalledTimes(1);
		expect(acpText(acp)).toBe(["Mission: cancelled", "Goal: Ship the widget", "Features: 0/0 completed"].join("\n"));
	});

	it("restart releases the worker and resolves a pending handoff as retry_fresh", async () => {
		const acp = acpHost({
			snapshot: missionState({ status: "paused", pauseReason: "user_requested" }),
			resume: missionState({ status: "orchestrator_turn", pendingHandoff: PENDING_HANDOFF }),
			resolveHandoff: missionState({ status: "running", features: [feature("f1", "in_progress")] }),
		});

		await executeAcpBuiltinSlashCommand("/mission restart try the other approach", acp.runtime);

		expect(acp.mission.resume).toHaveBeenCalledWith({
			restartWorker: true,
			messageToWorker: "try the other approach",
		});
		expect(acp.mission.resolveHandoff).toHaveBeenCalledWith({
			decision: "retry_fresh",
			messageToWorker: "try the other approach",
		});
		expect(acpText(acp)).toBe(
			["Mission: running", "Goal: Ship the widget", "Current: f1 — f1 work", "Features: 0/1 completed"].join("\n"),
		);
	});

	it("restart on a paused mission with no pending handoff stops after the resume", async () => {
		const acp = acpHost({
			snapshot: missionState({ status: "paused", pauseReason: "worker_interrupted" }),
			resume: missionState({ status: "running" }),
		});

		await executeAcpBuiltinSlashCommand("/mission restart", acp.runtime);

		expect(acp.mission.resume).toHaveBeenCalledWith({ restartWorker: true, messageToWorker: undefined });
		expect(acp.mission.resolveHandoff).not.toHaveBeenCalled();
		expect(acpText(acp)).toBe(["Mission: running", "Goal: Ship the widget", "Features: 0/0 completed"].join("\n"));
	});

	it("refuses restart for a running mission without touching the runtime", async () => {
		const acp = acpHost({ snapshot: missionState({ status: "running" }) });

		const result = await executeAcpBuiltinSlashCommand("/mission restart", acp.runtime);

		expect(result).toEqual({ consumed: true });
		expect(acp.mission.resume).not.toHaveBeenCalled();
		expect(acp.mission.resolveHandoff).not.toHaveBeenCalled();
		expect(acpText(acp)).toBe(
			'Mission: restart requires a paused mission or a pending handoff (status is "running"); pause the mission first.',
		);
	});

	it("reports a missing mission on restart", async () => {
		const acp = acpHost({ snapshot: null });

		await executeAcpBuiltinSlashCommand("/mission restart", acp.runtime);

		expect(acpText(acp)).toBe("Mission: There is no mission to restart.");
	});

	it("maps an invalid transition to a prefixed message on both hosts", async () => {
		const failure = new MissionRuntimeError('accept is valid only in awaiting_input (status is "running").');
		const acp = acpHost({ accept: failure });
		const tui = tuiHost({ accept: failure });

		expect(await executeAcpBuiltinSlashCommand("/mission accept", acp.runtime)).toEqual({ consumed: true });
		expect(await executeBuiltinSlashCommand("/mission accept", tui.runtime)).toBe(true);

		const expected = 'Mission: accept is valid only in awaiting_input (status is "running").';
		expect(acpText(acp)).toBe(expected);
		expect(tui.showError).toHaveBeenCalledWith(expected);
		expect(tui.showStatus).not.toHaveBeenCalled();
		expect(tui.setText).toHaveBeenCalledWith("");
	});

	it("treats an unknown verb as the mission goal", async () => {
		const acp = acpHost({ start: missionState({ status: "awaiting_input", goal: "rebuild the docs site" }) });

		await executeAcpBuiltinSlashCommand("/mission rebuild the docs site", acp.runtime);

		expect(acp.mission.start).toHaveBeenCalledWith("rebuild the docs site");
		expect(acp.mission.accept).not.toHaveBeenCalled();
		expect(acpText(acp)).toBe(
			["Mission: awaiting_input", "Goal: rebuild the docs site", "Features: 0/0 completed"].join("\n"),
		);
	});

	it("matches verbs case-insensitively rather than starting a mission named after one", async () => {
		const acp = acpHost({ snapshot: missionState() });

		await executeAcpBuiltinSlashCommand("/mission STATUS", acp.runtime);

		expect(acp.mission.start).not.toHaveBeenCalled();
		expect(acpText(acp)).toBe(["Mission: running", "Goal: Ship the widget", "Features: 0/0 completed"].join("\n"));
	});

	it("drives the runtime identically from the TUI and ACP hosts for every verb", async () => {
		const invocations = [
			"/mission status",
			"/mission accept",
			"/mission pause",
			"/mission resume keep going",
			"/mission restart keep going",
			"/mission cancel",
			"/mission rebuild the docs site",
		];

		for (const invocation of invocations) {
			const outcomes: MissionOutcomes = {
				snapshot: missionState({ status: "paused", pauseReason: "user_requested" }),
				resume: missionState({ status: "orchestrator_turn", pendingHandoff: PENDING_HANDOFF }),
				resolveHandoff: missionState({ status: "running" }),
			};
			const acp = acpHost(outcomes);
			const tui = tuiHost(outcomes);

			await executeAcpBuiltinSlashCommand(invocation, acp.runtime);
			await executeBuiltinSlashCommand(invocation, tui.runtime);

			expect(tui.showStatus.mock.calls).toEqual(acp.output.mock.calls);
			expect(tui.showError).not.toHaveBeenCalled();
			expect(callArgs(tui.mission)).toEqual(callArgs(acp.mission));
		}
	});
});
