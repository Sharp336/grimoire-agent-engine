import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

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
	retainEveryNTurns: 5,
	retainOverlapTurns: 2,
	retainContext: "omp",
	retainUpdateMode: "replace",
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
	...overrides,
});

function firstItem(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null) throw new Error("missing retain body");
	const items = (body as { items?: unknown }).items;
	if (!Array.isArray(items) || items[0] === undefined) throw new Error("missing retain item");
	const item = items[0];
	if (typeof item !== "object" || item === null) throw new Error("retain item is not an object");
	return item as Record<string, unknown>;
}

const SESSION_START = "2026-08-17T09:00:00.000Z";

function turn(role: "user" | "assistant", content: string): HindsightMessage {
	return { role, content };
}

function userEntry(id: string, parentId: string | null, content: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string, content: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			timestamp: Date.parse(timestamp),
		},
	} as SessionEntry;
}

describe("Hindsight append-mode session retention", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps default replace behavior: no update_mode and a full transcript on later retains", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here")];
		const second = [
			...first,
			turn("assistant", "first reply is long enough"),
			turn("user", "hello second turn here"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-replace",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: { sessionId: "sess-replace", getHindsightSessionState: () => state } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(first);
		await state.retainSession(second);
		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[0]).document_id).toBe("sess-replace");
		expect(firstItem(bodies[1]).document_id).toBe("sess-replace");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
	});

	it("appends only the new delta to the same document_id without resending history", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const second = [...first, turn("user", "hello second turn here")];
		const state = new HindsightSessionState({
			sessionId: "sess-append",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainOverlapTurns: 2 }),
			session: {
				sessionId: "sess-append",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-append", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => [],
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(first);
		await state.retainSession(second);

		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[0]).document_id).toBe("sess-append");
		expect(firstItem(bodies[1]).document_id).toBe("sess-append");
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
		expect(String(firstItem(bodies[1]).content)).not.toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).not.toContain("first reply is long enough");
	});

	it("rebuilds with replace when the retained prefix diverges", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const original = [turn("user", "hello original branch"), turn("assistant", "original tail is long enough")];
		const rewritten = [
			turn("user", "hello original branch"),
			turn("assistant", "rewritten tail is long enough"),
			turn("user", "next message after rewrite"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-diverge",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: { sessionId: "sess-diverge", getHindsightSessionState: () => state } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(original);
		await state.retainSession(rewritten);
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(String(firstItem(bodies[1]).content)).toContain("hello original branch");
		expect(String(firstItem(bodies[1]).content)).toContain("rewritten tail is long enough");
		expect(String(firstItem(bodies[1]).content)).toContain("next message after rewrite");
		expect(String(firstItem(bodies[1]).content)).not.toContain("original tail is long enough");
	});

	it("force-rebuilds the full canonical transcript with replace", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "hello first turn here", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "first reply is long enough", "2026-08-17T10:00:05.000Z"),
			userEntry("u2", "a1", "hello second turn here", "2026-08-17T10:01:00.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-force",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: {
				sessionId: "sess-force",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-force", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession([
			turn("user", "hello first turn here"),
			turn("assistant", "first reply is long enough"),
		]);
		await state.forceRetainCurrentSession();
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(firstItem(bodies[1]).document_id).toBe("sess-force");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
	});

	it("flushes a short unretained tail on clean session close without duplicating the prefix", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const firstFive = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		let entries = firstFive;
		const state = new HindsightSessionState({
			sessionId: "sess-tail",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainEveryNTurns: 5, retainOverlapTurns: 2 }),
			session: {
				sessionId: "sess-tail",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-tail", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(String(firstItem(bodies[0]).content)).toContain("turn five has enough text");

		entries = [
			...firstFive,
			userEntry("u6", "a5", "turn six has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "reply six has enough text", "2026-08-17T10:05:01.000Z"),
			userEntry("u7", "a6", "turn seven has enough text", "2026-08-17T10:06:00.000Z"),
		];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(firstItem(bodies[1]).document_id).toBe("sess-tail");
		expect(String(firstItem(bodies[1]).content)).toContain("turn six has enough text");
		expect(String(firstItem(bodies[1]).content)).toContain("turn seven has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn one has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn five has enough text");
	});

	it("does not re-retain last-turn content that was already flushed at cadence", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-done",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-done",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-done",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).document_id)).toMatch(/^sess-lastturn-done-\d+$/);

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
	});

	it("flushes a below-cadence last-turn tail exactly once on clean close", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const firstFive = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		let entries = firstFive;
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-tail",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-tail",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-tail",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		entries = [
			...firstFive,
			userEntry("u6", "a5", "turn six has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "reply six has enough text", "2026-08-17T10:05:01.000Z"),
			userEntry("u7", "a6", "turn seven has enough text", "2026-08-17T10:06:00.000Z"),
		];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[1]).document_id)).toMatch(/^sess-lastturn-tail-\d+$/);
		expect(String(firstItem(bodies[1]).content)).toContain("turn seven has enough text");
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
	});
});
