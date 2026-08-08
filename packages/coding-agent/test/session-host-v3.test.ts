import { describe, expect, test } from "bun:test";
import {
	createSessionHostManifest,
	negotiateSessionHost,
	type SessionAuthority,
	type SessionAuthorityObservation,
	type SessionAuthorityReplay,
	type SessionAuthoritySnapshot,
	SessionCursorError,
	SessionHost,
	type SessionHostCapabilityDefinition,
	type SessionJournalCursor,
	SessionSubscriptionCapacityError,
} from "@oh-my-pi/pi-coding-agent/session/session-host";

const capabilities = [
	{
		id: "session.observe",
		version: 1,
		supported: true,
		operations: ["snapshot", "subscribe", "acknowledge"],
		events: ["observation", "gap"],
		platforms: ["all"],
	},
	{
		id: "collaboration.control",
		version: 1,
		supported: false,
		operations: [],
		events: [],
		platforms: ["all"],
		unsupportedReason: { code: "not_configured", message: "Collaboration is not configured" },
	},
] as const satisfies readonly SessionHostCapabilityDefinition[];

const recovery = {
	transportReplay: "bounded",
	durableReplay: "session_journal",
	snapshotHandoff: "watermark",
	acknowledgement: "cumulative",
	gapRecovery: "resnapshot",
	duplicateHandling: "stable_event_id",
} as const;

const mutations = {
	correlation: "request_id",
	concurrency: "expected_revision",
	cancellation: "cooperative",
	terminalOutcomes: ["completed", "cancelled", "failed", "unknown"],
	idempotency: {
		scope: "authority_lifetime",
		retention: "bounded",
		conflict: "reject",
		overflow: "reject",
	},
} as const;

describe("session host semantic negotiation", () => {
	test("selects semantic v3 independently from framing and reports omitted capabilities unsupported", () => {
		const manifest = createSessionHostManifest({
			ompVersion: "17.2.10",
			framingVersions: [1, 2],
			limits: {
				maxFrameBytes: 1_048_576,
				maxReassembledFrameBytes: 67_108_864,
				maxArtifactReadBytes: 1_048_576,
				maxPendingObservations: 1_024,
				maxIdempotencyKeys: 1_024,
			},
			capabilities,
			recovery,
			mutations,
		});

		const result = negotiateSessionHost(manifest, {
			profile: { name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 },
			framingVersion: 2,
			hostCapabilities: {
				interactions: ["select", "confirm"],
				semanticContent: ["markdown", "fields"],
			},
			requestedCapabilities: ["session.observe", "artifact.read", "collaboration.control"],
		});

		expect(result).toEqual({
			ok: true,
			profile: { name: "omp.session", major: 3, minor: 0 },
			framingVersion: 2,
			capabilities: [
				expect.objectContaining({ id: "session.observe", supported: true }),
				{
					id: "artifact.read",
					version: 0,
					supported: false,
					operations: [],
					events: [],
					platforms: [],
					unsupportedReason: { code: "unknown_capability", message: "Capability is not advertised" },
				},
				expect.objectContaining({
					id: "collaboration.control",
					supported: false,
					unsupportedReason: { code: "not_configured", message: "Collaboration is not configured" },
				}),
			],
			hostCapabilities: {
				interactions: ["select", "confirm"],
				semanticContent: ["markdown", "fields"],
			},
		});
	});

	test("returns typed incompatibility instead of silently downgrading", () => {
		const manifest = createSessionHostManifest({
			ompVersion: "17.2.10",
			framingVersions: [1, 2],
			limits: {
				maxFrameBytes: 1_048_576,
				maxReassembledFrameBytes: 67_108_864,
				maxArtifactReadBytes: 1_048_576,
				maxPendingObservations: 1_024,
				maxIdempotencyKeys: 1_024,
			},
			recovery,
			capabilities,
			mutations,
		});

		expect(
			negotiateSessionHost(manifest, {
				profile: { name: "omp.session", major: 4 },
				framingVersion: 2,
				hostCapabilities: { interactions: [], semanticContent: [] },
				requestedCapabilities: [],
			}),
		).toEqual({
			ok: false,
			code: "unsupported_semantic_version",
			message: "Unsupported omp.session semantic major 4",
			supportedProfiles: [{ name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 }],
		});
	});
});

class InMemorySessionAuthority implements SessionAuthority {
	readonly sessionId: string;
	#listeners = new Set<(observation: SessionAuthorityObservation) => void>();
	#snapshot: () => Promise<SessionAuthoritySnapshot>;
	#beforeSettle: (() => void) | undefined;
	#replay: (after: SessionJournalCursor) => Promise<SessionAuthorityReplay>;

	constructor(
		snapshot: () => Promise<SessionAuthoritySnapshot>,
		beforeSettle?: () => void,
		replay: (after: SessionJournalCursor) => Promise<SessionAuthorityReplay> = async after => ({
			observations: [],
			journalCursor: after,
		}),
		sessionId = "session-1",
	) {
		this.#snapshot = snapshot;
		this.#beforeSettle = beforeSettle;
		this.sessionId = sessionId;
		this.#replay = replay;
	}

	async snapshot(captureWatermark: () => void): Promise<SessionAuthoritySnapshot> {
		const snapshot = await this.#snapshot();
		captureWatermark();
		return snapshot;
	}
	replay(after: SessionJournalCursor): Promise<SessionAuthorityReplay> {
		return this.#replay(after);
	}

	subscribe(listener: (observation: SessionAuthorityObservation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(observation: SessionAuthorityObservation): void {
		for (const listener of this.#listeners) listener(observation);
	}

	dispose(): void {
		this.#listeners.clear();
	}

	async invoke(): Promise<never> {
		throw new Error("not used");
	}

	async settle(): Promise<{ state: "settled" }> {
		this.#beforeSettle?.();
		return { state: "settled" };
	}
}

describe("session host ordered observations", () => {
	test("watermarks observations already reflected by the authoritative snapshot", async () => {
		const snapshotReady = Promise.withResolvers<SessionAuthoritySnapshot>();
		const authority = new InMemorySessionAuthority(() => snapshotReady.promise);
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 });

		const opening = host.open();
		authority.emit({
			kind: "assistant_output_committed",
			payload: { text: "complete" },
			durability: "durable",
			eventId: "entry-1",
			journalCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			terminalSettlement: "none",
		});
		snapshotReady.resolve({
			revision: 3,
			state: { status: "active", lastEntryId: "entry-1" },
			journalCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
		});

		const subscription = await opening;
		expect(subscription.snapshot).toEqual({
			sessionId: "session-1",
			revision: 3,
			state: { status: "active", lastEntryId: "entry-1" },
			journalCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			watermark: { epoch: "epoch-1", sequence: 1 },
		});
		authority.emit({
			kind: "progress",
			payload: { phase: "next" },
			durability: "transient",
			terminalSettlement: "none",
		});
		expect((await subscription.observations.next()).value).toMatchObject({
			sessionId: "session-1",
			epoch: "epoch-1",
			sequence: 2,
			kind: "progress",
		});
		await subscription.close();
		await host.close();
	});

	test("replays the same durable event identity after reconnect", async () => {
		const authority = new InMemorySessionAuthority(async () => ({
			revision: 0,
			state: {},
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		}));
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 });
		authority.emit({
			kind: "tool_result_committed",
			payload: { toolCallId: "call-1" },
			durability: "durable",
			eventId: "entry-1",
			journalCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			terminalSettlement: "none",
		});

		const first = await host.open({ after: { epoch: "epoch-1", sequence: 0 }, snapshot: false });
		const delivered = (await first.observations.next()).value;
		await first.close();
		const reconnected = await host.open({ after: { epoch: "epoch-1", sequence: 0 }, snapshot: false });
		const replayed = (await reconnected.observations.next()).value;

		expect(replayed).toEqual(delivered);
		await reconnected.acknowledge(1);
		await reconnected.close();
		await host.close();
	});

	test("reports an explicit resnapshot gap when bounded replay is exceeded", async () => {
		const authority = new InMemorySessionAuthority(async () => ({
			revision: 0,
			state: {},
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		}));
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 2 });
		for (let index = 1; index <= 3; index++) {
			authority.emit({
				kind: "progress",
				payload: { index },
				durability: "transient",
				terminalSettlement: "none",
			});
		}

		const subscription = await host.open({ after: { epoch: "epoch-1", sequence: 0 }, snapshot: false });
		expect((await subscription.observations.next()).value).toEqual({
			type: "gap",
			sessionId: "session-1",
			epoch: "epoch-1",
			afterSequence: 0,
			firstAvailableSequence: 2,
			latestSequence: 3,
			recovery: "resnapshot",
		});
		await subscription.close();
		await host.close();
	});

	test("requires cumulative acknowledgement before delivering beyond the pending window", async () => {
		const authority = new InMemorySessionAuthority(async () => ({
			revision: 0,
			state: {},
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		}));
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 2 });
		const subscription = await host.open({ snapshot: false });
		for (let index = 1; index <= 2; index++) {
			authority.emit({
				kind: "progress",
				payload: { index },
				durability: "transient",
				terminalSettlement: "none",
			});
			expect((await subscription.observations.next()).value).toMatchObject({ type: "observation", sequence: index });
		}

		const overflow = subscription.observations.next();
		authority.emit({
			kind: "progress",
			payload: { index: 3 },
			durability: "transient",
			terminalSettlement: "none",
		});
		expect((await overflow).value).toEqual({
			type: "gap",
			sessionId: "session-1",
			epoch: "epoch-1",
			afterSequence: 0,
			firstAvailableSequence: 2,
			latestSequence: 3,
			recovery: "resnapshot",
		});
		await subscription.close();
		await host.close();
	});

	test("delivers final observations emitted while authority settlement drains", async () => {
		let authority: InMemorySessionAuthority;
		authority = new InMemorySessionAuthority(
			async () => ({
				revision: 0,
				state: {},
				journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
			}),
			() => {
				authority.emit({
					kind: "shutdown_settled",
					payload: {},
					durability: "transient",
					terminalSettlement: "completed",
				});
			},
		);
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 2 });
		const subscription = await host.open({ snapshot: false });

		const closing = host.close();

		expect((await subscription.observations.next()).value).toMatchObject({
			kind: "shutdown_settled",
			terminalSettlement: "completed",
		});
		await closing;
		expect((await subscription.observations.next()).done).toBe(true);
	});

	test("replays from a durable cursor after the observation epoch restarts", async () => {
		const authority = new InMemorySessionAuthority(
			async () => ({
				revision: 2,
				state: {},
				journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
			}),
			undefined,
			async () => ({
				observations: [
					{
						kind: "journal_entry",
						payload: { id: "entry-2" },
						durability: "durable",
						eventId: "session-1:entry-2",
						journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
						terminalSettlement: "none",
					},
				],
				journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
			}),
		);
		const host = new SessionHost(authority, { epoch: "epoch-2", maxBufferedObservations: 8 });

		const subscription = await host.open({
			afterCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			snapshot: false,
		});
		expect(subscription).toMatchObject({
			durableCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
			watermark: { sequence: 1 },
			replayComplete: true,
			replayPending: true,
		});
		expect(subscription.watermark.epoch).not.toBe("epoch-2");

		expect((await subscription.observations.next()).value).toMatchObject({
			epoch: subscription.watermark.epoch,
			sequence: 1,
			eventId: "session-1:entry-2",
			replay: true,
			journalCursor: { sessionId: "session-1", leafId: "entry-2", entryId: "entry-2" },
		});
		await subscription.replayBarrier;
		await subscription.close();
		await host.close();
	});

	test("isolates durable replay from the transport ring while preserving stable event ids", async () => {
		const durable = {
			kind: "journal_entry",
			payload: { id: "entry-1" },
			durability: "durable",
			eventId: "session-1:entry-1",
			journalCursor: { sessionId: "session-1", leafId: "entry-1", entryId: "entry-1" },
			terminalSettlement: "none",
		} as const satisfies SessionAuthorityObservation;
		const authority = new InMemorySessionAuthority(
			async () => ({
				revision: 1,
				state: {},
				journalCursor: durable.journalCursor,
			}),
			undefined,
			async () => ({ observations: [durable], journalCursor: durable.journalCursor }),
		);
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 });
		authority.emit(durable);

		const replay = await host.open({
			afterCursor: { sessionId: "session-1", leafId: null, entryId: null },
			snapshot: false,
		});
		const duplicate = (await replay.observations.next()).value;
		expect(duplicate).toMatchObject({
			epoch: replay.watermark.epoch,
			sequence: 1,
			eventId: "session-1:entry-1",
			replay: true,
		});
		expect(replay.watermark.epoch).not.toBe("epoch-1");
		await replay.close();

		const transportReplay = await host.open({ after: { epoch: "epoch-1", sequence: 0 }, snapshot: false });
		const original = (await transportReplay.observations.next()).value;
		authority.emit({
			kind: "progress",
			payload: { phase: "live" },
			durability: "transient",
			terminalSettlement: "none",
		});
		const live = (await transportReplay.observations.next()).value;
		expect([original, live]).toMatchObject([
			{ sequence: 1, eventId: "session-1:entry-1", replay: false },
			{ sequence: 2, eventId: "epoch-1:2", replay: false },
		]);
		await transportReplay.close();
		await host.close();
	});

	test("isolates concurrent session hosts and their observation streams", async () => {
		const createAuthority = (sessionId: string) =>
			new InMemorySessionAuthority(
				async () => ({
					revision: 0,
					state: { sessionId },
					journalCursor: { sessionId, leafId: null, entryId: null },
				}),
				undefined,
				undefined,
				sessionId,
			);
		const firstAuthority = createAuthority("session-1");
		const secondAuthority = createAuthority("session-2");
		const firstHost = new SessionHost(firstAuthority, { epoch: "epoch-1", maxBufferedObservations: 8 });
		const secondHost = new SessionHost(secondAuthority, { epoch: "epoch-2", maxBufferedObservations: 8 });
		const [first, second] = await Promise.all([
			firstHost.open({ snapshot: false }),
			secondHost.open({ snapshot: false }),
		]);

		firstAuthority.emit({
			kind: "progress",
			payload: { session: "first" },
			durability: "transient",
			terminalSettlement: "none",
		});
		secondAuthority.emit({
			kind: "progress",
			payload: { session: "second" },
			durability: "transient",
			terminalSettlement: "none",
		});

		expect((await first.observations.next()).value).toMatchObject({
			sessionId: "session-1",
			epoch: "epoch-1",
			sequence: 1,
			payload: { session: "first" },
		});
		expect((await second.observations.next()).value).toMatchObject({
			sessionId: "session-2",
			epoch: "epoch-2",
			sequence: 1,
			payload: { session: "second" },
		});

		await Promise.all([first.close(), second.close()]);
		await Promise.all([firstHost.close(), secondHost.close()]);
	});

	test("returns a resnapshot gap instead of waiting on a future transport cursor", async () => {
		const authority = new InMemorySessionAuthority(async () => ({
			revision: 0,
			state: {},
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		}));
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 8 });
		const subscription = await host.open({
			after: { epoch: "epoch-1", sequence: 5 },
			snapshot: false,
		});

		const outcome = await subscription.observations.next();
		expect(outcome).toEqual({
			done: false,
			value: {
				type: "gap",
				sessionId: "session-1",
				epoch: "epoch-1",
				afterSequence: 5,
				firstAvailableSequence: 1,
				latestSequence: 0,
				recovery: "resnapshot",
			},
		});
		await subscription.close();
		await host.close();
	});
	test("serializes durable replay handoffs and orders each replay before deferred live observations", async () => {
		const firstReplayStarted = Promise.withResolvers<void>();
		const releaseReplay = Promise.withResolvers<void>();
		let replayCalls = 0;
		const durable: SessionAuthorityObservation = {
			kind: "journal_entry",
			payload: { id: "entry-replay" },
			durability: "durable",
			eventId: "session-1:entry-replay",
			journalCursor: { sessionId: "session-1", leafId: "entry-replay", entryId: "entry-replay" },
			terminalSettlement: "none",
		};
		const authority = new InMemorySessionAuthority(
			async () => ({
				revision: 1,
				state: {},
				journalCursor: durable.journalCursor,
			}),
			undefined,
			async () => {
				replayCalls++;
				if (replayCalls === 1) firstReplayStarted.resolve();
				await releaseReplay.promise;
				return { observations: [durable], journalCursor: durable.journalCursor };
			},
		);
		const host = new SessionHost(authority, {
			epoch: "epoch-1",
			maxBufferedObservations: 8,
			maxSubscriptions: 2,
		});

		const firstOpening = host.open({
			afterCursor: { sessionId: "session-1", leafId: null, entryId: null },
			snapshot: false,
		});
		await firstReplayStarted.promise;
		const secondOpening = host.open({
			afterCursor: { sessionId: "session-1", leafId: null, entryId: null },
			snapshot: false,
		});
		authority.emit({
			kind: "progress",
			payload: { phase: "live" },
			durability: "transient",
			terminalSettlement: "none",
		});
		releaseReplay.resolve();

		const first = await firstOpening;
		const firstWatermark = first.watermark;
		const second = await secondOpening;
		expect(second.watermark.epoch).not.toBe(firstWatermark.epoch);

		const firstReplay = (await first.observations.next()).value;
		const firstLive = (await first.observations.next()).value;
		expect([firstReplay, firstLive]).toMatchObject([
			{ type: "observation", eventId: "session-1:entry-replay", replay: true, sequence: 1 },
			{
				type: "observation",
				epoch: firstWatermark.epoch,
				eventId: `${firstWatermark.epoch}:2`,
				replay: false,
				sequence: 2,
			},
		]);

		expect((await second.observations.next()).value).toMatchObject({
			type: "observation",
			epoch: second.watermark.epoch,
			sequence: 1,
			eventId: "session-1:entry-replay",
			replay: true,
		});
		expect(replayCalls).toBe(2);
		await Promise.all([first.close(), second.close()]);
		await host.close();
	});

	test("returns a typed resnapshot outcome when replay plus live handoff exceeds capacity", async () => {
		const replayStarted = Promise.withResolvers<void>();
		const releaseReplay = Promise.withResolvers<void>();
		const durable: SessionAuthorityObservation = {
			kind: "journal_entry",
			payload: { id: "entry-replay" },
			durability: "durable",
			eventId: "session-1:entry-replay",
			journalCursor: { sessionId: "session-1", leafId: "entry-replay", entryId: "entry-replay" },
			terminalSettlement: "none",
		};
		const authority = new InMemorySessionAuthority(
			async () => ({
				revision: 1,
				state: {},
				journalCursor: durable.journalCursor,
			}),
			undefined,
			async () => {
				replayStarted.resolve();
				await releaseReplay.promise;
				return { observations: [durable], journalCursor: durable.journalCursor };
			},
		);
		const host = new SessionHost(authority, { epoch: "epoch-1", maxBufferedObservations: 2 });
		const opening = host.open({
			afterCursor: { sessionId: "session-1", leafId: null, entryId: null },
			snapshot: false,
		});
		await replayStarted.promise;
		for (const phase of ["one", "two"]) {
			authority.emit({
				kind: "progress",
				payload: { phase },
				durability: "transient",
				terminalSettlement: "none",
			});
		}
		releaseReplay.resolve();
		await expect(opening).rejects.toBeInstanceOf(SessionCursorError);
		await expect(opening).rejects.toMatchObject({ code: "replay_limit_exceeded", recovery: "resnapshot" });
		await host.close();
	});

	test("rejects opens at subscription capacity and frees the slot on close", async () => {
		const authority = new InMemorySessionAuthority(async () => ({
			revision: 0,
			state: {},
			journalCursor: { sessionId: "session-1", leafId: null, entryId: null },
		}));
		const host = new SessionHost(authority, {
			epoch: "epoch-1",
			maxBufferedObservations: 8,
			maxSubscriptions: 1,
		});
		const first = await host.open({ snapshot: false });
		await expect(host.open({ snapshot: false })).rejects.toBeInstanceOf(SessionSubscriptionCapacityError);
		await first.close();
		const second = await host.open({ snapshot: false });
		await second.close();
		await host.close();
	});
});
