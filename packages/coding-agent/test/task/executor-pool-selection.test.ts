import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelUsageHealth, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

/**
 * Spawn-time pool selection. Both subscriptions are listed on the spawn, so
 * today every spawn starts on `plan-a/opus`. Weighted selection draws from
 * `pool:<parent task call id>:<spawn id>`. Both parts are fixed below, so each
 * expected model is a pinned value rather than a distribution.
 *
 * The task call id has to be in the seed: spawn ids are model-supplied names, so
 * seeding on the name alone would give a project that always spawns
 * Explorer/Analyzer/Writer/Checker the same split on every run forever.
 *
 * hashPoolSeed("pool:call-177:<id>") / 2^32:
 *   spawn-alpha 0.3539
 *   spawn-india 0.2183
 *   spawn-echo  0.5963
 *   spawn-mike  0.8451
 * Two equal weights cut at 0.5; weights 2:1 cut at 0.6667.
 *
 * hashPoolSeed("pool:call-42:<id>") / 2^32, used for the second task call:
 *   spawn-alpha 0.7856
 *   spawn-india 0.8936
 *   spawn-echo  0.1941
 *   spawn-mike  0.3368
 */

const PRIMARY = "plan-a/opus";
const SECONDARY = "plan-b/codex";
const TERTIARY = "plan-c/sonnet";
const PARENT_CALL = "call-177";
const SPAWN_IDS = ["spawn-alpha", "spawn-india", "spawn-echo", "spawn-mike"];

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const primaryModel = model("plan-a", "opus");
const secondaryModel = model("plan-b", "codex");
const tertiaryModel = model("plan-c", "sonnet");

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

interface SpawnOutcome {
	resolvedModel: string | undefined;
	error: string | undefined;
	fallbackChains: Record<string, string[]> | undefined;
	healthCalls: string[];
}

/** Run one spawn against both plans and report what it started on. */
async function spawn(args: {
	id: string;
	settings: Settings;
	health?: Record<string, ModelUsageHealthState>;
	/** Selectors the registry has no credentials for. */
	unauthenticated?: string[];
	/** Model patterns the spawn requests; defaults to both plans. */
	modelOverride?: string[];
	/** Task tool call the spawn belongs to; part of the draw seed. */
	parentToolCallId?: string;
}): Promise<SpawnOutcome> {
	let fallbackChains: Record<string, string[]> | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected createAgentSession options");
		fallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
		return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
	});

	const healthCalls: string[] = [];
	const unauthenticated = new Set(args.unauthenticated ?? []);
	const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "work",
		index: 0,
		id: args.id,
		modelOverride: args.modelOverride ?? [PRIMARY, SECONDARY],
		parentToolCallId: args.parentToolCallId ?? PARENT_CALL,
		settings: args.settings,
		modelRegistry: {
			refresh: async () => {},
			// The real ModelRegistry only lists a model as available when it has
			// credentials, so an unauthenticated model must not show up here either.
			getAvailable: () =>
				[primaryModel, secondaryModel, tertiaryModel].filter(
					candidate => !unauthenticated.has(`${candidate.provider}/${candidate.id}`),
				),
			getApiKey: async () => "test-key",
			hasConfiguredAuth: (candidate: Model<Api>) => !unauthenticated.has(`${candidate.provider}/${candidate.id}`),
			authStorage: {
				getModelUsageHealth: async (provider: string, options: { modelId?: string }): Promise<ModelUsageHealth> => {
					const selector = `${provider}/${options.modelId}`;
					healthCalls.push(selector);
					return { state: args.health?.[selector] ?? "healthy", accounts: [] };
				},
			},
		} as never,
		enableLsp: false,
	});

	return { resolvedModel: result.resolvedModel, error: result.error, fallbackChains, healthCalls };
}

function weightedSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ "retry.poolSelection": "weighted", ...overrides });
}

describe("subagent model pool selection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("spawns every subagent onto the first candidate when pool selection is unconfigured", async () => {
		const picks: Array<string | undefined> = [];
		for (const id of SPAWN_IDS) {
			picks.push((await spawn({ id, settings: Settings.isolated() })).resolvedModel);
		}
		expect(picks).toEqual([PRIMARY, PRIMARY, PRIMARY, PRIMARY]);
	});

	it("spreads a burst of spawns across both candidates under equal weights", async () => {
		const picks: Array<string | undefined> = [];
		for (const id of SPAWN_IDS) {
			picks.push((await spawn({ id, settings: weightedSettings() })).resolvedModel);
		}
		expect(picks).toEqual([PRIMARY, PRIMARY, SECONDARY, SECONDARY]);
	});

	it("redistributes the same agent names across a second task call", async () => {
		// Agent names repeat: a project that always spawns the same four roles must
		// not get the same split on every task call. The seed mixes in the task call
		// id, so the same names draw a different vector under a different call.
		const first: Array<string | undefined> = [];
		const second: Array<string | undefined> = [];
		for (const id of SPAWN_IDS) {
			first.push((await spawn({ id, settings: weightedSettings(), parentToolCallId: "call-177" })).resolvedModel);
			second.push((await spawn({ id, settings: weightedSettings(), parentToolCallId: "call-42" })).resolvedModel);
		}
		expect(first).toEqual([PRIMARY, PRIMARY, SECONDARY, SECONDARY]);
		expect(second).toEqual([SECONDARY, SECONDARY, PRIMARY, PRIMARY]);
	});

	it("shifts the split when weights favour one candidate", async () => {
		const picks: Array<string | undefined> = [];
		for (const id of SPAWN_IDS) {
			const settings = weightedSettings({ "retry.poolWeights": { [PRIMARY]: 2, [SECONDARY]: 1 } });
			picks.push((await spawn({ id, settings })).resolvedModel);
		}
		expect(picks).toEqual([PRIMARY, PRIMARY, PRIMARY, SECONDARY]);
	});

	it("redraws the same candidate for the same task call and spawn id, so a revived subagent is stable", async () => {
		const first = await spawn({ id: "spawn-mike", settings: weightedSettings() });
		const second = await spawn({ id: "spawn-mike", settings: weightedSettings() });
		expect(first.resolvedModel).toBe(SECONDARY);
		expect(second.resolvedModel).toBe(SECONDARY);
	});

	it("installs the remaining candidates as the spawn's fallback chain after a reorder", async () => {
		const drawn = await spawn({ id: "spawn-mike", settings: weightedSettings() });
		expect(drawn.resolvedModel).toBe(SECONDARY);
		expect(drawn.fallbackChains?.["subagent:spawn-mike"]).toEqual([PRIMARY]);
	});

	it("keeps a zero-weight candidate out of the draw but leaves it in the fallback chain", async () => {
		const settings = weightedSettings({ "retry.poolWeights": { [PRIMARY]: 0 } });
		const drawn = await spawn({ id: "spawn-alpha", settings });
		expect(drawn.resolvedModel).toBe(SECONDARY);
		expect(drawn.fallbackChains?.["subagent:spawn-alpha"]).toEqual([PRIMARY]);
	});

	it("does not consult usage health while the usage gate is off", async () => {
		const drawn = await spawn({ id: "spawn-alpha", settings: weightedSettings() });
		expect(drawn.healthCalls).toEqual([]);
	});

	it("leaves ordered spawns alone once the usage gate is on", async () => {
		// retry.usageAwareFallback shipped before pool selection did, and turning it
		// on must not change how subagents spawn. Ordered selection asks for no
		// health at all, so a depleted first candidate still starts the spawn.
		const settings = Settings.isolated({ "retry.usageAwareFallback": true, "retry.usageReservePolicy": "confirm" });
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY, SECONDARY, TERTIARY],
			health: { [PRIMARY]: "depleted" },
		});
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(drawn.fallbackChains?.["subagent:spawn-alpha"]).toEqual([SECONDARY, TERTIARY]);
		expect(drawn.healthCalls).toEqual([]);
	});

	it("never refuses an ordered spawn under a fail-closed reserve policy", async () => {
		// Same reason: fail-closed spawns are part of weighted pool selection, so an
		// existing fail-closed user sees no new refusals until they opt in. Covers
		// the single-candidate spawn, which has no pool to select from at all.
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		for (const modelOverride of [[PRIMARY, SECONDARY], [PRIMARY]]) {
			for (const state of ["depleted", "reserve"] as const) {
				const drawn = await spawn({ id: "spawn-alpha", settings, modelOverride, health: { [PRIMARY]: state } });
				expect(drawn.error).toBeUndefined();
				expect(drawn.resolvedModel).toBe(PRIMARY);
				expect(drawn.healthCalls).toEqual([]);
			}
		}
	});

	it("puts a measured-depleted candidate behind the healthy ones in the installed chain", async () => {
		// The chain walk in turn-recovery does not consult usage health, so leaving
		// the depleted plan at the head of the chain would burn a retry attempt on a
		// model this spawn already measured as out of quota.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY, SECONDARY, TERTIARY],
			health: { [PRIMARY]: "depleted" },
		});
		expect(drawn.resolvedModel).toBe(SECONDARY);
		expect(drawn.fallbackChains?.["subagent:spawn-alpha"]).toEqual([TERTIARY, PRIMARY]);
	});

	it("demotes a spent candidate even when the draw lands on the configured first one", async () => {
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY, SECONDARY, TERTIARY],
			health: { [SECONDARY]: "reserve" },
		});
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(drawn.fallbackChains?.["subagent:spawn-alpha"]).toEqual([TERTIARY, SECONDARY]);
	});

	it("keeps a candidate whose health is unknown in the draw", async () => {
		const settings = weightedSettings({ "retry.usageAwareFallback": true });
		const drawn = await spawn({ id: "spawn-india", settings, health: { [PRIMARY]: "unknown" } });
		expect(drawn.resolvedModel).toBe(PRIMARY);
	});

	it("falls back to today's first-resolvable pick when every candidate is depleted", async () => {
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		const drawn = await spawn({
			id: "spawn-mike",
			settings,
			health: { [PRIMARY]: "depleted", [SECONDARY]: "depleted" },
		});
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(drawn.error).toBeUndefined();
	});

	it("excludes a depleted candidate the weighted draw would otherwise pick", async () => {
		const drawn = await spawn({
			id: "spawn-mike",
			settings: weightedSettings({ "retry.usageAwareFallback": true }),
			health: { [SECONDARY]: "depleted" },
		});
		// spawn-mike draws SECONDARY when both are healthy.
		expect(drawn.resolvedModel).toBe(PRIMARY);
	});

	it("lets a weighted spawn under fail-closed start on the healthy candidate the draw picks", async () => {
		// fail-closed guards the candidate the spawn actually starts on, not the
		// configured first one. The draw routes around the depleted plan, so the
		// spawn runs. This matches the startup path, which reorders before the
		// shipped preflight reads the first pattern.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const drawn = await spawn({ id: "spawn-mike", settings, health: { [PRIMARY]: "depleted" } });
		expect(drawn.error).toBeUndefined();
		expect(drawn.resolvedModel).toBe(SECONDARY);
	});

	it("refuses a weighted spawn under fail-closed when only a zero-weight candidate is healthy", async () => {
		// Nothing is drawable here: the first candidate is depleted and the second
		// weighs 0. A weight of 0 keeps a candidate as an ordered fallback, it does
		// not make it the primary, so the configured order stands and fail-closed
		// checks the depleted first candidate. Promoting the zero-weight candidate
		// instead would let weighted selection quietly defeat fail-closed.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
			"retry.poolWeights": { [SECONDARY]: 0 },
		});
		const drawn = await spawn({ id: "spawn-alpha", settings, health: { [PRIMARY]: "depleted" } });
		expect(drawn.error).toBe(`Usage depleted for ${PRIMARY}; reserve policy is fail-closed.`);
		expect(drawn.resolvedModel).not.toBe(SECONDARY);
	});

	it("starts a weighted spawn on the zero-weight fallback when the policy is not fail-closed", async () => {
		// Same undrawable pool under `confirm`. The configured order stands, so the
		// spawn starts on the depleted first candidate exactly as it does today,
		// with the zero-weight candidate behind it in the chain.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
			"retry.poolWeights": { [SECONDARY]: 0 },
		});
		const drawn = await spawn({ id: "spawn-alpha", settings, health: { [PRIMARY]: "depleted" } });
		expect(drawn.error).toBeUndefined();
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(drawn.fallbackChains?.["subagent:spawn-alpha"]).toEqual([SECONDARY]);
	});

	it("fails a weighted spawn under fail-closed when every candidate is depleted", async () => {
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const drawn = await spawn({
			id: "spawn-mike",
			settings,
			health: { [PRIMARY]: "depleted", [SECONDARY]: "reserve" },
		});
		expect(drawn.error).toBe(
			`Usage depleted or in reserve for every candidate in the pool (${PRIMARY}, ${SECONDARY}); reserve policy is fail-closed.`,
		);
		expect(drawn.error).not.toContain("at ");
	});

	it("fails a single-candidate weighted spawn under fail-closed when its quota is spent", async () => {
		// A bundled agent that resolves to one model has nowhere to fall back to,
		// but fail-closed still refuses to spend the reserve.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY],
			health: { [PRIMARY]: "depleted" },
		});
		expect(drawn.error).toBe(`Usage depleted for ${PRIMARY}; reserve policy is fail-closed.`);
	});

	it("fails a single-candidate weighted spawn under fail-closed when its quota is in reserve", async () => {
		// Reserve is its own refusal, distinct from depleted.
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY],
			health: { [PRIMARY]: "reserve" },
		});
		expect(drawn.error).toBe(`Usage reserve reached for ${PRIMARY}; reserve policy is fail-closed.`);
	});

	it("runs a single-candidate spawn on a depleted model under confirm, since spawns never prompt", async () => {
		const settings = weightedSettings({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		const drawn = await spawn({
			id: "spawn-alpha",
			settings,
			modelOverride: [PRIMARY],
			health: { [PRIMARY]: "depleted" },
		});
		expect(drawn.error).toBeUndefined();
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(drawn.healthCalls).toEqual([]);
	});

	it("skips a candidate the registry has no credentials for", async () => {
		// spawn-mike draws SECONDARY when both candidates are usable. Without
		// credentials SECONDARY is not available, so it never enters the pool and
		// never reaches the subagent's fallback chain either.
		const drawn = await spawn({
			id: "spawn-mike",
			settings: weightedSettings(),
			unauthenticated: [SECONDARY],
		});
		expect(drawn.resolvedModel).toBe(PRIMARY);
		expect(JSON.stringify(drawn.fallbackChains ?? {})).not.toContain(SECONDARY);
	});
});
