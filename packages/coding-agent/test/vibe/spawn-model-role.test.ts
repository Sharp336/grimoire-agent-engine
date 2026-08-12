/**
 * Contract: a vibe worker's spawn options carry the pre-expansion model role.
 *
 * `#resolveWorker` expands the bundled worker's role alias (`good` -> `task` ->
 * `@task`, `fast` -> `sonic` -> `@smol`) into concrete patterns, so the role
 * survives only as a separate field forwarded across `ResolvedVibeWorker` ->
 * `VibeRecord` -> `#buildSpawnOptions` -> `runSubprocess`. The executor keys the
 * child's inherited `retry.fallbackChains` entry off it; drop any link in that
 * chain and vibe children silently retry on the `default` role's chain.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type VibeCli, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

type ParentOptions = {
	hostTools?: AgentTool[];
	mountedNames?: string[];
	enableMCP?: boolean;
	restrictToolNames?: boolean;
	mcpManager?: unknown;
	extensionPaths?: string[];
	customToolPaths?: unknown[];
};

function makeParentSession(settings: Settings, options: ParentOptions = {}): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getRpcHostTools: () => options.hostTools ?? [],
		getMountedXdevToolNames: () => options.mountedNames ?? [],
		enableMCP: options.enableMCP,
		restrictToolNames: options.restrictToolNames,
		mcpManager: options.mcpManager,
		extensionPaths: options.extensionPaths,
		customToolPaths: options.customToolPaths,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(
	cli: VibeCli,
	settings: Settings,
	parentOptions: ParentOptions = {},
): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings, parentOptions), { cli, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn model role", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the `task` role behind the `good` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
			}),
		);

		expect(options.modelOverride).toEqual(["anthropic/sonnet"]);
		expect(options.modelRole).toBe("task");
	});

	it("forwards the `smol` role behind the `fast` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.modelOverride).toEqual(["fast/hy3"]);
		expect(options.modelRole).toBe("smol");
	});

	it("keeps the role identity when a per-agent model override replaces the alias", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["openai-codex/sol"]);
		expect(options.modelRole).toBeUndefined();
	});

	it("forwards parent host tools with their mounted presentation", async () => {
		let idaCalls = 0;
		const ida = {
			name: "ida_execute_python",
			execute: async () => {
				idaCalls++;
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as unknown as AgentTool;
		const browser = { name: "browser", execute: async () => ({ content: [] }) } as unknown as AgentTool;

		const options = await spawnAndCaptureOptions("good", Settings.isolated(), {
			hostTools: [ida, browser],
			mountedNames: [ida.name],
		});

		expect(options.parentHostTools).toEqual([ida, browser]);
		expect(options.parentMountedHostToolNames).toEqual([ida.name]);
		await options.parentHostTools?.[0]?.execute("call", {}, undefined, () => {});
		expect(idaCalls).toBe(1);
	});

	it("does not forward MCP host tools when the parent disables MCP", async () => {
		const options = await spawnAndCaptureOptions("good", Settings.isolated(), {
			enableMCP: false,
			hostTools: [{ name: "mcp__poe_native_query" } as AgentTool],
			mountedNames: ["mcp__poe_native_query"],
			mcpManager: {} as unknown,
		});

		expect(options.enableMCP).toBe(false);
		expect(options.mcpManager).toBeUndefined();
		expect(options.parentHostTools).toEqual([]);
		expect(options.parentMountedHostToolNames).toEqual([]);
	});

	it("does not forward any host capability to a restricted worker", async () => {
		const options = await spawnAndCaptureOptions("good", Settings.isolated(), {
			restrictToolNames: true,
			hostTools: [{ name: "ida_execute_python" } as AgentTool, { name: "mcp__poe_native_query" } as AgentTool],
			mountedNames: ["ida_execute_python", "mcp__poe_native_query"],
			mcpManager: {} as unknown,
			extensionPaths: ["/parent/extensions.ts"],
			customToolPaths: [{ path: "/parent/tool.ts" }],
		});

		expect(options.restrictToolNames).toBe(true);
		expect(options.enableMCP).toBe(false);
		expect(options.mcpManager).toBeUndefined();
		expect(options.parentHostTools).toEqual([]);
		expect(options.parentMountedHostToolNames).toEqual([]);
		expect(options.preloadedExtensionPaths).toEqual([]);
		expect(options.preloadedCustomToolPaths).toEqual([]);
	});
});
