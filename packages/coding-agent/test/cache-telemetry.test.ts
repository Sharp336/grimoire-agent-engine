import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveTtl } from "@oh-my-pi/pi-ai/cache";
import type { CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createCacheKeepalivePolicy } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CacheObservation,
	CacheTelemetryStore,
	resolveCacheTelemetryRoute,
} from "@oh-my-pi/pi-coding-agent/session/cache-telemetry";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * The journal path is injected rather than stubbed through `getStatsDbPath`: the store
 * already takes it as a constructor parameter (the same seam
 * `createSnapcompactSavingsRecorder` uses), so no real `~/.omp` file is reachable from
 * these tests and no module-level spy has to be installed or undone.
 */
async function tmpJournal(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-telemetry-"));
	return path.join(dir, "cache-observations.jsonl");
}

const BASE_AT = 1_760_000_000_000;

function model(): Model {
	return buildModel({
		id: "claude-test",
		name: "claude-test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function observation(overrides: Partial<CacheObservation> = {}): CacheObservation {
	return {
		at: BASE_AT,
		kind: "request",
		fingerprint: "fp-a",
		routeKey: "route-a",
		outcome: "confirmed-hit",
		cacheRead: 12_000,
		cacheWrite: 0,
		inputTokens: 12_400,
		costUsd: 0.0123,
		sessionId: "opaque-session-id",
		...overrides,
	};
}

describe("cache telemetry store", () => {
	it("round-trips an observation's numbers and outcome through the journal", async () => {
		// Failure mode: a recorded observation that cannot be read back is telemetry
		// that exists only in the writer's imagination.
		const store = new CacheTelemetryStore(await tmpJournal());
		await store.recordObservation(observation({ outcome: "miss-rebuilt", cacheRead: 0, cacheWrite: 9_100 }));

		const rows = await store.readObservations();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			at: BASE_AT,
			kind: "request",
			fingerprint: "fp-a",
			routeKey: "route-a",
			outcome: "miss-rebuilt",
			cacheRead: 0,
			cacheWrite: 9_100,
			inputTokens: 12_400,
			costUsd: 0.0123,
			sessionId: "opaque-session-id",
		});
		// The first observation of a fingerprint has no predecessor to difference
		// against, so the gap must be absent rather than 0.
		expect(rows[0]?.idleSeconds).toBeUndefined();
	});

	it("keys the idle gap on fingerprint, so interleaved prefixes never contaminate each other", async () => {
		// Failure mode this keying exists for: gaps keyed on route would measure the
		// distance to whichever *other* prefix was observed most recently, inventing
		// short lifetimes for a cache that was never probed.
		const store = new CacheTelemetryStore(await tmpJournal());
		await store.recordObservation(observation({ fingerprint: "fp-a", at: BASE_AT }));
		await store.recordObservation(observation({ fingerprint: "fp-b", at: BASE_AT + 1_000 }));
		await store.recordObservation(observation({ fingerprint: "fp-a", at: BASE_AT + 5_000 }));
		await store.recordObservation(observation({ fingerprint: "fp-b", at: BASE_AT + 9_000 }));

		const rows = await store.readObservations();
		expect(rows.map(row => [row.fingerprint, row.idleSeconds])).toEqual([
			["fp-a", undefined],
			["fp-b", undefined],
			// 5s back to fp-a's own previous row, not 4s back to fp-b's.
			["fp-a", 5],
			// 8s back to fp-b's own previous row, not 4s back to fp-a's.
			["fp-b", 8],
		]);
	});

	it("narrows the TTL interval from a hit then a miss on the same route", async () => {
		// Failure mode: rows that persist but never fold leave `resolveTtl` with no
		// interval, so the keepalive keeps scheduling against a hardcoded default.
		const store = new CacheTelemetryStore(await tmpJournal());
		await store.recordObservation(observation({ outcome: "confirmed-hit", idleSeconds: 180 }));
		await store.recordObservation(
			observation({ at: BASE_AT + 1, outcome: "miss-rebuilt", cacheRead: 0, cacheWrite: 9_000, idleSeconds: 300 }),
		);

		const profile = await store.loadProfile("route-a");
		expect(profile).toBeDefined();
		// Proven alive at 180s, proven dead by 300s: the usable lifetime is inside.
		expect(profile?.lowerBoundS).toBeGreaterThanOrEqual(180);
		expect(profile?.upperBoundS).toBeLessThanOrEqual(300);
	});

	it("engages the learned TTL tier only once the profile clears the evidence gate", async () => {
		// Failure mode: the loop looks wired but never actually changes a decision,
		// which is exactly the dead-telemetry state this work exists to end.
		const store = new CacheTelemetryStore(await tmpJournal());
		for (let index = 0; index < 3; index++) {
			await store.recordObservation(
				observation({ at: BASE_AT + index, outcome: "confirmed-hit", idleSeconds: 120 + index * 10 }),
			);
		}

		const thin = await store.loadProfile("route-a");
		expect(thin?.sampleCount).toBe(3);
		// Three samples is enough count but not enough confidence, so the default tier
		// still wins — the gate is not decorative.
		expect(resolveTtl({ profile: thin, defaultS: 300 }).source).toBe("default");

		await store.recordObservation(observation({ at: BASE_AT + 3, outcome: "confirmed-hit", idleSeconds: 150 }));

		const learned = await store.loadProfile("route-a");
		const resolved = resolveTtl({ profile: learned, defaultS: 300 });
		expect(resolved.source).toBe("learned");
		// The learned value is the observed lower bound, not the 300s default.
		expect(resolved.ttlS).toBe(150);
	});

	it("skips malformed and truncated lines while still loading the valid rows around them", async () => {
		// Failure mode: one torn line from a killed process poisoning every later read,
		// which would take the keepalive's whole learned history with it.
		const journal = await tmpJournal();
		await fs.mkdir(path.dirname(journal), { recursive: true });
		const first = JSON.stringify(observation({ fingerprint: "fp-a", idleSeconds: 200 }));
		const second = JSON.stringify(
			observation({ fingerprint: "fp-b", at: BASE_AT + 1, outcome: "miss-rebuilt", idleSeconds: 400 }),
		);
		// A corrupt line, then a valid row, then a final line torn mid-append (no
		// trailing newline) — the three shapes a crashed or interleaved writer leaves.
		await Bun.write(journal, `${first}\n{"at":123,"kind":"req\n${second}\n{"at":999,"kind":"requ`);

		const store = new CacheTelemetryStore(journal);
		const rows = await store.readObservations();
		expect(rows.map(row => row.fingerprint)).toEqual(["fp-a", "fp-b"]);

		const profile = await store.loadProfile("route-a");
		expect(profile?.sampleCount).toBe(2);
		expect(profile?.lowerBoundS).toBe(200);
		expect(profile?.upperBoundS).toBe(400);
	});

	it("swallows a write failure instead of propagating it into the caller", async () => {
		// Failure mode: telemetry costing a turn. The request path awaits this call, so
		// a rejection here would surface as a failed assistant message.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-telemetry-fail-"));
		// A regular file where a directory must be: mkdir/appendFile fail with ENOTDIR,
		// a real I/O failure rather than a mocked one.
		const blocker = path.join(dir, "not-a-directory");
		await Bun.write(blocker, "x");
		const store = new CacheTelemetryStore(path.join(blocker, "cache-observations.jsonl"));

		await expect(store.recordObservation(observation())).resolves.toBeUndefined();
		// And the store stays usable: a failed write leaves no partial state behind.
		expect(await store.readObservations()).toEqual([]);
	});

	it("does not let success-unverified rows inflate the sample count", async () => {
		// Failure mode: counting "HTTP 200 with no cache buckets" as proof of a hit,
		// which would clear the evidence gate on rows that measured nothing.
		const store = new CacheTelemetryStore(await tmpJournal());
		await store.recordObservation(observation({ outcome: "confirmed-hit", idleSeconds: 100 }));
		await store.recordObservation(observation({ at: BASE_AT + 1, outcome: "confirmed-hit", idleSeconds: 110 }));
		for (let index = 0; index < 3; index++) {
			await store.recordObservation(
				observation({
					at: BASE_AT + 2 + index,
					outcome: "success-unverified",
					cacheRead: 0,
					cacheWrite: 0,
					idleSeconds: 500 + index,
				}),
			);
		}

		const profile = await store.loadProfile("route-a");
		// Five rows, two of them evidence.
		expect(await store.readObservations()).toHaveLength(5);
		expect(profile?.sampleCount).toBe(2);
		// An unverified row must not move a bound either: 500s+ never becomes a proven
		// lifetime just because the request succeeded.
		expect(profile?.lowerBoundS).toBe(110);
		expect(profile?.upperBoundS).toBeUndefined();
	});

	it("resolves a route key for cacheable retention and none at all for retention none", async () => {
		// Failure mode: recording observations for `retention: "none"`, where no provider
		// entry exists — every such row is a fabricated lifetime sample.
		const short = resolveCacheTelemetryRoute(model(), "auto");
		expect(short?.retention).toBe("short");
		expect(short?.endpoint).toBe("https://api.anthropic.com/v1");
		expect(short?.routeKey).toMatch(/^[0-9a-f]{64}$/);

		// "auto" resolves to the same route as an explicit "short": they name one entry.
		expect(resolveCacheTelemetryRoute(model(), "short")?.routeKey).toBe(short?.routeKey);
		// A different retention is a different physical cache, so a different profile.
		expect(resolveCacheTelemetryRoute(model(), "long")?.routeKey).not.toBe(short?.routeKey);
		expect(resolveCacheTelemetryRoute(model(), "none")).toBeUndefined();
	});

	it("bounds journal growth by rotating down to the most recent tail", async () => {
		// Failure mode: an append-only journal on every assistant message and every touch
		// growing without limit on a long-lived install. The bound has to be real, not a
		// comment claiming reads are cheap.
		const journal = await tmpJournal();
		await fs.mkdir(path.dirname(journal), { recursive: true });
		const padding = "x".repeat(1_000);
		const lines = Array.from({ length: 5_000 }, (_unused, index) =>
			JSON.stringify(observation({ at: BASE_AT + index, fingerprint: `fp-${index}`, sessionId: padding })),
		);
		await Bun.write(journal, `${lines.join("\n")}\n`);
		const before = (await fs.stat(journal)).size;
		expect(before).toBeGreaterThan(4 * 1024 * 1024);

		const store = new CacheTelemetryStore(journal);
		await store.recordObservation(observation({ at: BASE_AT + 5_000, fingerprint: "fp-newest" }));

		const after = (await fs.stat(journal)).size;
		expect(after).toBeLessThan(before);
		expect(after).toBeLessThan(1024 * 1024);

		const rows = await store.readObservations();
		// The tail is what survives, and every surviving line parses — the leading partial
		// line created by slicing mid-record must be dropped, not fed to the profile fold.
		expect(rows.length).toBeGreaterThan(100);
		expect(rows[rows.length - 1]?.fingerprint).toBe("fp-newest");
		expect(rows.some(row => row.fingerprint === "fp-0")).toBe(false);
	});
});

/**
 * The store working in isolation does not prove the keepalive consults it. These drive the
 * real policy object against a real `AgentSession`, with an injected store so nothing
 * touches `~/.omp`.
 */
describe("cache telemetry keepalive wiring", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function createSession(): Promise<AgentSession> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: bundled, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		sessions.push(session);
		return session;
	}

	/** A real `WarmDecision`, so the record matches what the keepalive actually emits. */
	function warmDecision(): CacheKeepaliveRecord["decision"] {
		return {
			action: "warm",
			shouldWarm: true,
			reason: "due-and-economically-positive",
			coldResumeCostUsd: 0.75,
			cachedResumeCostUsd: 0.06,
			avoidableLossUsd: 0.69,
			expectedValueUsd: 0.6555,
			nextWarmCostUsd: 0.060025,
			maxWarmBudgetUsd: 0.45885,
			remainingBudgetUsd: 0.45885,
		};
	}

	function decision(overrides: Partial<CacheKeepaliveRecord> = {}): CacheKeepaliveRecord {
		return {
			fingerprint: "keepalive-fp",
			decision: warmDecision(),
			outcome: "confirmed-hit",
			idleSeconds: 240,
			cacheRead: 11_000,
			cacheWrite: 0,
			costUsd: 0.0004,
			touchIndex: 1,
			at: BASE_AT,
			...overrides,
		};
	}

	it("persists an issued touch against the session's route", async () => {
		// Failure mode this whole ticket exists for: `onDecision` that only debug-logs, so
		// every touch the keepalive issues is forgotten the moment it is made.
		const session = await createSession();
		const store = new CacheTelemetryStore(await tmpJournal());
		const policy = createCacheKeepalivePolicy(() => session, store);

		policy.onDecision?.(decision());
		// `onDecision` floats the append; `settle` awaits the real work rather than a guess.
		await store.settle();

		const rows = await store.readObservations();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("touch");
		expect(rows[0]?.outcome).toBe("confirmed-hit");
		expect(rows[0]?.cacheRead).toBe(11_000);
		// The chain's own measurement of the entry's age survives, including for the first
		// touch of a chain where the journal has no predecessor to difference against.
		expect(rows[0]?.idleSeconds).toBe(240);
		// Filed under the session's real route, so ordinary requests and touches on the same
		// model/retention accumulate into one profile.
		const route = resolveCacheTelemetryRoute(session.model!, "auto");
		expect(route).toBeDefined();
		expect(rows[0]?.routeKey).toBe(route!.routeKey);
	});

	it("does not persist a skipped decision, which observed nothing", async () => {
		// Failure mode: a skip recorded as an observation invents cache evidence out of a
		// request that was never sent.
		const session = await createSession();
		const store = new CacheTelemetryStore(await tmpJournal());
		const policy = createCacheKeepalivePolicy(() => session, store);

		policy.onDecision?.(decision({ outcome: undefined, cacheRead: 0, costUsd: 0 }));
		// `onDecision` starts any append synchronously, so an empty in-flight set here means
		// no write was ever attempted — not that one is still pending.
		await store.settle();

		expect(await store.readObservations()).toEqual([]);
	});

	it("schedules against the nominal default until the route has learned evidence, then against the learned TTL", async () => {
		// THE test for this work: the loop must actually change a keepalive decision.
		// Without it, every primitive can be wired and the schedule still never moves.
		const session = await createSession();
		const journal = await tmpJournal();
		const route = resolveCacheTelemetryRoute(session.model!, "auto")!;

		// Four confirmed hits at 150s idle: enough samples AND enough confidence for
		// `resolveTtl` to prefer the learned interval over the 300s nominal lifetime.
		await fs.mkdir(path.dirname(journal), { recursive: true });
		const seeded = Array.from({ length: 4 }, (_unused, index) =>
			JSON.stringify(
				observation({
					at: BASE_AT + index,
					kind: "request",
					routeKey: route.routeKey,
					outcome: "confirmed-hit",
					idleSeconds: 150,
				}),
			),
		);
		await Bun.write(journal, `${seeded.join("\n")}\n`);

		// Capture the profile read the policy performs so the test awaits that exact promise
		// instead of a wall-clock delay. The `.then` handler inside the policy was attached
		// first, so it has already run once this promise resolves.
		const store = new CacheTelemetryStore(journal);
		const reads: Array<Promise<unknown>> = [];
		const loadProfile = store.loadProfile.bind(store);
		spyOn(store, "loadProfile").mockImplementation(routeKey => {
			const read = loadProfile(routeKey);
			reads.push(read);
			return read;
		});
		const policy = createCacheKeepalivePolicy(() => session, store);

		// Before any chain has armed, no profile has been read, so the policy reports the
		// same nominal lifetime the keepalive uses when `ttlSeconds` is omitted.
		expect(policy.ttlSeconds).toBe(300);

		// Arming a chain (touchIndex 1) is what triggers the single profile read.
		policy.onDecision?.(decision({ fingerprint: "chain-1" }));
		expect(reads).toHaveLength(1);
		await reads[0];

		// The learned lower bound, not the default: the feedback loop is closed.
		expect(policy.ttlSeconds).toBe(150);

		// Later touches in the SAME chain must not re-read: that is the "once per armed
		// chain" bound, and without it every touch would re-parse the journal.
		policy.onDecision?.(decision({ fingerprint: "chain-1", touchIndex: 2 }));
		policy.onDecision?.(decision({ fingerprint: "chain-1", touchIndex: 3 }));
		expect(reads).toHaveLength(1);

		// A newly armed chain does read again — that is how evidence recorded since the
		// last chain reaches the schedule.
		policy.onDecision?.(decision({ fingerprint: "chain-2", touchIndex: 1 }));
		expect(reads).toHaveLength(2);
	});

	it("falls back to the nominal default when there is no session to resolve a route from", async () => {
		// Failure mode: the policy is built before the session exists, so a getter that
		// assumed one would throw into the keepalive's scheduling path.
		const store = new CacheTelemetryStore(await tmpJournal());
		const policy = createCacheKeepalivePolicy(() => undefined, store);

		expect(policy.ttlSeconds).toBe(300);
		// And a decision arriving in that window is dropped rather than filed under a
		// fabricated route.
		policy.onDecision?.(decision());
		await store.settle();
		expect(await store.readObservations()).toEqual([]);
	});
});
