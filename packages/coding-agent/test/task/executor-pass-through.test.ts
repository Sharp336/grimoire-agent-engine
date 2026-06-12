/**
 * Verifies parent-discovered rules, extensions, and custom tools are forwarded
 * to `createAgentSession` so subagents skip the FS scans the parent already
 * paid for. Regression guard for issue #2190.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { ChildControlTarget, DirectChildControlAdmission } from "@oh-my-pi/pi-coding-agent/agent-control/control";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-pass-through",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

const tempDirs: string[] = [];

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("forwards rules, preloadedExtensionPaths, and preloadedCustomToolPaths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.omp/extensions/foo.ts"];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];

		const result = await runSubprocess({
			...baseOptions,
			rules,
			preloadedExtensionPaths,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedCustomToolPaths).toBe(preloadedCustomToolPaths);
	});

	it("forwards undefined when the parent has not pre-discovered state", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.rules).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toBeUndefined();
		expect(forwarded?.preloadedCustomToolPaths).toBeUndefined();
	});

	it("stamps and admits only the explicit direct-child control generation", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-control-metadata-"));
		tempDirs.push(artifactsDir);
		const eventBus = new EventBus();
		const lifecycle: SubagentLifecyclePayload[] = [];
		const progress: SubagentProgressPayload[] = [];
		const events: SubagentEventPayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => lifecycle.push(payload as SubagentLifecyclePayload));
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => progress.push(payload as SubagentProgressPayload));
		eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, payload => events.push(payload as SubagentEventPayload));
		const admitted: ChildControlTarget[] = [];
		const directChildControl: DirectChildControlAdmission = {
			controlGeneration: "generation-explicit",
			admit: target => {
				admitted.push(target);
				return true;
			},
			markTerminal: () => {},
		};

		await runSubprocess({
			...baseOptions,
			id: "subagent-control-metadata",
			artifactsDir,
			eventBus,
			directChildControl,
		});

		const expectedTarget = {
			controlGeneration: "generation-explicit",
			id: "subagent-control-metadata",
			sessionFile: path.join(artifactsDir, "subagent-control-metadata.jsonl"),
		};
		expect(admitted).toEqual([expectedTarget]);
		expect(lifecycle.map(payload => payload.controlGeneration)).toEqual([
			"generation-explicit",
			"generation-explicit",
		]);
		expect(progress[0]).toMatchObject({
			controlGeneration: "generation-explicit",
			sessionFile: expectedTarget.sessionFile,
		});
		expect(events[0]).toMatchObject({
			controlGeneration: "generation-explicit",
			sessionFile: expectedTarget.sessionFile,
		});
	});
});
