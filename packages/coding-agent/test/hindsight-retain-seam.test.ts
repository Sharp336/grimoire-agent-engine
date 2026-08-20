import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function captureBodies(): unknown[] {
	const bodies: unknown[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return bodies;
}

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: "personal",
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	retainStrategy: null,
	recallTags: [],
	recallTagsMatch: "any",
	...overrides,
});

describe("Hindsight retain/recall request bodies", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits item.strategy when retainStrategy is unset", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.retain("personal", "session", { tags: ["project:speech-core"] });
		const item = (bodies[0] as { items: Array<Record<string, unknown>> }).items[0];
		expect(item).toEqual({ content: "session", tags: ["project:speech-core"] });
		expect(item).not.toHaveProperty("strategy");
		expect(JSON.stringify(item)).not.toContain("strategy:coding");
	});

	it("serializes retainStrategy as item.strategy and not a strategy tag", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.retain("personal", "session", {
			tags: ["project:speech-core"],
			strategy: "coding",
			observationScopes: [["project:speech-core"]],
		});
		const item = (bodies[0] as { items: Array<Record<string, unknown>> }).items[0];
		expect(item.strategy).toBe("coding");
		expect(item.observation_scopes).toEqual([["project:speech-core"]]);
		expect(item.tags).toEqual(["project:speech-core"]);
		expect(item.tags).not.toContain("strategy:coding");
	});

	it("forwards recall tags_match", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.recall("personal", "what did we decide", {
			tags: ["project:speech-core", "project:global"],
			tagsMatch: "any",
		});
		expect(bodies[0]).toMatchObject({
			query: "what did we decide",
			tags: ["project:speech-core", "project:global"],
			tags_match: "any",
		});
	});

	it("session auto-retain emits strategy and project-only observation scopes", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const messages: HindsightMessage[] = [{ role: "user", content: "pin the speech-core decoder" }];
		const state = new HindsightSessionState({
			sessionId: "sess-1",
			client,
			bankId: "personal",
			retainTags: ["project:speech-core"],
			recallTags: ["project:speech-core", "project:global"],
			recallTagsMatch: "any",
			observationScopes: [["project:speech-core"]],
			config: makeConfig({ retainStrategy: "coding" }),
			session: { sessionId: "sess-1" } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(messages);

		const body = bodies[0] as { items: Array<Record<string, unknown>> };
		const item = body.items[0];
		expect(item.strategy).toBe("coding");
		expect(item.tags).toEqual(["project:speech-core"]);
		expect(item.tags).not.toContain("strategy:coding");
		expect(item.observation_scopes).toEqual([["project:speech-core"]]);
		expect(JSON.stringify(item.observation_scopes)).not.toContain("role:");
		expect(JSON.stringify(item.observation_scopes)).not.toContain("source:");
		expect(item.metadata).toEqual({ session_id: "sess-1", retain_strategy: "coding" });
	});

	it("session auto-retain omits strategy when unset", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const state = new HindsightSessionState({
			sessionId: "sess-2",
			client,
			bankId: "personal",
			retainTags: ["project:speech-core"],
			observationScopes: [["project:speech-core"]],
			config: makeConfig(),
			session: { sessionId: "sess-2" } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession([{ role: "user", content: "remember this" }]);
		const item = (bodies[0] as { items: Array<Record<string, unknown>> }).items[0];
		expect(item).not.toHaveProperty("strategy");
		expect((item.metadata as Record<string, string>)).toEqual({ session_id: "sess-2" });
	});
});
