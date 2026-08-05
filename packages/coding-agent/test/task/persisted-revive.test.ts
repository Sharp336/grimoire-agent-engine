import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MissionState, MissionStatus } from "@oh-my-pi/pi-coding-agent/missions/types";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function createRef(sessionFile: string): AgentRef {
	return {
		id: "persisted-restricted",
		displayName: "Persisted Restricted",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

function createRevivedSession(activeToolNames: string[][]): AgentSession {
	return {
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
	} as unknown as AgentSession;
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	missionOwner?: { ownerSessionId: string },
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		restrictToolNames,
		...(missionOwner
			? {
					cwdBinding: "fixed" as const,
					missionOwner: {
						missionId: "mission",
						ownerSessionId: missionOwner.ownerSessionId,
						role: "implementation" as const,
						milestoneId: "milestone",
						featureId: "feature",
					},
				}
			: {}),
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}

/** The mission snapshot the owning session would hold while `feature` is in progress. */
function createMissionSnapshot(overrides: {
	currentWorkerSessionId?: string;
	status?: MissionStatus;
	missionId?: string;
}): MissionState {
	return {
		version: 1,
		id: overrides.missionId ?? "mission",
		ownerSessionId: "owner",
		revision: 1,
		goal: "goal",
		autoAccept: false,
		status: overrides.status ?? "running",
		runbook: { setup: [], services: [], userTests: [] },
		milestones: [
			{ id: "milestone", description: "milestone", featureIds: ["feature"], validators: [], kind: "planned" },
		],
		features: [
			{
				id: "feature",
				description: "feature",
				milestoneId: "milestone",
				preconditions: [],
				expectedBehavior: [],
				kind: "implementation",
				status: "in_progress",
				workerSessionIds: ["persisted-restricted", "replacement-worker"],
				currentWorkerSessionId: overrides.currentWorkerSessionId,
				retryBudgetUsed: 1,
			},
		],
		createdAt: 0,
		updatedAt: 0,
	};
}

function createFactory(
	cwd: string,
	persistedSessionId = "",
	providerSessionId = "provider-session",
	missionSnapshot: () => MissionState | null = () => null,
) {
	const parentSession = {
		sessionId: providerSessionId,
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => persistedSessionId,
			getArtifactManager: () => undefined,
		},
		missionRuntime: { snapshot: missionSnapshot },
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as ModelRegistry,
		settings: Settings.isolated(),
		enableLsp: true,
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		const attemptedDiscovery: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			if (options?.preloadedExtensionPaths === undefined) attemptedDiscovery.push("extension:read");
			if (options?.preloadedCustomToolPaths === undefined) attemptedDiscovery.push("custom:read");
			if (options?.mcpManager !== undefined || options?.customTools !== undefined)
				attemptedDiscovery.push("mcp:read");
			return { session: createRevivedSession(activeToolNames) } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves normal revival capability wiring for contracts without the marker", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]) } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
	});

	it("revives a fixed child only for its owner and at its recorded workspace", async () => {
		const cwd = makeTempDir("@pi-fixed-revive-");
		const sessionFile = await createPersistedSession(cwd, false, { ownerSessionId: "owner" });
		const ref = createRef(sessionFile);
		const currentWorker = () => createMissionSnapshot({ currentWorkerSessionId: ref.id });

		// Owner gate: rejected even while the mission still lists the child as current.
		expect(await createFactory(cwd, "other", "provider-session", currentWorker)(ref)).toBeUndefined();

		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]) } as CreateAgentSessionResult;
		});
		const reviver = await createFactory("/parent", "owner", "provider-session", currentWorker)(ref);
		if (!reviver) throw new Error("Expected fixed workspace reviver");
		await reviver(ref);

		expect(capturedOptions?.cwd).toBe(cwd);
	});

	it("rejects a fixed child whose mission released it or is no longer active", async () => {
		const cwd = makeTempDir("@pi-released-revive-");
		const sessionFile = await createPersistedSession(cwd, false, { ownerSessionId: "owner" });
		const ref = createRef(sessionFile);
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("createAgentSession must not run for a released mission child");
		});

		// retry_fresh: the released id stays in workerSessionIds but is no longer current.
		const replaced = () => createMissionSnapshot({ currentWorkerSessionId: "replacement-worker" });
		expect(await createFactory(cwd, "owner", "provider-session", replaced)(ref)).toBeUndefined();

		// Terminal mission: no child of it may resurrect.
		const completed = () => createMissionSnapshot({ currentWorkerSessionId: ref.id, status: "completed" });
		expect(await createFactory(cwd, "owner", "provider-session", completed)(ref)).toBeUndefined();

		// A different mission now owns the session.
		const otherMission = () => createMissionSnapshot({ currentWorkerSessionId: ref.id, missionId: "other-mission" });
		expect(await createFactory(cwd, "owner", "provider-session", otherMission)(ref)).toBeUndefined();

		// The mission is not restored/active in this process at all.
		expect(await createFactory(cwd, "owner")(ref)).toBeUndefined();

		expect(createAgentSessionSpy).not.toHaveBeenCalled();
	});

	it("refuses to revive a fixed child released after its reviver was resolved", async () => {
		const cwd = makeTempDir("@pi-stale-revive-");
		const sessionFile = await createPersistedSession(cwd, false, { ownerSessionId: "owner" });
		const ref = createRef(sessionFile);
		let currentWorkerSessionId: string | undefined = ref.id;
		const snapshot = () => createMissionSnapshot({ currentWorkerSessionId });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createRevivedSession([]) }) as CreateAgentSessionResult,
		);

		const reviver = await createFactory(cwd, "owner", "provider-session", snapshot)(ref);
		if (!reviver) throw new Error("Expected a reviver while the child is still current");

		// retry_fresh lands between reviver resolution and the revive itself.
		currentWorkerSessionId = "replacement-worker";
		await expect(reviver(ref)).rejects.toThrow("its mission released it or is no longer active");
	});
});
