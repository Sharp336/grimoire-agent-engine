import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	cacheFingerprint,
	MIN_CACHE_FOOTPRINT,
	normalizeEndpoint,
	orderedHash,
	resolveTtl,
	routeProfileKey,
	structuralHash,
} from "@oh-my-pi/pi-ai/cache";
import type { CacheKeepaliveRecord } from "@oh-my-pi/pi-ai/cache/keepalive";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
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
	cacheTelemetryStore,
	resolveCacheTelemetryRoute,
} from "@oh-my-pi/pi-coding-agent/session/cache-telemetry";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import { $env, getSessionsDir } from "@oh-my-pi/pi-utils";

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

function model(baseUrl = "https://api.anthropic.com/v1"): Model {
	return buildModel({
		id: "claude-test",
		name: "claude-test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

/**
 * A non-Anthropic route, used to prove the effective-endpoint resolution stays scoped.
 * `moonshot` specifically because its transport DOES honour an env base-url override
 * (`MOONSHOT_BASE_URL`, `providers/openai-shared.ts`) that this layer deliberately does
 * not resolve — so if someone later widens the Anthropic fix generically, this model is
 * the one whose key would move.
 */
function moonshotModel(): Model {
	return buildModel({
		id: "kimi-test",
		name: "kimi-test",
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
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

/**
 * Install per-test isolation for the env vars `resolveAnthropicBaseUrl` consults, and
 * return the setter tests use to pose as a gateway. Returned rather than exported as
 * bare state so each `describe` gets its own save table and hooks.
 *
 * Values are CLEARED on entry, not merely recorded: `resolveCacheTelemetryRoute` now
 * resolves the effective endpoint from these, so a developer or CI runner with a real
 * gateway exported would otherwise decide the expected route keys and the suite would
 * go green or red by accident of the shell it ran in. They are restored afterwards
 * because `$env` is `Bun.env` — one mutable table shared by every later test file in
 * the same bun process.
 */
function useHermeticEndpointEnv(): (name: string, value: string | undefined) => void {
	const endpointEnv = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "FOUNDRY_BASE_URL"] as const;
	const saved = new Map<string, string | undefined>();
	const setEnv = (name: string, value: string | undefined): void => {
		if (!saved.has(name)) saved.set(name, $env[name]);
		if (value === undefined) delete $env[name];
		else $env[name] = value;
	};

	beforeEach(() => {
		for (const name of endpointEnv) setEnv(name, undefined);
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete $env[name];
			else $env[name] = value;
		}
		saved.clear();
	});

	return setEnv;
}

describe("cache telemetry store", () => {
	// The route assertions below name the official endpoint, which is only the effective
	// one when no gateway is exported. Without this the suite passes or fails by accident
	// of the runner's shell.
	useHermeticEndpointEnv();
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
 * The route key persists TTL evidence, so it has to name the endpoint the request will
 * actually reach. For Anthropic that is not always `model.baseUrl`: `FOUNDRY_BASE_URL`
 * and `ANTHROPIC_BASE_URL` redirect a model whose configured `baseUrl` is unset or the
 * bundled official URL (`providers/anthropic.ts` `resolveAnthropicBaseUrl`).
 */
describe("cache telemetry route effective endpoint", () => {
	const setEnv = useHermeticEndpointEnv();
	/** The key the pre-`effectiveEndpoint` code produced: keyed on `model.baseUrl` alone. */
	function baseUrlKey(target: Model): string {
		return routeProfileKey({
			provider: target.provider,
			api: target.api,
			modelId: target.id,
			endpoint: normalizeEndpoint(target.baseUrl),
			route: "",
			retention: "short",
		});
	}

	it("keys an ANTHROPIC_BASE_URL gateway apart from the official API", () => {
		// Failure mode: both endpoints share one route key, so the gateway's observed
		// retention becomes the official API's learned TTL (and vice versa after an
		// endpoint switch). The keepalive then schedules touches on a lifetime no
		// physical entry has — too late for the shorter side, so the entry it means to
		// keep warm is already evicted and every touch pays a full cache write.
		const official = resolveCacheTelemetryRoute(model(), "auto");
		expect(official?.endpoint).toBe("https://api.anthropic.com/v1");

		setEnv("ANTHROPIC_BASE_URL", "https://gw.corp.example.com/anthropic");
		const gateway = resolveCacheTelemetryRoute(model(), "auto");
		expect(gateway?.endpoint).toBe("https://gw.corp.example.com/anthropic");
		expect(gateway?.routeKey).not.toBe(official?.routeKey);
	});

	it("keys a Foundry redirect apart from both the official API and a plain gateway", () => {
		// Failure mode: Foundry wins over ANTHROPIC_BASE_URL in the transport, so keying
		// on the lower-precedence value would merge two live gateways' TTL evidence.
		const official = resolveCacheTelemetryRoute(model(), "auto");

		setEnv("ANTHROPIC_BASE_URL", "https://gw.corp.example.com/anthropic");
		const gateway = resolveCacheTelemetryRoute(model(), "auto");

		setEnv("CLAUDE_CODE_USE_FOUNDRY", "1");
		setEnv("FOUNDRY_BASE_URL", "https://foundry.corp.example.com");
		const foundry = resolveCacheTelemetryRoute(model(), "auto");

		expect(foundry?.endpoint).toBe("https://foundry.corp.example.com");
		expect(foundry?.routeKey).not.toBe(official?.routeKey);
		expect(foundry?.routeKey).not.toBe(gateway?.routeKey);
	});

	it("leaves an explicitly configured non-official baseUrl winning over the env gateway", () => {
		// Failure mode: treating the env var as unconditionally authoritative would file a
		// models.yml proxy's observations under an unrelated gateway. `model.baseUrl` is
		// the more specific configuration and the transport prefers it.
		const proxy = model("https://proxy.internal.example.com/anthropic");
		const before = resolveCacheTelemetryRoute(proxy, "auto");

		setEnv("ANTHROPIC_BASE_URL", "https://gw.corp.example.com/anthropic");
		const after = resolveCacheTelemetryRoute(proxy, "auto");

		expect(after?.endpoint).toBe("https://proxy.internal.example.com/anthropic");
		expect(after?.routeKey).toBe(before?.routeKey);
	});

	it("does not re-key a route the transport never redirects", () => {
		// Failure mode: silently orphaning persisted evidence. The profile behind the old
		// key still exists, but nothing reads it again, so a route with weeks of learned
		// retention drops back below the sample gate and stops being kept warm at all.
		// Both spellings matter: the bundled provider URL carries `/v1`, and the resolver
		// canonicalizes `/v1` away — echoing its output back unconditionally would move
		// the key of every such route without any endpoint actually changing.
		for (const target of [model(), model("https://api.anthropic.com"), moonshotModel()]) {
			const route = resolveCacheTelemetryRoute(target, "auto");
			expect(route?.endpoint).toBe(normalizeEndpoint(target.baseUrl));
			expect(route?.routeKey).toBe(baseUrlKey(target));
		}
	});

	it("keeps non-Anthropic providers on their configured baseUrl", () => {
		// Failure mode: an over-broad fix that resolves the Anthropic endpoint for every
		// api. Moonshot's own env override lives behind per-call client options this layer
		// never sees, so its key must not move when Anthropic env is present.
		const moonshot = moonshotModel();
		const before = resolveCacheTelemetryRoute(moonshot, "auto");

		setEnv("ANTHROPIC_BASE_URL", "https://gw.corp.example.com/anthropic");
		setEnv("CLAUDE_CODE_USE_FOUNDRY", "1");
		setEnv("FOUNDRY_BASE_URL", "https://foundry.corp.example.com");
		const after = resolveCacheTelemetryRoute(moonshot, "auto");

		expect(after?.endpoint).toBe("https://api.moonshot.ai/v1");
		expect(after?.routeKey).toBe(before?.routeKey);
	});

	it("collapses equivalent spellings of one resolved endpoint into one key", () => {
		// Failure mode: a trailing slash or host casing shards one gateway's evidence
		// across several keys, each staying under the sample gate forever, so a real
		// learned TTL never materializes.
		const keys = new Set<string>();
		for (const spelling of [
			"https://gw.corp.example.com/anthropic",
			"https://gw.corp.example.com/anthropic/",
			"https://GW.Corp.Example.COM/anthropic",
		]) {
			setEnv("ANTHROPIC_BASE_URL", spelling);
			const route = resolveCacheTelemetryRoute(model(), "auto");
			expect(route?.endpoint).toBe("https://gw.corp.example.com/anthropic");
			keys.add(route!.routeKey);
		}
		expect(keys.size).toBe(1);

		// A different gateway path is a different cache scope and must stay distinct.
		setEnv("ANTHROPIC_BASE_URL", "https://gw.corp.example.com/other");
		expect(keys.has(resolveCacheTelemetryRoute(model(), "auto")!.routeKey)).toBe(false);
	});
});

/**
 * Rows the SESSION records, captured off the process-wide store the recorder reaches for.
 *
 * Spied rather than injected because `#recordCacheObservation` deliberately uses the shared
 * instance — the `idleSeconds` clock lives there and two stores would each see half the
 * observations. The spy both captures the rows and keeps the real journal untouched, and
 * `settled` awaits the recorder's own call instead of a wall-clock delay: the append is
 * fire-and-forget from the `message_end` handler, so there is nothing else to await.
 */
function captureRequestObservations(session: AgentSession): {
	rows: CacheObservation[];
	snapshots: AgentMessage[][];
	settled: (count: number) => Promise<void>;
	restore: () => void;
} {
	const rows: CacheObservation[] = [];
	const snapshots: AgentMessage[][] = [];
	const waiters: Array<() => void> = [];
	const store = cacheTelemetryStore();
	const spy = spyOn(store, "recordObservation").mockImplementation(async observation => {
		rows.push(observation);
		// The recorder reaches this call with no await since it digested the history, so this
		// is exactly the message list the fingerprint was computed against.
		snapshots.push([...session.messages]);
		for (const resolve of waiters.splice(0)) resolve();
	});
	return {
		rows,
		snapshots,
		settled: async count => {
			while (rows.length < count) {
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
		},
		restore: () => spy.mockRestore(),
	};
}

/**
 * The fingerprint a request carrying exactly `messages` must be filed under.
 *
 * Rebuilt from the same primitives the session uses rather than compared against another
 * recorded row: the point of the assertion is that the recorded key names the request's own
 * prefix, and only an independently computed expectation can pin that. Every non-history
 * dimension is fixed by the harness — no OAuth account (so an empty `authScope`), no pinned
 * prompt-cache key, no tools — so the history digest is what varies.
 */
function fingerprintOver(session: AgentSession, messages: AgentMessage[]): string {
	const model = session.model!;
	const route = resolveCacheTelemetryRoute(model, "auto")!;
	return cacheFingerprint({
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		endpoint: route.endpoint,
		retention: route.retention,
		authScope: "",
		promptCacheKey: "",
		systemHash: orderedHash(session.systemPrompt),
		toolsHash: structuralHash([]),
		historyHash: orderedHash(
			messages.map((message, index) => sessionMessagePersistenceKey(message) ?? `${message.role}#${index}`),
		),
	});
}

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

	/**
	 * `SessionManager.inMemory()` has no file on disk, which the session (rightly) treats as
	 * ineligible for telemetry. Most of these tests are about what the keepalive records, not
	 * about that gate, so the session file is reported inside the real sessions directory — a
	 * string-only decision, so no such file is created and no journal but the injected one is
	 * ever written.
	 *
	 * `model` makes the MockModel the session's OWN model rather than a stand-in stream behind
	 * a bundled one. The per-request recorder skips any turn whose provider/model disagrees
	 * with the live model (a retry-fallback switch), so only that shape reaches it at all.
	 */
	async function createSession(options?: { eligible?: boolean; model?: MockModel }): Promise<AgentSession> {
		const mock = options?.model ?? createMockModel({ handler: () => ({ content: ["Done"] }) });
		const model = options?.model ?? getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// The session validates a key for its OWN model's provider before prompting, so a
		// MockModel-backed session needs one too.
		authStorage.setRuntimeApiKey("mock", "test-key");
		const sessionManager = SessionManager.inMemory();
		if (options?.eligible !== false) {
			spyOn(sessionManager, "getSessionFile").mockReturnValue(
				path.join(getSessionsDir(), "project", "cache-telemetry.jsonl"),
			);
		}
		const session = new AgentSession({
			agent,
			sessionManager,
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

	/** Seed `count` confirmed hits at `idleSeconds` on `routeKey` — enough for `resolveTtl` to learn. */
	async function seedLearnedRoute(journal: string, routeKey: string, idleSeconds: number, count = 4): Promise<void> {
		await fs.mkdir(path.dirname(journal), { recursive: true });
		const seeded = Array.from({ length: count }, (_unused, index) =>
			JSON.stringify(
				observation({
					at: BASE_AT + index,
					kind: "request",
					routeKey,
					outcome: "confirmed-hit",
					idleSeconds,
				}),
			),
		);
		await Bun.write(journal, `${seeded.join("\n")}\n`);
	}

	/**
	 * Wrap `loadProfile` so a test can await the policy's own read instead of a wall-clock
	 * delay, and count reads. The policy attached its `.then` first, so its handler has
	 * already run once the captured promise resolves.
	 */
	function captureProfileReads(store: CacheTelemetryStore): Array<Promise<unknown>> {
		const reads: Array<Promise<unknown>> = [];
		const loadProfile = store.loadProfile.bind(store);
		spyOn(store, "loadProfile").mockImplementation(routeKey => {
			const read = loadProfile(routeKey);
			reads.push(read);
			return read;
		});
		return reads;
	}

	it("has the learned TTL ready before the first lease arms, and re-reads once per armed chain", async () => {
		// THE regression this eager read exists for: with the profile fetched only from
		// `onDecision`, the FIRST chain of every process computes its deadline from the 300s
		// nominal lifetime, because the first decision does not happen until that
		// default-derived timer fires (~285s). On a route whose learned TTL is shorter, the
		// entry is already gone by then — the touch rebuilds the cache at full write price
		// and ends the chain — so the persisted evidence can only ever help a later chain
		// that may never occur. The learned value must be readable BEFORE any decision.
		const session = await createSession();
		const journal = await tmpJournal();
		const route = resolveCacheTelemetryRoute(session.model!, "auto")!;
		await seedLearnedRoute(journal, route.routeKey, 150);

		const store = new CacheTelemetryStore(journal);
		const reads = captureProfileReads(store);
		const policy = createCacheKeepalivePolicy(() => session, store);

		// Nothing read yet, so the getter reports `undefined` rather than inventing a
		// number — the provider layer then uses its own nominal lifetime.
		expect(policy.ttlSeconds).toBeUndefined();
		expect(policy.ttlReady).toBeUndefined();

		// What the request path does, before the stream it issues arms a chain.
		policy.prefetchTtlProfile();
		expect(reads).toHaveLength(1);

		// The load-bearing half. Starting the read is not enough on its own: the response
		// could arrive first, and arming would then schedule from the nominal lifetime and
		// place the first touch after a short-retention entry had already expired. `ttlReady`
		// is what the provider layer waits on, so it MUST be observable while the read is
		// still in flight — asserted here before anything is awaited.
		const ready = policy.ttlReady;
		expect(ready).toBeDefined();

		await ready;

		// Populated with no `onDecision` ever having run: this is the value the FIRST lease
		// is armed with, and arming could not have run earlier because it waits on `ready`.
		expect(policy.ttlSeconds).toBe(150);
		// Cleared once settled, so later leases in this session schedule without waiting.
		expect(policy.ttlReady).toBeUndefined();

		// A further request on the same route must not re-read: the prefetch is idempotent,
		// so priming per request costs one journal read per route, not one per request.
		policy.prefetchTtlProfile();
		expect(reads).toHaveLength(1);

		// Arming a chain still refreshes exactly once, which is how evidence appended since
		// the prefetch reaches the schedule.
		policy.onDecision?.(decision({ fingerprint: "chain-1" }));
		expect(reads).toHaveLength(2);
		await reads[1];
		expect(policy.ttlSeconds).toBe(150);

		// Later touches in the SAME chain must not re-read: that is the "once per armed
		// chain" bound, and without it every touch would re-parse the journal.
		policy.onDecision?.(decision({ fingerprint: "chain-1", touchIndex: 2 }));
		policy.onDecision?.(decision({ fingerprint: "chain-1", touchIndex: 3 }));
		expect(reads).toHaveLength(2);

		// A newly armed chain does read again.
		policy.onDecision?.(decision({ fingerprint: "chain-2", touchIndex: 1 }));
		expect(reads).toHaveLength(3);
	});

	it("reports no TTL for a route with no persisted evidence", async () => {
		// Failure mode: a prefetch that resolves to "no profile" pins the nominal default as
		// if it had been measured, which would make an unlearned route indistinguishable
		// from a route genuinely learned at 300s and freeze a guess into the schedule.
		const session = await createSession();
		const store = new CacheTelemetryStore(await tmpJournal());
		const reads = captureProfileReads(store);
		const policy = createCacheKeepalivePolicy(() => session, store);

		policy.prefetchTtlProfile();
		expect(reads).toHaveLength(1);
		await reads[0];

		expect(policy.ttlSeconds).toBeUndefined();
	});

	it("prefetches nothing for a session the request recorder also refuses", async () => {
		// Failure mode: the eager read is a new filesystem touch on the request path, and an
		// in-memory SDK embedding — which files no rows at all — must not acquire one.
		const session = await createSession({ eligible: false });
		const journal = await tmpJournal();
		const route = resolveCacheTelemetryRoute(session.model!, "auto")!;
		await seedLearnedRoute(journal, route.routeKey, 150);

		const store = new CacheTelemetryStore(journal);
		const reads = captureProfileReads(store);
		const policy = createCacheKeepalivePolicy(() => session, store);

		expect(session.cacheTelemetryEligible()).toBe(false);
		policy.prefetchTtlProfile();
		expect(reads).toEqual([]);
		expect(policy.ttlSeconds).toBeUndefined();
		// Nothing was written either, so the seeded rows are all the journal holds.
		await store.settle();
		expect(await store.readObservations()).toHaveLength(4);

		// Same session reporting a file under the sessions directory does prefetch, so the
		// empty result above is the gate and not a broken hook.
		spyOn(session.sessionManager, "getSessionFile").mockReturnValue(
			path.join(getSessionsDir(), "project", "eligible.jsonl"),
		);
		policy.prefetchTtlProfile();
		expect(reads).toHaveLength(1);
		await reads[0];
		expect(policy.ttlSeconds).toBe(150);
	});

	it("reports no TTL when there is no session to resolve a route from", async () => {
		// Failure mode: the policy is built before the session exists, so a getter that
		// assumed one would throw into the keepalive's scheduling path.
		const store = new CacheTelemetryStore(await tmpJournal());
		const reads = captureProfileReads(store);
		const policy = createCacheKeepalivePolicy(() => undefined, store);

		expect(policy.ttlSeconds).toBeUndefined();
		// And no route means nothing to prefetch, rather than a read keyed on a fabricated one.
		policy.prefetchTtlProfile();
		expect(reads).toEqual([]);
		// A decision arriving in that window is likewise dropped rather than filed.
		policy.onDecision?.(decision());
		await store.settle();
		expect(await store.readObservations()).toEqual([]);
	});

	it("refuses touch rows for a session the request recorder also refuses", async () => {
		// Failure mode: the two observation sinks disagree, so an in-memory SDK embedding or a
		// temp-dir test fixture — whose own request rows are correctly dropped — still appends
		// keepalive rows to the user's data directory.
		const session = await createSession({ eligible: false });
		const store = new CacheTelemetryStore(await tmpJournal());
		const policy = createCacheKeepalivePolicy(() => session, store);

		expect(session.cacheTelemetryEligible()).toBe(false);
		policy.onDecision?.(decision());
		await store.settle();
		expect(await store.readObservations()).toEqual([]);

		// Same session, same decision, now reporting a file under the sessions directory: the
		// row appears, so the empty result above is the gate and not a broken sink.
		spyOn(session.sessionManager, "getSessionFile").mockReturnValue(
			path.join(getSessionsDir(), "project", "eligible.jsonl"),
		);
		expect(session.cacheTelemetryEligible()).toBe(true);
		policy.onDecision?.(decision());
		await store.settle();
		expect(await store.readObservations()).toHaveLength(1);
	});

	it("keys touches on the physical cache entry the last request was filed under", async () => {
		// Failure mode: touches key on `promptCacheKey ?? sessionId` — a routing key no
		// request row ever carries — so the gap between the request that wrote the entry and
		// the touches keeping it warm can never be differenced, and the journal's TTL evidence
		// is unusable.
		// Above `MIN_CACHE_FOOTPRINT`: a request reporting zero input tokens is not a shape any
		// provider produces, and a sub-threshold zero/zero turn is deliberately not recorded
		// at all — this test is about which entry a row is keyed to, so it needs a row.
		const model = createMockModel({ handler: () => ({ content: ["Done"], usage: { input: 8_192 } }) });
		const session = await createSession({ model });
		const store = new CacheTelemetryStore(await tmpJournal());
		const policy = createCacheKeepalivePolicy(() => session, store);
		const recorded = captureRequestObservations(session);
		try {
			// Nothing observed yet: `undefined` hands the keepalive back to its routing-key
			// fallback rather than inventing a fingerprint.
			expect(policy.fingerprint?.()).toBeUndefined();

			await session.sendUserMessage("hello");
			await recorded.settled(1);

			const requestFingerprint = recorded.rows[0]?.fingerprint;
			expect(requestFingerprint).toBeTruthy();
			expect(policy.fingerprint?.()).toBe(requestFingerprint);

			// A turn the recorder cannot key drops the remembered value instead of leaving it
			// stale: here the live model no longer matches the one that served the turn (the
			// retry-fallback shape), so the entry the chain now protects was never the one
			// behind `requestFingerprint`. Reporting the old key would file touches against a
			// different physical entry.
			await session.setModelTemporary(getBundledModel("anthropic", "claude-opus-4-5")!);
			await session.sendUserMessage("after the switch");
			expect(recorded.rows).toHaveLength(1);
			expect(policy.fingerprint?.()).toBeUndefined();
		} finally {
			recorded.restore();
		}
	});

	it("fingerprints a request over its own history, never over the response it produced", async () => {
		// Failure mode: `#cacheHistoryParts` digests the live message list at `message_end`,
		// which already contains the assistant message being observed. The row then names a
		// prefix no request ever sent, so nothing else ever observes that entry and the row
		// carries no idle-age evidence — the one thing TTL learning consumes.
		const model = createMockModel({ handler: () => ({ content: ["Done"], usage: { input: 8_192 } }) });
		const session = await createSession({ model });
		const recorded = captureRequestObservations(session);
		try {
			await session.sendUserMessage("first");
			await recorded.settled(1);
			await session.sendUserMessage("second");
			await recorded.settled(2);

			const [first, second] = recorded.snapshots;
			// Both turns were observed with their own assistant message already appended.
			expect(first?.filter(message => message.role === "assistant")).toHaveLength(1);
			expect(second?.filter(message => message.role === "assistant")).toHaveLength(2);

			// Turn N is keyed over exactly N-1 assistant messages: the history its request
			// actually carried.
			const firstRequest = first!.slice(0, -1);
			const secondRequest = second!.slice(0, -1);
			expect(firstRequest.filter(message => message.role === "assistant")).toHaveLength(0);
			expect(secondRequest.filter(message => message.role === "assistant")).toHaveLength(1);
			expect(recorded.rows[0]?.fingerprint).toBe(fingerprintOver(session, firstRequest));
			expect(recorded.rows[1]?.fingerprint).toBe(fingerprintOver(session, secondRequest));

			// The digest does move between turns — the keys are not degenerate.
			expect(recorded.rows[0]?.fingerprint).not.toBe(recorded.rows[1]?.fingerprint);
			// And it is not the buggy value: the digest of the full list, response included.
			expect(recorded.rows[1]?.fingerprint).not.toBe(fingerprintOver(session, second!));
		} finally {
			recorded.restore();
		}
	});

	it("drops a successful zero/zero turn below the caching floor, and keeps one above it", async () => {
		// Failure mode: a short conversation reports neither a cache read nor a write because
		// the prefix was never big enough to cache. Filed as `success-unverified`, every such
		// row costs the route 0.05 confidence in `observeTtl` while carrying no information —
		// so a handful of them erases what real hits and misses earned, drops the route under
		// the 0.7 learned gate, and no learned TTL can ever be selected again.
		const belowModel = createMockModel({
			handler: () => ({ content: ["Done"], usage: { input: MIN_CACHE_FOOTPRINT - 1 } }),
		});
		const belowSession = await createSession({ model: belowModel });
		const below = captureRequestObservations(belowSession);
		try {
			await belowSession.sendUserMessage("hi");
			expect(below.rows).toHaveLength(0);
			// And the remembered key stays unset, so a later touch cannot file evidence under
			// an entry that has no observation of its own to difference against.
			expect(belowSession.lastRecordedCacheFingerprint).toBeUndefined();
		} finally {
			below.restore();
		}

		// Positive control, and the reason the gate is on size rather than on silence: at the
		// floor the same zero/zero reading IS evidence — the provider should have cached this
		// prefix and did not — so it must still be recorded.
		const atModel = createMockModel({
			handler: () => ({ content: ["Done"], usage: { input: MIN_CACHE_FOOTPRINT } }),
		});
		const atSession = await createSession({ model: atModel });
		const at = captureRequestObservations(atSession);
		try {
			await atSession.sendUserMessage("hi");
			await at.settled(1);
			expect(at.rows[0]?.outcome).toBe("success-unverified");
			expect(atSession.lastRecordedCacheFingerprint).toBe(at.rows[0]?.fingerprint);
		} finally {
			at.restore();
		}
	});

	it("records a sub-threshold turn that did report cache activity", async () => {
		// The gate must key on the absence of counters, not on prefix size alone: a provider
		// that reports a read over a small prefix has told us something real, and dropping it
		// would discard genuine evidence.
		const model = createMockModel({
			handler: () => ({ content: ["Done"], usage: { input: 8, cacheRead: 64 } }),
		});
		const session = await createSession({ model });
		const recorded = captureRequestObservations(session);
		try {
			await session.sendUserMessage("hi");
			await recorded.settled(1);
			expect(recorded.rows[0]?.outcome).toBe("confirmed-hit");
		} finally {
			recorded.restore();
		}
	});
});
