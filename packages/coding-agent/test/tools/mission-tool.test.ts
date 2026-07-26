import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	MissionHandoff,
	MissionPlan,
	MissionRuntimeContract,
	MissionState,
} from "@oh-my-pi/pi-coding-agent/missions/types";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	MissionTool,
	type MissionToolInput,
	type MissionToolSession,
	missionHandoffSummary,
	missionToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/mission-tool";

const plan: MissionPlan = {
	goal: "Ship it",
	runbook: { setup: [], services: [], userTests: [] },
	milestones: [{ id: "m1", description: "first", featureIds: ["f1"], validators: ["scrutiny"] }],
	features: [
		{ id: "f1", description: "implement", milestoneId: "m1", preconditions: [], expectedBehavior: ["works"] },
	],
};

function state(): MissionState {
	return {
		version: 1,
		id: "mission-1",
		ownerSessionId: "parent",
		revision: 1,
		goal: plan.goal,
		autoAccept: false,
		status: "running",
		runbook: plan.runbook,
		milestones: [{ ...plan.milestones[0], kind: "planned" }],
		features: [
			{
				...plan.features[0],
				kind: "implementation",
				status: "in_progress",
				workerSessionIds: [],
				retryBudgetUsed: 0,
			},
		],
		activeRun: { featureId: "f1", workerSessionId: "worker", turn: 1 },
		createdAt: 1,
		updatedAt: 1,
	};
}

function createRuntime(
	current: MissionState,
	handoff: MissionHandoff,
): { runtime: MissionRuntimeContract; calls: string[] } {
	const calls: string[] = [];
	const runtime: MissionRuntimeContract = {
		snapshot: () => current,
		start: async () => current,
		setPlan: async next => {
			calls.push(`set:${next.goal}`);
			return current;
		},
		accept: async () => current,
		runNext: async () => {
			calls.push("run");
			return handoff;
		},
		resolveHandoff: async input => {
			calls.push(`resolve:${input.decision}:${input.messageToWorker ?? ""}`);
			return current;
		},
		revisePending: async input => {
			calls.push(`revise:${input.addFeatures.map(feature => feature.id).join(",")}`);
			return current;
		},
		pause: async () => current,
		resume: async () => current,
		cancel: async () => current,
		prepareToSuspend: async () => {},
		restore: async () => current,
	};
	return { runtime, calls };
}

function session(runtime: MissionRuntimeContract | undefined, current: MissionState): MissionToolSession {
	return {
		cwd: "/tmp/mission-tool",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getMissionRuntime: () => runtime,
		getMissionState: () => current,
	};
}

function params(input: MissionToolInput): MissionToolInput {
	return input;
}

beforeAll(async () => {
	await initTheme();
});

describe("MissionTool", () => {
	it("delegates every parent operation to the mission runtime", async () => {
		const current = state();
		const handoff: MissionHandoff = {
			kind: "implementation",
			outcome: "success",
			summary: "finished",
			implementation: [],
			remaining: [],
			verification: { commands: [], interactiveChecks: [] },
			tests: { added: [], coverageNotes: [] },
			issues: [],
			skillDeviations: [],
			commits: [],
		};
		const { runtime, calls } = createRuntime(current, handoff);
		const tool = new MissionTool(session(runtime, current));

		const get = await tool.execute("call", params({ op: "get" }));
		if (!get.details) throw new Error("mission get result must include details");
		expect(get.details.op).toBe("get");
		expect(get.details.mission).toEqual(current);
		await tool.execute("call", params({ op: "set_plan", plan }));
		const run = await tool.execute("call", params({ op: "run_next" }));
		if (!run.details) throw new Error("mission run result must include details");
		expect(run.details.handoff).toEqual(handoff);
		const runText = run.content.find(block => block.type === "text")?.text ?? "";
		expect(runText).not.toContain("Handoff this turn:");
		await tool.execute(
			"call",
			params({ op: "resolve_handoff", decision: "retry_same", message_to_worker: "  retry carefully  " }),
		);
		await tool.execute(
			"call",
			params({
				op: "revise_pending",
				add_features: [{ id: "repair", description: "fix", preconditions: [], expectedBehavior: ["passes"] }],
			}),
		);

		expect(calls).toEqual(["set:Ship it", "run", "resolve:retry_same:retry carefully", "revise:repair"]);
	});

	it("refuses inactive or foreign mission sessions", async () => {
		const current = state();
		const tool = new MissionTool(session(undefined, current));
		await expect(tool.execute("call", params({ op: "get" }))).rejects.toThrow("No active owned mission");
	});

	it("renders an allowlisted, single-line handoff summary", async () => {
		const current = state();
		current.goal = "goal\twith\nlayout";
		const handoff: MissionHandoff = {
			kind: "implementation",
			outcome: "failure",
			summary: "worker\tfailed\nwithout leaking details",
			implementation: ["/private/path"],
			remaining: [],
			verification: {
				commands: [{ command: "secret-command", result: "failed", evidence: "TOP_SECRET" }],
				interactiveChecks: [],
			},
			tests: { added: [], coverageNotes: [] },
			issues: [{ severity: "blocking", description: "blocked", evidence: "TOP_SECRET" }],
			skillDeviations: [],
			commits: [],
		};
		expect(missionHandoffSummary(handoff, 80)).toBe(
			"implementation failure (1 blocking): worker failed without leaking details",
		);
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme is required for mission renderer test");
		const rendered = missionToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "TOP_SECRET" }], details: { op: "run_next", mission: current, handoff } },
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(120)
			.join("\n");
		const text = Bun.stripANSI(rendered);
		expect(text).toContain("goal with layout");
		expect(text).toContain("implementation failure (1 blocking): worker failed without leaking details");
		expect(text).not.toContain("TOP_SECRET");
		expect(text).not.toContain("secret-command");
		expect(text).not.toContain("/private/path");
	});
});
