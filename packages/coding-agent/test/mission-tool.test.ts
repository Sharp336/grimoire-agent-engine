import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type MissionRuntime, MissionRuntimeError } from "@oh-my-pi/pi-coding-agent/missions/runtime";
import { MissionTool } from "@oh-my-pi/pi-coding-agent/missions/tools/mission-tool";
import type { MissionHandoff, MissionPlan, MissionState } from "@oh-my-pi/pi-coding-agent/missions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

const VALID_PLAN: MissionPlan = {
	goal: "Ship the widget",
	runbook: { setup: [], services: [], userTests: [] },
	milestones: [{ id: "m1", description: "Milestone one", featureIds: ["f1"], validators: ["scrutiny"] }],
	features: [
		{ id: "f1", description: "Feature one", milestoneId: "m1", preconditions: [], expectedBehavior: ["works"] },
	],
};

function makeState(overrides: Partial<MissionState> = {}): MissionState {
	return {
		version: 1,
		id: "mission-test",
		ownerSessionId: "owner",
		revision: 1,
		goal: "Ship the widget",
		autoAccept: false,
		status: "awaiting_input",
		runbook: { setup: [], services: [], userTests: [] },
		milestones: [
			{ id: "m1", description: "Milestone one", featureIds: ["f1"], validators: ["scrutiny"], kind: "planned" },
		],
		features: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const tempDirs: TempDir[] = [];
const sessions: AgentSession[] = [];

async function createSession(name: string): Promise<AgentSession> {
	const tempDir = TempDir.createSync(`@mission-tool-${name}-`);
	tempDirs.push(tempDir);
	const cwd = tempDir.join("project-root");
	fs.mkdirSync(cwd, { recursive: true });
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
	const result = await createAgentSession({
		cwd,
		agentDir: tempDir.path(),
		sessionManager,
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	sessions.push(result.session);
	return result.session;
}

/** Minimal ToolSession that hands the tool one specific runtime. */
function toolSessionFor(runtime: MissionRuntime): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getMissionRuntime: () => runtime,
	};
}

describe("mission tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	// ── registration + activation (the exact defect) ───────────────────────────

	it("registers mission and activates it via setActiveToolsByName", async () => {
		const session = await createSession("register");

		// Registry genuinely holds `mission` — it is registrable, not filtered away.
		expect(session.getAllToolNames()).toContain("mission");

		// The default active set excludes it: the runtime activates it explicitly.
		const before = session.getEnabledToolNames();
		expect(before).not.toContain("mission");

		// Activation succeeds because the registry resolves the name (the bug was
		// that an unregistered name is silently dropped here).
		await session.setActiveToolsByName([...before, "mission"]);
		expect(session.getEnabledToolNames()).toContain("mission");
	});

	// ── per-op dispatch to the runtime ─────────────────────────────────────────

	let dispatchSession: AgentSession;
	let runtime: MissionRuntime;
	beforeAll(async () => {
		dispatchSession = await createSession("dispatch");
		runtime = dispatchSession.missionRuntime;
	});

	it("get -> snapshot()", async () => {
		const spy = vi.spyOn(runtime, "snapshot").mockReturnValue(makeState({ status: "running" }));
		const tool = new MissionTool(toolSessionFor(runtime));
		const result = await tool.execute("call", { op: "get" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ op: "get", status: "running" });
	});

	it("set_plan -> setPlan(plan)", async () => {
		const spy = vi.spyOn(runtime, "setPlan").mockResolvedValue(makeState({ status: "awaiting_input" }));
		const tool = new MissionTool(toolSessionFor(runtime));
		const result = await tool.execute("call", { op: "set_plan", plan: VALID_PLAN });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toEqual(VALID_PLAN);
		expect(result.details).toMatchObject({ op: "set_plan", status: "awaiting_input" });
	});

	it("run_next -> runNext(signal)", async () => {
		const handoff: MissionHandoff = {
			kind: "validation",
			role: "scrutiny",
			verdict: "pass",
			summary: "looks good",
			checks: [],
			issues: [],
		};
		const spy = vi.spyOn(runtime, "runNext").mockResolvedValue(handoff);
		const tool = new MissionTool(toolSessionFor(runtime));
		const result = await tool.execute("call", { op: "run_next" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.details).toMatchObject({ op: "run_next", handoff: "validation" });
	});

	it("resolve_handoff -> resolveHandoff({decision, messageToWorker}) (snake_case mapped)", async () => {
		const spy = vi.spyOn(runtime, "resolveHandoff").mockResolvedValue(makeState({ status: "running" }));
		const tool = new MissionTool(toolSessionFor(runtime));
		const result = await tool.execute("call", {
			op: "resolve_handoff",
			decision: "retry_fresh",
			message_to_worker: "try again",
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toEqual({ decision: "retry_fresh", messageToWorker: "try again" });
		expect(result.details).toMatchObject({ op: "resolve_handoff", decision: "retry_fresh", status: "running" });
	});

	it("revise_pending -> revisePending({addFeatures}) (snake_case mapped)", async () => {
		const spy = vi.spyOn(runtime, "revisePending").mockResolvedValue(makeState({ status: "orchestrator_turn" }));
		const tool = new MissionTool(toolSessionFor(runtime));
		const addFeatures = [{ id: "r1", description: "fix it", preconditions: [], expectedBehavior: ["fixed"] }];
		const result = await tool.execute("call", { op: "revise_pending", add_features: addFeatures });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toEqual({ addFeatures });
		expect(result.details).toMatchObject({ op: "revise_pending", addedFeatures: 1 });
	});

	it("surfaces MissionRuntimeError as a readable ToolError, not the raw throw", async () => {
		vi.spyOn(runtime, "setPlan").mockRejectedValue(new MissionRuntimeError("plan is invalid"));
		const tool = new MissionTool(toolSessionFor(runtime));
		await expect(tool.execute("call", { op: "set_plan", plan: VALID_PLAN })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call", { op: "set_plan", plan: VALID_PLAN })).rejects.toThrow("plan is invalid");
	});

	// ── end-to-end: set_plan moves a real mission out of planning ──────────────

	it("set_plan on a planning mission transitions it out of planning (no stall)", async () => {
		const session = await createSession("transition");
		await session.startMission("Ship the widget");
		expect(session.missionRuntime.snapshot()?.status).toBe("planning");

		const tool = new MissionTool(toolSessionFor(session.missionRuntime));
		const result = await tool.execute("call", { op: "set_plan", plan: VALID_PLAN });

		expect(result.isError).toBeFalsy();
		const status = session.missionRuntime.snapshot()?.status;
		expect(status).not.toBe("planning");
		expect(status).toBe("awaiting_input");
	});
});
