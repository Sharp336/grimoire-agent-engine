import { describe, expect, test } from "bun:test";
import { AgentSessionAuthority, type AgentSessionAuthoritySource } from "../src/session/agent-session-authority";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { MAX_SESSION_IDEMPOTENCY_KEYS } from "../src/session/session-host";

class FakeSession implements AgentSessionAuthoritySource {
	readonly sessionManager = {
		getSessionId: () => "session-1",
		getLeafId: () => this.#branch.at(-1)?.id,
		getBranch: () => this.#branch,
	};
	readonly #branch: Array<{
		id: string;
		parentId: string | null;
		timestamp: string;
		type: "message";
		message: unknown;
	}> = [];
	readonly #listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
	readonly #persistence = new Map<unknown, Promise<void>>();

	subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) void listener(event);
	}

	waitForSessionMessagePersistence(message: unknown): Promise<void> {
		return this.#persistence.get(message) ?? Promise.resolve();
	}

	appendEntry(entryId: string): void {
		this.#branch.push({
			id: entryId,
			parentId: this.#branch.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			type: "message",
			message: { role: "system", content: "mutation" },
		});
	}

	emitPersistedMessage(event: Extract<AgentSessionEvent, { type: "message_end" }>, entryId: string): void {
		const settled = Promise.withResolvers<void>();
		this.#persistence.set(event.message, settled.promise);
		for (const listener of this.#listeners) void listener(event);
		this.#branch.push({
			id: entryId,
			parentId: this.#branch.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			type: "message",
			message: event.message,
		});
		settled.resolve();
	}
}

describe("AgentSessionAuthority", () => {
	test("orders transient delivery before the durable journal observation", async () => {
		const session = new FakeSession();
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({ phase: "idle" }),
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});
		const observations: Array<{ durability: string; kind: string; eventId?: string }> = [];
		const delivered = Promise.withResolvers<void>();
		authority.subscribe(observation => {
			observations.push(observation);
			if (observation.durability === "durable") delivered.resolve();
		});

		session.emitPersistedMessage(
			{
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
			},
			"entry-1",
		);
		await delivered.promise;

		expect(observations).toHaveLength(2);
		expect(observations[0]).toMatchObject({ durability: "transient", kind: "message_end" });
		expect(observations[1]).toMatchObject({
			durability: "durable",
			kind: "journal_entry",
			eventId: "session-1:entry-1",
		});
	});

	test("keeps non-terminal agent_end observations unsettled", async () => {
		const session = new FakeSession();
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({ phase: "active" }),
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});
		const observations: Array<{ kind: string; terminalSettlement: string }> = [];
		authority.subscribe(observation =>
			observations.push({ kind: observation.kind, terminalSettlement: observation.terminalSettlement }),
		);

		session.emit({ type: "agent_end", messages: [], isTerminal: false });
		session.emit({ type: "agent_end", messages: [], isTerminal: true });
		await authority.snapshot(() => {});

		expect(observations).toEqual([
			{ kind: "agent_end", terminalSettlement: "none" },
			{ kind: "agent_end", terminalSettlement: "completed" },
		]);
	});

	test("snapshots the authoritative journal watermark without exposing a transport cursor", async () => {
		const session = new FakeSession();
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({ phase: "idle" }),
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});

		const snapshot = await authority.snapshot(() => {});

		expect(snapshot).toEqual({
			revision: 0,
			state: { phase: "idle" },
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		});
	});

	test("resamples state when an observation arrives during snapshot capture", async () => {
		const session = new FakeSession();
		const firstSnapshotStarted = Promise.withResolvers<void>();
		const releaseFirstSnapshot = Promise.withResolvers<void>();
		let snapshotCalls = 0;
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => {
				snapshotCalls++;
				if (snapshotCalls === 1) {
					firstSnapshotStarted.resolve();
					await releaseFirstSnapshot.promise;
					return { phase: "stale" };
				}
				return { phase: "active" };
			},
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});
		const observations: string[] = [];
		authority.subscribe(observation => observations.push(observation.kind));
		let watermarkCaptures = 0;

		const snapshotPromise = authority.snapshot(() => {
			watermarkCaptures++;
		});
		await firstSnapshotStarted.promise;
		session.emit({ type: "agent_start" });
		releaseFirstSnapshot.resolve();
		const snapshot = await snapshotPromise;

		expect(snapshot.state).toEqual({ phase: "active" });
		expect(observations).toContain("agent_start");
		expect(watermarkCaptures).toBe(1);
	});

	test("attributes journal mutations to the invocation and advances the authoritative revision", async () => {
		const session = new FakeSession();
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({ phase: "idle" }),
			invoke: async () => {
				session.appendEntry("entry-1");
				return { outcome: "completed" };
			},
			settle: async () => ({ state: "settled" }),
		});
		const observations: Array<{ causationId?: string; eventId?: string }> = [];
		authority.subscribe(observation => observations.push(observation));

		const outcome = await authority.invoke({ kind: "rename_session" }, { requestId: "request-1" });

		expect(outcome).toEqual({ outcome: "completed", revision: 1 });
		expect(observations).toEqual([
			expect.objectContaining({ causationId: "request-1", eventId: "session-1:entry-1" }),
		]);
	});

	test("replays durable journal entries after an ancestor cursor with stable identities", async () => {
		const session = new FakeSession();
		session.appendEntry("entry-1");
		session.appendEntry("entry-2");
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({}),
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});

		const replay = await authority.replay(
			{
				sessionId: "session-1",
				leafId: "entry-1",
				entryId: "entry-1",
			},
			8,
		);

		expect(replay.observations).toEqual([
			expect.objectContaining({
				durability: "durable",
				eventId: "session-1:entry-2",
				journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
			}),
		]);
		expect(replay.journalCursor).toEqual({
			sessionId: "session-1",
			leafId: "entry-2",
			entryId: "entry-2",
		});
	});

	test("emits one terminal observation after authoritative settlement completes", async () => {
		const session = new FakeSession();
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({}),
			invoke: async () => ({ outcome: "completed" }),
			settle: async () => ({ state: "settled" }),
		});
		const observations: Array<{ kind: string; terminalSettlement: string }> = [];
		authority.subscribe(observation => observations.push(observation));

		const first = authority.settle();
		const second = authority.settle();

		await expect(Promise.all([first, second])).resolves.toEqual([{ state: "settled" }, { state: "settled" }]);
		expect(observations).toEqual([
			expect.objectContaining({ kind: "session_settled", terminalSettlement: "completed" }),
		]);
	});

	test("deduplicates concurrent idempotent mutations and rejects key reuse for a different command", async () => {
		const session = new FakeSession();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let invocations = 0;
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({}),
			invoke: async () => {
				invocations++;
				started.resolve();
				await finish.promise;
				return { outcome: "completed", result: { applied: true } };
			},
			settle: async () => ({ state: "settled" }),
		});
		const command = {
			kind: "queue_update",
			input: { entryId: "queue-1", text: "updated" },
			idempotencyKey: "idem-1",
		};

		const first = authority.invoke(command, { requestId: "request-1" });
		await started.promise;
		const duplicate = authority.invoke(
			{ ...command, input: { text: "updated", entryId: "queue-1" } },
			{ requestId: "request-2" },
		);
		expect(invocations).toBe(1);
		finish.resolve();
		await expect(Promise.all([first, duplicate])).resolves.toEqual([
			{ outcome: "completed", result: { applied: true }, revision: 1 },
			{ outcome: "completed", result: { applied: true }, revision: 1 },
		]);
		await expect(
			authority.invoke({ ...command, input: { entryId: "queue-1", text: "different" } }, { requestId: "request-3" }),
		).resolves.toMatchObject({ outcome: "failed", error: { code: "idempotency_conflict", retryable: false } });
		expect(invocations).toBe(1);
	});

	test("serializes matching expected revisions so only one mutation can complete", async () => {
		const session = new FakeSession();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let invocations = 0;
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({}),
			invoke: async () => {
				invocations++;
				if (invocations === 1) {
					started.resolve();
					await finish.promise;
				}
				return { outcome: "completed" };
			},
			settle: async () => ({ state: "settled" }),
		});

		const first = authority.invoke(
			{ kind: "queue_update", input: { entryId: "queue-1", text: "first" }, expectedRevision: 0 },
			{ requestId: "request-1" },
		);
		await started.promise;
		const stale = authority.invoke(
			{ kind: "queue_update", input: { entryId: "queue-1", text: "second" }, expectedRevision: 0 },
			{ requestId: "request-2" },
		);
		expect(invocations).toBe(1);
		finish.resolve();

		await expect(first).resolves.toEqual({ outcome: "completed", revision: 1 });
		await expect(stale).resolves.toMatchObject({
			outcome: "failed",
			revision: 1,
			error: { code: "revision_conflict", retryable: true },
		});
		expect(invocations).toBe(1);
	});

	test("rejects new idempotency keys when bounded retention is full without invalidating retained outcomes", async () => {
		const session = new FakeSession();
		let invocations = 0;
		const authority = new AgentSessionAuthority(session, {
			snapshotState: async () => ({}),
			invoke: async () => {
				invocations++;
				return { outcome: "completed" };
			},
			settle: async () => ({ state: "settled" }),
		});

		for (let index = 0; index < MAX_SESSION_IDEMPOTENCY_KEYS; index++) {
			await authority.invoke(
				{ kind: "queue_clear", idempotencyKey: `idem-${index}` },
				{ requestId: `request-${index}` },
			);
		}
		await expect(
			authority.invoke({ kind: "queue_clear", idempotencyKey: "overflow" }, { requestId: "request-overflow" }),
		).resolves.toMatchObject({ outcome: "failed", error: { code: "idempotency_capacity", retryable: false } });
		await expect(
			authority.invoke({ kind: "queue_clear", idempotencyKey: "idem-0" }, { requestId: "request-retry" }),
		).resolves.toEqual({ outcome: "completed", revision: 1 });
		expect(invocations).toBe(MAX_SESSION_IDEMPOTENCY_KEYS);
	});
});
