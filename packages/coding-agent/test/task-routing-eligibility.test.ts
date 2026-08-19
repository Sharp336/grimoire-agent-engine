import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { filterRoutingCandidates } from "@oh-my-pi/pi-coding-agent/task/routing/candidates";
import { resolveResourcePool } from "@oh-my-pi/pi-coding-agent/task/routing/pool";
import { buildRoutingSnapshot } from "@oh-my-pi/pi-coding-agent/task/routing/snapshot";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function pool(provider: string): ReturnType<typeof resolveResourcePool> {
	return resolveResourcePool({ provider });
}

function sessionWithRegistry(
	auth: AuthStorage,
	registry: ModelRegistry,
	overrides: Record<string, unknown>,
): ToolSession {
	const base = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides as Record<string, unknown>),
		getSessionId: () => "test",
		getActiveModelString: () => "anthropic/claude-sonnet-4-5",
		getModelString: () => "anthropic/claude-sonnet-4-5",
		taskDepth: 0,
		modelRegistry: registry,
		authStorage: auth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return base;
}

describe("worker eligibility — broad alias must not admit stale catalog models", () => {
	it("broad priority alias flash cannot admit google/gemini-1.5-flash when intentional candidates exist", async () => {
		const staleId = "gemini-1.5-flash";
		const intentionalId = "gemini-3.1-flash-lite";
		const auth = await AuthStorage.create(":memory:");
		await auth.set("google", { type: "api_key", key: "test-key-google" });
		await auth.set("google-antigravity", { type: "api_key", key: "test-key-agy" });

		const fakeAvailable = [
			{
				provider: "google",
				id: staleId,
				input: ["text"],
				supportsTools: true,
				contextWindow: 1000000,
				cost: { input: 0.1, output: 0.1 },
				reasoning: false,
				baseUrl: "https://generativelanguage.googleapis.com",
			},
			{
				provider: "google-antigravity",
				id: intentionalId,
				input: ["text"],
				supportsTools: true,
				contextWindow: 1000000,
				cost: { input: 0.1, output: 0.1 },
				reasoning: false,
				baseUrl: "https://api.agy.example",
			},
			{
				provider: "cursor",
				id: "composer-2.5",
				input: ["text"],
				supportsTools: true,
				contextWindow: 200000,
				cost: { input: 0.2, output: 0.2 },
				reasoning: true,
				baseUrl: "https://api.cursor.com",
			},
		] as unknown as Model<never>[];

		const registry = {
			getAvailable: () => fakeAvailable,
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: (p: string) => fakeAvailable.find(x => x.provider === p)?.baseUrl as string | undefined,
			authStorage: auth,
		} as unknown as ModelRegistry;

		const session = sessionWithRegistry(auth, registry, {
			"task.routing.workerModels": [] as string[],
			"task.routing.enabled": true,
			"task.routing.avoidParentPool": false,
			"task.routing.parentPoolFallback": "allow",
			"task.routing.excludePools": [] as string[],
			"task.routing.preferPools": [] as string[],
			"task.routing.agentIntents": {} as Record<string, string>,
			"task.routing.maxContractReroutes": 1,
			"retry.usageReservePct": 10,
		});

		const snap = await buildRoutingSnapshot(session);
		const selectors = snap.candidates.map(c => c.selector);
		expect(selectors).not.toContain(`google/${staleId}`);
		auth.close();
	});

	it("concrete workerModels roster still admits its intentional models", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("cursor", { type: "api_key", key: "k" });
		const fakeAvailable = [
			{
				provider: "cursor",
				id: "composer-2.5",
				input: ["text"],
				supportsTools: true,
				contextWindow: 200000,
				cost: { input: 0.2, output: 0.2 },
				reasoning: true,
				baseUrl: "https://api.cursor.com",
			},
		] as unknown as Model<never>[];
		const registry = {
			getAvailable: () => fakeAvailable,
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: () => "https://api.cursor.com",
			authStorage: auth,
		} as unknown as ModelRegistry;
		const session = sessionWithRegistry(auth, registry, {
			"task.routing.workerModels": ["cursor/composer-2.5"] as string[],
			"task.routing.enabled": true,
			"task.routing.avoidParentPool": false,
			"task.routing.parentPoolFallback": "allow",
			"task.routing.excludePools": [] as string[],
			"task.routing.preferPools": [] as string[],
			"task.routing.agentIntents": {} as Record<string, string>,
			"task.routing.maxContractReroutes": 1,
			"retry.usageReservePct": 10,
		});
		const snap = await buildRoutingSnapshot(session);
		expect(snap.candidates.map(c => c.selector)).toContain("cursor/composer-2.5");
		auth.close();
	});
});

describe("dead-route suppression — 404 suppresses exact selector for siblings", () => {
	it("filterRoutingCandidates excludes dead selectors", () => {
		const pA = pool("google");
		const pB = pool("meta");
		const candidates = [
			{
				selector: "google/gemini-1.5-flash",
				pool: pA,
				vision: false,
				supportsTools: true,
				contextWindow: 1_000_000,
				costPerMTokenTotal: 0.1,
				reasoning: false,
				usage: "healthy" as const,
			},
			{
				selector: "meta/muse-spark-1.2-contributor",
				pool: pB,
				vision: false,
				supportsTools: true,
				contextWindow: 1_000_000,
				costPerMTokenTotal: 0.1,
				reasoning: false,
				usage: "healthy" as const,
			},
		];
		const base = {
			agent: "scout",
			intent: "default" as const,
			requirements: {},
			policy: {
				enabled: true,
				avoidParentPool: false,
				parentPoolFallback: "allow" as const,
				excludePools: [],
				preferPools: [],
			},
			candidates,
			parentPool: undefined,
			random: () => 0,
		};
		const withoutDead = filterRoutingCandidates({ ...base, deadSelectors: [] });
		expect(withoutDead.viable.map(v => v.selector)).toContain("google/gemini-1.5-flash");

		const withDead = filterRoutingCandidates({ ...base, deadSelectors: ["google/gemini-1.5-flash"] });
		expect(withDead.viable.map(v => v.selector)).not.toContain("google/gemini-1.5-flash");
		expect(withDead.viable.map(v => v.selector)).toContain("meta/muse-spark-1.2-contributor");
		expect(withDead.trace.join(" ")).toContain("dead");
	});
});
