import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { classifyContractFailure } from "@oh-my-pi/pi-coding-agent/task/routing/contract-failure";
import * as snapshotModule from "@oh-my-pi/pi-coding-agent/task/routing/snapshot";
import type { ResourcePoolIdentity, RoutingCandidateInput } from "@oh-my-pi/pi-coding-agent/task/routing/types";
import {
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const SCOUT_SCHEMA = { type: "object", properties: { findings: { type: "string" } }, required: ["findings"] };

const AGENT_SCOUT: AgentDefinition = {
	name: "scout",
	description: "Recon",
	systemPrompt: "Scout",
	source: "bundled",
	tools: ["read", "grep"],
	output: SCOUT_SCHEMA,
};

const AGENT_TASK: AgentDefinition = {
	name: "task",
	description: "Task",
	systemPrompt: "Task",
	source: "bundled",
};

function pool(provider: string, accountKey = "api-key"): ResourcePoolIdentity {
	return {
		key: `${provider}\0https://api.${provider}.com\0${accountKey}`,
		provider,
		baseUrl: `https://api.${provider}.com`,
		accountKey,
		label: accountKey === "api-key" ? provider : `${provider} (${accountKey})`,
	};
}

const PARENT_POOL = pool("anthropic", "chris@example.com");

function candidate(selector: string, identity: ResourcePoolIdentity, extra: Partial<RoutingCandidateInput> = {}) {
	return {
		selector,
		pool: identity,
		vision: false,
		supportsTools: true,
		contextWindow: 200_000,
		costPerMTokenTotal: 3,
		reasoning: true,
		usage: "healthy",
		...extra,
	} satisfies RoutingCandidateInput;
}

/** Cursor + Codex are external pools; the Anthropic candidate shares the parent pool. */
function externalAndParentCandidates(): RoutingCandidateInput[] {
	return [
		candidate("cursor/composer-2.5", pool("cursor"), { costPerMTokenTotal: 2 }),
		candidate("codex/gpt-5", pool("codex"), { costPerMTokenTotal: 4 }),
		candidate("anthropic/claude-sonnet-4-5", PARENT_POOL, { costPerMTokenTotal: 1 }),
	];
}

function mockDiscovery(agents: AgentDefinition[] = [AGENT_SCOUT, AGENT_TASK]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function mockSnapshot(candidates: RoutingCandidateInput[], parentPool: ResourcePoolIdentity | undefined = PARENT_POOL) {
	return vi.spyOn(snapshotModule, "buildRoutingSnapshot").mockResolvedValue({ candidates, parentPool });
}

function session(overrides: Record<string, unknown> = {}): ToolSession {
	const settings = Settings.isolated({
		"task.isolation.mode": "none",
		"task.enableLsp": false,
		...overrides,
	} as Record<string, unknown>);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "test-session-id",
		getActiveModelString: () => "anthropic/claude-sonnet-4-5",
		getModelString: () => "anthropic/claude-sonnet-4-5",
		taskDepth: 0,
	} as unknown as ToolSession;
}

function completedResult(options: ExecutorOptions, output: string): SingleResult {
	return {
		index: options.index ?? 0,
		id: options.id,
		agent: options.agent.name,
		agentSource: "bundled",
		task: options.task,
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		routingIntent: options.routingIntent,
		resourcePool: options.resourcePool,
		routingReason: options.routingReason,
		routingAntiAffinity: options.routingAntiAffinity,
		routingParentPoolFallback: options.routingParentPoolFallback,
		routingUsageInfluenced: options.routingUsageInfluenced,
		routingBypassReason: options.routingBypassReason,
		routingReroutes: options.routingReroutes,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("task routing integration", () => {
	it("routes a default spawn away from the parent resource pool (Gate B)", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const policy = await resolveEffectiveSubagentPolicy({
			session: session(),
			invocationKind: "task",
			assignment: "recon",
			agent: "scout",
		});
		expect(policy.routingPoolKey).not.toBe(PARENT_POOL.key);
		expect(policy.routingAntiAffinity).toBe(true);
		expect(policy.modelOverride?.[0]).not.toBe("anthropic/claude-sonnet-4-5");
	});

	it("F12 a sticky run policy applies to later spawns without any persisted config write", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const live = session();
		snapshotModule.applyStickyRoutingPolicy(live.settings, { excludePools: ["cursor"], sticky: true });

		const first = await resolveEffectiveSubagentPolicy({
			session: live,
			invocationKind: "task",
			assignment: "first",
			agent: "scout",
		});
		const second = await resolveEffectiveSubagentPolicy({
			session: live,
			invocationKind: "task",
			assignment: "second",
			agent: "scout",
		});
		for (const policy of [first, second]) {
			expect(policy.modelOverride?.some(selector => selector.startsWith("cursor/"))).toBe(false);
			expect(policy.routingPoolKey).toBe(pool("codex").key);
		}
		// Session-scoped only: a fresh Settings instance still carries the default.
		expect(Settings.isolated().get("task.routing.excludePools")).toEqual([]);
	});

	it("F16 a legacy payload with only agent + task still resolves a model", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const policy = await resolveEffectiveSubagentPolicy({
			session: session(),
			invocationKind: "task",
			assignment: "legacy work",
			agent: "scout",
		});
		expect(policy.agentName).toBe("scout");
		expect(policy.modelOverride?.length).toBeGreaterThan(0);
	});

	it("F16 falls back to the configured model when routing is disabled", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const policy = await resolveEffectiveSubagentPolicy({
			session: session({ "task.routing.enabled": false, "task.agentModelOverrides": {} }),
			invocationKind: "task",
			assignment: "legacy work",
			agent: "scout",
		});
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(policy.routingPoolKey).toBeUndefined();
	});

	it("F14 resolves a routed spawn with no model probe: no child launch and no network call", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const runSpy = vi.spyOn(executorModule, "runSubprocess");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const policy = await resolveEffectiveSubagentPolicy({
			session: session(),
			invocationKind: "task",
			assignment: "recon",
			agent: "scout",
		});
		expect(policy.modelOverride?.length).toBeGreaterThan(0);
		expect(runSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("F17 routing metadata survives onto the final SingleResult", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			completedResult(options, JSON.stringify({ findings: "ok" })),
		);
		const execution = await runStructuredSubagent({
			session: session({ "task.routing.agentIntents": { scout: "cheap" } }),
			invocationKind: "task",
			assignment: "scout work",
			agent: "scout",
		});
		expect(execution.result.routingIntent).toBe("cheap");
		expect(execution.result.resourcePool).toBe("cursor");
		expect(execution.result.routingAntiAffinity).toBe(true);
		expect(execution.result.routingReason).toContain("cursor");
	});

	it("F9 an explicit per-invocation pin wins even inside the parent pool and records the override", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		vi.spyOn(snapshotModule, "resolveParentPoolIdentity").mockReturnValue(PARENT_POOL);
		vi.spyOn(snapshotModule, "resolveProviderPool").mockReturnValue(PARENT_POOL);
		const policy = await resolveEffectiveSubagentPolicy({
			session: session(),
			invocationKind: "eval",
			assignment: "pinned work",
			agent: "scout",
			model: "anthropic/claude-opus-4-5",
		});
		expect(policy.modelOverride).toEqual(["anthropic/claude-opus-4-5"]);
		expect(policy.routingBypassReason).toBe("explicit model pin");
		expect(policy.routingParentPoolFallback).toBe(true);
		expect(policy.routingReason).toContain("overrides parent-pool protection");
	});

	it("agentModelOverrides stays a routable preference, not a hard pin", async () => {
		mockDiscovery();
		mockSnapshot(externalAndParentCandidates());
		const policy = await resolveEffectiveSubagentPolicy({
			// The configured default sits in the protected parent pool: routing must
			// still move the child out of it instead of honouring it as a pin.
			session: session({ "task.agentModelOverrides": { scout: ["anthropic/claude-sonnet-4-5"] } }),
			invocationKind: "task",
			assignment: "ordinary work",
			agent: "scout",
		});
		expect(policy.routingBypassReason).toBeUndefined();
		expect(policy.modelOverride?.[0]).not.toBe("anthropic/claude-sonnet-4-5");
		expect(policy.routingPoolKey).not.toBe(PARENT_POOL.key);
		expect(policy.routingAntiAffinity).toBe(true);
	});

	it("the worker roster makes an off-chain model eligible without binding it to an agent", async () => {
		mockDiscovery();
		const rosterModel = candidate("cursor/composer-2.5", pool("cursor"), { costPerMTokenTotal: 1 });
		mockSnapshot([rosterModel, candidate("anthropic/claude-sonnet-4-5", PARENT_POOL)]);
		for (const agent of ["scout", "task"]) {
			const policy = await resolveEffectiveSubagentPolicy({
				session: session({ "task.routing.workerModels": ["cursor/composer-2.5"] }),
				invocationKind: "task",
				assignment: `${agent} work`,
				agent,
			});
			expect(policy.modelOverride?.[0]).toBe("cursor/composer-2.5");
			expect(policy.resourcePool).toBe("cursor");
		}
	});

	it("F11 fails closed instead of silently consuming a protected parent pool", async () => {
		mockDiscovery();
		mockSnapshot([candidate("anthropic/claude-sonnet-4-5", PARENT_POOL)]);
		await expect(
			resolveEffectiveSubagentPolicy({
				session: session({ "task.routing.parentPoolFallback": "deny" }),
				invocationKind: "task",
				assignment: "recon",
				agent: "scout",
			}),
		).rejects.toThrow(/parent pool is protected/);
	});

	it("F19 a structured-output contract failure reroutes once to a different pool and stays bounded", async () => {
		mockDiscovery([AGENT_SCOUT]);
		mockSnapshot(externalAndParentCandidates());
		const launches: (string | undefined)[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const selector = Array.isArray(options.modelOverride) ? options.modelOverride[0] : options.modelOverride;
			launches.push(selector);
			if (launches.length === 1) {
				const failed = completedResult(options, "");
				failed.exitCode = 1;
				failed.stderr = "schema_violation: (root): expected object, received string";
				failed.structuredOutput = {
					source: "agent",
					mode: "permissive",
					status: "invalid",
					data: "plain text answer",
					error: "(root): expected object, received string",
				};
				return failed;
			}
			return completedResult(options, JSON.stringify({ findings: "ok" }));
		});
		const execution = await runStructuredSubagent({
			session: session(),
			invocationKind: "task",
			assignment: "scout work",
			agent: "scout",
		});
		expect(launches.length).toBe(2);
		expect(launches[1]).not.toBe(launches[0]);
		expect(execution.result.exitCode).toBe(0);
		expect(execution.result.routingReroutes?.length).toBe(1);
		expect(execution.result.routingReroutes?.[0]?.reason).toContain("expected object");
	});

	it("F19 reroutes away from the pool that actually ran, not the pool that was requested first", async () => {
		mockDiscovery([AGENT_SCOUT]);
		mockSnapshot(externalAndParentCandidates());
		const launches: (string | undefined)[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			launches.push(options.modelOverride?.[0]);
			if (launches.length === 1) {
				// The auth/retry chain moved past the requested head to the codex entry,
				// so codex — not the requested selector — is the failed route.
				const failed = completedResult(options, "");
				failed.exitCode = 1;
				failed.resolvedModel = "codex/gpt-5";
				failed.stderr = "schema_violation: (root): expected object, received string";
				failed.structuredOutput = {
					source: "agent",
					mode: "permissive",
					status: "invalid",
					data: "plain text answer",
					error: "(root): expected object, received string",
				};
				return failed;
			}
			return completedResult(options, JSON.stringify({ findings: "ok" }));
		});
		const execution = await runStructuredSubagent({
			session: session(),
			invocationKind: "task",
			assignment: "scout work",
			agent: "scout",
		});
		expect(execution.result.routingReroutes?.[0]?.from).toBe("codex/gpt-5");
		expect(launches[1]).not.toBe("codex/gpt-5");
	});

	it("F19 a repeated contract failure stops at the configured reroute bound", async () => {
		mockDiscovery([AGENT_SCOUT]);
		mockSnapshot(externalAndParentCandidates());
		let launches = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			launches++;
			const failed = completedResult(options, "");
			failed.exitCode = 1;
			failed.stderr = "schema_violation: (root): expected object, received string";
			failed.structuredOutput = {
				source: "agent",
				mode: "permissive",
				status: "invalid",
				data: "plain text",
				error: "(root): expected object, received string",
			};
			return failed;
		});
		const execution = await runStructuredSubagent({
			session: session(),
			invocationKind: "task",
			assignment: "scout work",
			agent: "scout",
		});
		expect(launches).toBe(2);
		expect(execution.result.exitCode).toBe(1);
		expect(execution.result.routingReroutes?.length).toBe(1);
	});

	it("classifies a route contract failure but not a child that merely mentions schema text", () => {
		const base: SingleResult = {
			index: 0,
			id: "a1",
			agent: "scout",
			agentSource: "bundled",
			task: "t",
			exitCode: 1,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
		expect(
			classifyContractFailure({ ...base, stderr: "schema_violation: (root): expected object, received string" })
				.isContractFailure,
		).toBe(true);
		expect(
			classifyContractFailure({
				...base,
				exitCode: 0,
				output: "The upstream service reports schema_violation: expected object, received string",
			}).isContractFailure,
		).toBe(false);
	});
});
