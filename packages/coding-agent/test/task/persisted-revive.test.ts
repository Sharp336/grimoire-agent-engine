import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
}

function createRevivedSession(
	activeToolNames: string[][],
	refreshedHostTools: string[][] = [],
	mountedToolNames: string[][] = [],
): RevivedSessionHandle {
	let observer: IrcWakeObserver | undefined;
	const session = {
		getMountedXdevToolNames: () => [],
		refreshRpcHostTools: async (tools: AgentTool[]) => {
			refreshedHostTools.push(tools.map(tool => tool.name));
		},
		getToolByName: () => undefined,
		setActiveToolPresentation: async (names: string[], mountedNames: string[]) => {
			activeToolNames.push(names);
			mountedToolNames.push(mountedNames);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		getLastAssistantMessage: () => undefined,
	} as unknown as AgentSession;
	return { session, observer: () => observer };
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	mountedTools: string[] = [],
	enableMCP?: boolean,
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		mountedTools,
		restrictToolNames,
		enableMCP,
		modelRole,
		resolvedModel: modelRole ? "anthropic/claude-sonnet-4-5" : undefined,
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

function createFactory(
	cwd: string,
	eventBus?: EventBus,
	mountedTools: AgentTool[] = [],
	rpcHostTools: AgentTool[] = [],
	registeredTools: AgentTool[] = mountedTools,
) {
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		getMountedXdevToolNames: () => mountedTools.map(tool => tool.name),
		getToolByName: (name: string) => registeredTools.find(tool => tool.name === name),
		getRpcHostTools: () => rpcHostTools,
		hasBuiltInTool: (name: string) => name === "read" || name === "bash" || name === "browser",
		get sessionFile() {
			return path.join(cwd, "parent.jsonl");
		},
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as ModelRegistry,
		settings: Settings.isolated(),
		enableLsp: true,
		eventBus,
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
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
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
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, ["ida_execute_python", "browser"]);
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		const hostTool = { name: "ida_execute_python" } as AgentTool;
		const laterHostTool = { name: "later_host_tool" } as AgentTool;
		const builtInTool = { name: "bash" } as AgentTool;
		const mountedBuiltInTool = { name: "browser" } as AgentTool;
		const activeToolNames: string[][] = [];
		const mountedToolNames: string[][] = [];
		const refreshedHostTools: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession(activeToolNames, refreshedHostTools, mountedToolNames).session,
			} as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(
			cwd,
			undefined,
			[hostTool, laterHostTool, builtInTool, mountedBuiltInTool],
			[hostTool, laterHostTool],
		)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
		expect(capturedOptions?.toolNames).toEqual(["read", "yield", "ida_execute_python", "browser"]);
		expect(refreshedHostTools).toEqual([["ida_execute_python"]]);
		expect(activeToolNames).toEqual([["read", "yield", "ida_execute_python", "browser"]]);
		expect(mountedToolNames).toEqual([["ida_execute_python", "browser"]]);
	});

	it("keeps MCP disabled while restoring non-MCP mounted tools", async () => {
		const cwd = makeTempDir("@pi-mcp-disabled-revive-");
		const sessionFile = await createPersistedSession(
			cwd,
			undefined,
			undefined,
			["mcp__server_read", "ida_execute_python"],
			false,
		);
		const mcpGetTools = vi.fn(() => [{ name: "mcp__server_read" }]);
		MCPManager.setInstance({ getTools: mcpGetTools } as unknown as MCPManager);
		const mcpTool = { name: "mcp__server_read" } as AgentTool;
		const hostTool = { name: "ida_execute_python" } as AgentTool;
		const activeToolNames: string[][] = [];
		const mountedToolNames: string[][] = [];
		const refreshedHostTools: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession(activeToolNames, refreshedHostTools, mountedToolNames).session,
			} as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, [mcpTool, hostTool], [mcpTool, hostTool])(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.toolNames).toEqual(["read", "yield", "ida_execute_python"]);
		expect(mcpGetTools).not.toHaveBeenCalled();
		expect(refreshedHostTools).toEqual([["ida_execute_python"]]);
		expect(activeToolNames).toEqual([["read", "yield", "ida_execute_python"]]);
		expect(mountedToolNames).toEqual([["ida_execute_python"]]);
	});

	it("does not restore a mounted snapshot from a same-name unmounted parent tool", async () => {
		const cwd = makeTempDir("@pi-mounted-source-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, ["ida_execute_python"]);
		const sameNameTool = { name: "ida_execute_python" } as AgentTool;
		const activeToolNames: string[][] = [];
		const mountedToolNames: string[][] = [];
		const refreshedHostTools: string[][] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: createRevivedSession(activeToolNames, refreshedHostTools, mountedToolNames).session,
		} as CreateAgentSessionResult);

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, [], [], [sameNameTool])(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(refreshedHostTools).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield", "ida_execute_python"]]);
		expect(mountedToolNames).toEqual([["ida_execute_python"]]);
	});

	it("restores the persisted custom model role before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd, eventBus)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
});
