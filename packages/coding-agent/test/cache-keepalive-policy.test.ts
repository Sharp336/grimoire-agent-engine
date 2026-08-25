/**
 * Session wiring for the provider prompt-cache keepalive.
 *
 * The keepalive spends real money replaying a cached prefix, so the session must answer one
 * question honestly: is work still running that this session will resume from? That is NOT
 * the same question `hasPendingAsyncWork()` answers, and the difference is the whole reason
 * `hasRunningOwnedAsyncWork()` and `willResumeFromCurrentPrefix()` exist. The last describe
 * covers the other side of the same coin: how much money the keepalive is allowed to spend
 * by default.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { CACHE_KEEPALIVE_STATE_KEY } from "@oh-my-pi/pi-ai/cache/keepalive";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, createCacheKeepalivePolicy } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi();

interface Harness {
	session: AgentSession;
	manager: AsyncJobManager;
	mock: MockModel;
	calls: () => number;
}

describe("prompt-cache keepalive session wiring", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		AsyncJobManager.resetForTests();
	});

	async function createHarness(options?: {
		agentId?: string;
		usage?: Partial<Omit<Usage, "cost">>;
		tools?: AgentTool[];
		mock?: MockModel;
	}): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock =
			options?.mock ??
			createMockModel({
				handler: () => ({ content: ["Done"], usage: options?.usage }),
			});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: options?.tools ?? [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: options?.agentId ?? "Main",
			ownedAsyncJobManager: manager,
		});
		sessions.push(session);
		return { session, manager, mock, calls: () => mock.calls.length };
	}

	it("stays armed while an owned job runs under a blocking hub wait, where hasPendingAsyncWork() is false", async () => {
		const { session, manager } = await createHarness();
		const gate = Promise.withResolvers<string>();
		manager.register("task", "subagent fan-out", () => gate.promise, {
			id: "fanout-job",
			ownerId: "Main",
		});
		// The `hub wait` shape: the job is still running AND its delivery is suppressed,
		// because a foreground wait is watching it and will consume the result itself.
		manager.watchJobs(["fanout-job"]);
		expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(1);
		expect(manager.isDeliverySuppressed("fanout-job")).toBe(true);

		// Existing semantics, asserted so a change here is caught rather than assumed:
		// `hasPendingAsyncWork()` means "will the loop re-wake by itself?", and a suppressed
		// delivery never wakes it. Wiring the cache lease to this predicate would switch the
		// keepalive OFF during the exact 10-40 minute gap it exists to cover — the parent
		// parked in `hub wait` on a subagent fan-out, holding a prefix it is certain to reuse.
		expect(session.hasPendingAsyncWork()).toBe(false);

		// The lease predicate asks the other question and answers yes.
		expect(session.hasRunningOwnedAsyncWork()).toBe(true);

		gate.resolve("fan-out done");
	});

	it("reports no running owned work for a finished turn, and reports work while a delivered result awaits injection", async () => {
		const { session, manager } = await createHarness();
		// Nothing has ever run: a finished turn must not be kept warm.
		expect(session.hasRunningOwnedAsyncWork()).toBe(false);

		manager.register("task", "quick job", async () => "RESULT", { id: "quick-job", ownerId: "Main" });
		await manager.waitForOwnerJobs("Main");
		await manager.drainDeliveries({ filter: { ownerId: "Main" } });

		// The job is finished, but its result is queued on the yield queue awaiting injection
		// as a follow-up turn. That turn will replay this exact prefix, so the cache is still
		// worth holding — treating this as idle would drop the entry one tick before the
		// request that would have read it.
		expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(0);
		expect(session.hasRunningOwnedAsyncWork()).toBe(true);

		// Consuming the follow-up turn is what actually ends the chain.
		await session.settleAsyncWork();
		expect(session.hasRunningOwnedAsyncWork()).toBe(false);
	});

	it("does not report running work for a job owned by a different agent", async () => {
		const { session, manager } = await createHarness({ agentId: "Main" });
		const gate = Promise.withResolvers<string>();
		manager.register("task", "sibling work", () => gate.promise, {
			id: "sibling-job",
			ownerId: "SiblingAgent",
		});
		// The job really is running — so a `false` below is owner scoping, not a dead job.
		expect(manager.getRunningJobs()).toHaveLength(1);

		// Without owner scoping every session in the process would keep its prefix warm for
		// the duration of any sibling's background work, spending on caches nobody will read.
		expect(session.hasRunningOwnedAsyncWork()).toBe(false);

		gate.resolve("sibling done");
	});

	it("prices the lease from session state: 0.95 while owned work runs, 0 when idle", async () => {
		const { session, manager } = await createHarness();
		const policy = createCacheKeepalivePolicy(() => session);

		// Idle: 0 is the economic gate's stop signal, so the chain ends after a finished turn.
		expect(policy.resumeProbability()).toBe(0);

		const gate = Promise.withResolvers<string>();
		manager.register("task", "subagent fan-out", () => gate.promise, {
			id: "policy-job",
			ownerId: "Main",
		});
		manager.watchJobs(["policy-job"]);

		// Read fresh at every touch, not memoized at construction — and high even though the
		// watched delivery makes `hasPendingAsyncWork()` false.
		expect(policy.resumeProbability()).toBeCloseTo(0.95, 10);

		gate.resolve("fan-out done");
		await manager.waitForOwnerJobs("Main");
		manager.unwatchJobs(["policy-job"]);
		manager.acknowledgeDeliveries(["policy-job"]);
		manager.evictCompletedJobs({ ownerId: "Main" });
		expect(policy.resumeProbability()).toBe(0);
	});

	it("keeps the lease priced while a long FOREGROUND tool call runs with no async job in sight", async () => {
		// Failure mode: `resumeProbability()` reads only the async-job manager, so an agent
		// parked in a synchronous 20-minute build or test run reports 0 — the chain stops, the
		// entry expires, and the very next request (the one that reads the tool's output) pays
		// a full cache rebuild. The tool's own runtime is precisely the gap the keepalive is
		// for.
		const toolRunning = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const build: AgentTool = {
			name: "slow_build",
			label: "Slow Build",
			description: "A foreground build that outlives the cache TTL",
			parameters: type({}),
			execute: async () => {
				toolRunning.resolve();
				await release.promise;
				return { content: [{ type: "text" as const, text: "build ok" }] };
			},
		};
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", name: "slow_build", arguments: {} }] }],
			handler: () => ({ content: ["Done"] }),
		});
		const { session, manager } = await createHarness({ tools: [build], mock });
		const policy = createCacheKeepalivePolicy(() => session);

		const turn = session.sendUserMessage("build it");
		await toolRunning.promise;

		// Nothing background is in play: no running job, no queued delivery. This is the
		// state that used to price the lease at 0.
		expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(0);
		expect(session.hasRunningOwnedAsyncWork()).toBe(false);
		// The loop is still mid-turn and will issue the tool-result request the moment the
		// build returns, so the prefix is certain to be reused.
		expect(session.willResumeFromCurrentPrefix()).toBe(true);
		expect(policy.resumeProbability()).toBeCloseTo(0.95, 10);

		release.resolve();
		await turn;

		// And a genuinely finished turn still stops the chain: the in-flight leg must not
		// latch, or every session would keep paying for a prefix nobody will read again.
		expect(session.isStreaming).toBe(false);
		expect(session.willResumeFromCurrentPrefix()).toBe(false);
		expect(policy.resumeProbability()).toBe(0);
	});

	it("reports the provider-measured cached prefix size, and 0 rather than a guess when nothing was measured", async () => {
		const { session, calls } = await createHarness({ usage: { cacheRead: 12_000, cacheWrite: 3_000 } });
		const policy = createCacheKeepalivePolicy(() => session);

		// No request has completed, so there is no measurement. 0 makes the economic gate
		// report `skip-unknown-pricing` instead of pricing a made-up prefix.
		expect(policy.prefixTokens()).toBe(0);

		await session.sendUserMessage("hello");
		expect(calls()).toBeGreaterThan(0);

		// cacheRead + cacheWrite is the provider's own report of how much of this
		// conversation it cached — the quantity the keepalive is protecting.
		expect(policy.prefixTokens()).toBe(15_000);
	});

	it("cancels the keepalive when a model change replaces the prefix, without touching unrelated provider state", async () => {
		const { session } = await createHarness();
		let keepaliveCloses = 0;
		let unrelatedCloses = 0;
		session.providerSessionState.set(CACHE_KEEPALIVE_STATE_KEY, {
			close: () => {
				keepaliveCloses += 1;
			},
		});
		session.providerSessionState.set("openai-completions:acme:https://acme.test:m", {
			close: () => {
				unrelatedCloses += 1;
			},
		});

		await session.setModelTemporary(getBundledModel("anthropic", "claude-opus-4-5")!);

		// A keepalive must never outlive the prefix it protects: the next request goes to a
		// different model, so the cached entry is unreachable and every further touch is spend
		// against something nobody can read.
		expect(keepaliveCloses).toBe(1);
		// Dropping the state also un-anchors the chain, so the next real request arms a fresh
		// one instead of resuming the dead lease.
		expect(session.providerSessionState.has(CACHE_KEEPALIVE_STATE_KEY)).toBe(false);
		// Targeted, not a blanket wipe — an unrelated completions session keeps its cached
		// strict-tools/reasoning-effort decisions across an Anthropic model swap.
		expect(unrelatedCloses).toBe(0);
	});

	it("cancels the keepalive when a history rewrite replaces the prefix", async () => {
		const { session } = await createHarness();
		let keepaliveCloses = 0;
		session.providerSessionState.set(CACHE_KEEPALIVE_STATE_KEY, {
			close: () => {
				keepaliveCloses += 1;
			},
		});
		session.sessionManager.appendCustomMessageEntry(
			"test",
			[
				{ type: "text", text: "screenshot" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			false,
		);

		// `dropImages` is one of the maintenance paths (with compaction apply, shake, rewind,
		// compaction rebuild) that funnel through the session's history-rewrite choke point.
		expect(await session.dropImages()).toEqual({ removed: 1 });

		// The rewritten branch produces different wire bytes, so the cached entry the chain
		// was holding is gone and touching it would pay cache-write price for nothing.
		expect(keepaliveCloses).toBe(1);
		expect(session.providerSessionState.has(CACHE_KEEPALIVE_STATE_KEY)).toBe(false);
	});

	it("cancels the keepalive when a new transcript starts", async () => {
		const { session } = await createHarness();
		let keepaliveCloses = 0;
		session.providerSessionState.set(CACHE_KEEPALIVE_STATE_KEY, {
			close: () => {
				keepaliveCloses += 1;
			},
		});

		expect(await session.newSession()).toBe(true);

		// No dedicated hook here: session switch / branch / new transcript already funnel
		// through the blanket provider-session teardown. Asserted so that path staying the
		// keepalive's cancel is a checked property rather than an assumption — a refactor that
		// made the teardown selective would silently leave a chain warming a dead prefix.
		expect(keepaliveCloses).toBe(1);
		expect(session.providerSessionState.has(CACHE_KEEPALIVE_STATE_KEY)).toBe(false);
	});

	it("returns a stopped lease before the session exists, so construction order cannot arm a chain", () => {
		// `createAgentSession` builds the policy before `new AgentSession(...)` runs. A throw
		// or a non-zero probability in that window would either break startup or warm a cache
		// for a session that does not exist yet.
		const policy = createCacheKeepalivePolicy(() => undefined);
		expect(policy.resumeProbability()).toBe(0);
		expect(policy.prefixTokens()).toBe(0);
	});
});

/**
 * The economic lease replaces a fixed 3-touch budget (~19 minutes) with up to 24 touches
 * (~114 minutes) of billed replays, so it must not arrive as the default. These drive the
 * real `createAgentSession` wiring and inspect the options that reach the provider.
 */
describe("prompt-cache keepalive opt-in", () => {
	async function policyReachingProvider(cacheKeepalive?: "legacy" | "economic"): Promise<unknown> {
		using dir = TempDir.createSync("@omp-cache-keepalive-optin-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			const mock = createMockModel({ id: "keepalive-optin", handler: () => ({ content: ["Done"] }) });
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: mock,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.enabled": false,
					"retry.enabled": false,
					...(cacheKeepalive === undefined ? {} : { "providers.cacheKeepalive": cacheKeepalive }),
				}),
				sessionManager: SessionManager.inMemory(dir.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			try {
				await session.prompt("hello");
				expect(mock.calls).not.toHaveLength(0);
				return mock.calls[0]?.options?.cacheKeepalivePolicy;
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
		}
	}

	it("defaults to legacy, so an unconfigured install keeps the fixed 3-touch budget", async () => {
		// THE failure mode this setting exists for: shipping the lease unconditionally raises
		// every session's keepalive spend — 24 billed touches where there were 3 — with no
		// maintainer decision recorded anywhere.
		expect(Settings.isolated().get("providers.cacheKeepalive")).toBe("legacy");
		// No policy in the provider options means `CacheKeepaliveState.arm` takes the
		// LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES branch, which is the pre-existing behavior.
		expect(await policyReachingProvider()).toBeUndefined();
	});

	it("supplies the policy only when the setting opts in", async () => {
		// The other half: an opt-in nobody can turn on is just a removal. The policy has to
		// reach the provider layer when asked for.
		expect(await policyReachingProvider("legacy")).toBeUndefined();
		expect(await policyReachingProvider("economic")).toBeDefined();
	});
});
