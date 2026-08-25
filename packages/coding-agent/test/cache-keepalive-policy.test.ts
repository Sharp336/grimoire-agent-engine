/**
 * Session wiring for the provider prompt-cache keepalive.
 *
 * The keepalive spends real money replaying a cached prefix, so the session must answer one
 * question honestly: is work still running that this session will resume from? That is NOT
 * the same question `hasPendingAsyncWork()` answers, and the difference is the whole reason
 * `hasRunningOwnedAsyncWork()` exists.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { CACHE_KEEPALIVE_STATE_KEY } from "@oh-my-pi/pi-ai/cache/keepalive";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createCacheKeepalivePolicy } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface Harness {
	session: AgentSession;
	manager: AsyncJobManager;
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
	}): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"], usage: options?.usage }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
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
		return { session, manager, calls: () => mock.calls.length };
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
