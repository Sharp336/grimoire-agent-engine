import { describe, expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	RpcCollaborationAuthorityError,
	type RpcCollaborationConnection,
	type RpcCollaborationFrame,
	type RpcCollaborationJoinResult,
	type RpcCollaborationLifecycleToken,
	RpcCollaborationManager,
	type RpcCollaborationMediaStore,
	type RpcCollaborationOpenEvents,
	type RpcCollaborationSessionAuthority,
	type RpcCollaborationTransportFactory,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collaboration";
import {
	projectCollaborationPayload,
	RpcCollaborationSessionMediaStore,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collaboration-transport";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { TempDir } from "@oh-my-pi/pi-utils";

class FakeConnection implements RpcCollaborationConnection {
	readonly role: "host" | "guest";
	readonly authority: "full" | "view";
	readonly prompts: Array<{ message: string; images?: ImageContent[] }> = [];
	abortCount = 0;
	leaveReasons: string[] = [];
	revoked: string[] = [];
	resyncCount = 0;
	rotateCount = 0;

	constructor(role: "host" | "guest", authority: "full" | "view") {
		this.role = role;
		this.authority = authority;
	}

	async leave(reason: string): Promise<void> {
		this.leaveReasons.push(reason);
	}
	async revoke(participantId: string): Promise<void> {
		this.revoked.push(participantId);
	}
	async rotate(): Promise<{ link: string; viewLink: string }> {
		this.rotateCount += 1;
		return { link: "wss://relay/r/rotated.full", viewLink: "wss://relay/r/rotated.view" };
	}
	sendPrompt(message: string, images?: ImageContent[]): void {
		this.prompts.push({ message, images });
	}
	sendAbort(): void {
		this.abortCount += 1;
	}
	requestResync(): void {
		this.resyncCount += 1;
	}
}
class FakeFactory implements RpcCollaborationTransportFactory {
	events: RpcCollaborationOpenEvents | undefined;
	readonly eventHistory: RpcCollaborationOpenEvents[] = [];
	connection: FakeConnection | undefined;

	async host(_options: { relayUrl?: string; webUrl?: string }, events: RpcCollaborationOpenEvents) {
		this.events = events;
		this.eventHistory.push(events);
		this.connection = new FakeConnection("host", "full");
		return {
			connection: this.connection,
			links: {
				link: "wss://relay/r/room.full",
				viewLink: "wss://relay/r/room.view",
				webLink: "https://web/room/full",
				webViewLink: "https://web/room/view",
			},
			participants: [
				{ participantId: "host", displayName: "owner", role: "host" as const, authority: "full" as const },
			],
		};
	}

	async join(_options: { link: string; displayName?: string }, events: RpcCollaborationOpenEvents) {
		this.events = events;
		this.eventHistory.push(events);
		this.connection = new FakeConnection("guest", _options.link.endsWith(".view") ? "view" : "full");
		return { connection: this.connection };
	}
}

class DeferredJoinFactory implements RpcCollaborationTransportFactory {
	readonly opened = Promise.withResolvers<RpcCollaborationJoinResult>();
	events: RpcCollaborationOpenEvents | undefined;

	async host(): Promise<never> {
		throw new Error("host not used");
	}

	async join(
		_options: { link: string; displayName?: string },
		events: RpcCollaborationOpenEvents,
	): Promise<RpcCollaborationJoinResult> {
		this.events = events;
		return this.opened.promise;
	}
}
class SequenceHostFactory implements RpcCollaborationTransportFactory {
	readonly events: RpcCollaborationOpenEvents[] = [];
	readonly connections: FakeConnection[];

	constructor(connections: FakeConnection[]) {
		this.connections = connections;
	}

	async host(_options: { relayUrl?: string; webUrl?: string }, events: RpcCollaborationOpenEvents) {
		this.events.push(events);
		const connection = this.connections.shift();
		if (!connection) throw new Error("no connection available");
		return {
			connection,
			links: { link: "wss://relay/room", viewLink: "wss://relay/room.view" },
			participants: [
				{ participantId: "host", displayName: "owner", role: "host" as const, authority: "full" as const },
			],
		};
	}

	async join(): Promise<never> {
		throw new Error("join not used");
	}
}

class FakeMediaStore implements RpcCollaborationMediaStore {
	readonly lifecycleTokens: Array<RpcCollaborationLifecycleToken | undefined> = [];
	readonly values = new Map<string, { mediaType: string; data: Uint8Array }>();
	#nextId = 0;
	async save(mediaType: string, data: Uint8Array, lifecycleToken?: RpcCollaborationLifecycleToken) {
		const mediaId = String(this.#nextId++);
		this.values.set(mediaId, { mediaType, data });
		this.lifecycleTokens.push(lifecycleToken);
		return {
			mediaId,
			mediaType,
			byteLength: data.byteLength,
			sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
		};
	}

	async read(mediaId: string, offset?: number, length?: number) {
		const stored = this.values.get(mediaId);
		if (!stored) throw new Error("missing media");
		const start = offset ?? 0;
		const end = Math.min(stored.data.byteLength, start + (length ?? stored.data.byteLength));
		const bytes = stored.data.subarray(start, end);
		return {
			mediaId,
			mediaType: stored.mediaType,
			offset: start,
			byteLength: bytes.byteLength,
			eof: end === stored.data.byteLength,
			encoding: "base64" as const,
			data: Buffer.from(bytes).toString("base64"),
		};
	}
}

function makeManager(options: { maxRetainedFrames?: number; sessionId?: string } = {}) {
	const factory = new FakeFactory();
	const media = new FakeMediaStore();
	const frames: RpcCollaborationFrame[] = [];
	const manager = new RpcCollaborationManager({
		factory,
		media,
		getSessionId: () => options.sessionId ?? "session-1",
		output: frame => frames.push(frame),
		maxRetainedFrames: options.maxRetainedFrames,
	});
	return { manager, factory, media, frames };
}

describe("RPC collaboration authority", () => {
	test("hosts with separate full and view links and exposes the active role", async () => {
		const { manager } = makeManager();
		const snapshot = await manager.host({ relayUrl: "wss://relay", webUrl: "https://web" });

		expect(snapshot).toMatchObject({
			state: "connected",
			role: "host",
			authority: "full",
			authoritative: true,
			sessionId: "session-1",
			links: {
				link: "wss://relay/r/room.full",
				viewLink: "wss://relay/r/room.view",
			},
		});
	});

	test("joins as a non-authoritative full or view replica and leaves cleanly", async () => {
		const { manager, factory } = makeManager();
		const joined = await manager.join({ link: "wss://relay/r/room.view", displayName: "reader" });
		expect(joined).toMatchObject({ role: "guest", authority: "view", authoritative: false, state: "connected" });

		await manager.leave("done");
		expect(factory.connection?.leaveReasons).toEqual(["done"]);
		expect(manager.snapshot()).toMatchObject({ state: "off", role: "none", authority: "none" });
	});

	test("enforces view-only and host-only authority", async () => {
		const { manager } = makeManager();
		await manager.join({ link: "wss://relay/r/room.view" });
		expect(() => manager.sendPrompt("blocked")).toThrow(RpcCollaborationAuthorityError);
		expect(() => manager.sendAbort()).toThrow(RpcCollaborationAuthorityError);
		await expect(manager.revoke("guest-1")).rejects.toBeInstanceOf(RpcCollaborationAuthorityError);
		await expect(manager.rotate()).rejects.toBeInstanceOf(RpcCollaborationAuthorityError);
	});

	test("revokes peer write authority and rotates full-access links", async () => {
		const { manager, factory } = makeManager();
		await manager.host({});
		factory.events?.participants([
			{ participantId: "host", displayName: "owner", role: "host", authority: "full" },
			{ participantId: "7", displayName: "guest", role: "guest", authority: "full" },
		]);

		await manager.revoke("7");
		const rotated = await manager.rotate();
		expect(factory.connection?.revoked).toEqual(["7"]);
		expect(factory.connection?.rotateCount).toBe(1);
		expect(rotated.links?.link).toEndWith("rotated.full");
	});

	test("atomically advances host authority while keeping transport callbacks bound", async () => {
		const factory = new FakeFactory();
		const frames: RpcCollaborationFrame[] = [];
		let sessionAuthority: RpcCollaborationSessionAuthority = Object.freeze({
			sessionId: "session-1",
			sessionGeneration: 4,
			authorityGeneration: 8,
		});
		const manager = new RpcCollaborationManager({
			factory,
			media: new FakeMediaStore(),
			getSessionId: () => sessionAuthority.sessionId,
			getSessionAuthority: () => sessionAuthority,
			output: frame => frames.push(frame),
		});
		await manager.host({});
		const events = factory.events;
		if (!events) throw new Error("missing event bundle");
		events.participants([
			{ participantId: "host", displayName: "owner", role: "host", authority: "full" },
			{ participantId: "7", displayName: "guest", role: "guest", authority: "full" },
		]);
		const originalToken = events.lifecycleToken;
		if (!originalToken) throw new Error("missing lifecycle token");

		await manager.revoke("7", expected => {
			expect(expected).toEqual(sessionAuthority);
			sessionAuthority = Object.freeze({
				...expected,
				authorityGeneration: expected.authorityGeneration + 1,
			});
			return sessionAuthority;
		});

		const revokedToken = events.lifecycleToken;
		expect(revokedToken).toBeDefined();
		expect(revokedToken).not.toBe(originalToken);
		expect(manager.isLifecycleTokenCurrent(originalToken)).toBe(false);
		if (revokedToken) expect(manager.isLifecycleTokenCurrent(revokedToken)).toBe(true);

		events.participants([
			{ participantId: "host", displayName: "owner", role: "host", authority: "full" },
			{ participantId: "8", displayName: "new guest", role: "guest", authority: "full" },
		]);
		expect(manager.snapshot().participants.at(-1)?.participantId).toBe("8");

		await manager.rotate(expected => {
			sessionAuthority = Object.freeze({
				...expected,
				authorityGeneration: expected.authorityGeneration + 1,
			});
			return sessionAuthority;
		});
		expect(events.lifecycleToken?.sessionAuthority.authorityGeneration).toBe(10);
		expect(frames.at(-1)).toMatchObject({
			type: "collaboration_state",
			snapshot: { links: { link: "wss://relay/r/rotated.full" } },
		});
		const rotatedToken = events.lifecycleToken;
		if (!rotatedToken) throw new Error("missing rotated lifecycle token");
		sessionAuthority = Object.freeze({
			...sessionAuthority,
			authorityGeneration: sessionAuthority.authorityGeneration + 1,
		});
		const reboundToken = manager.replaceAuthorityToken(rotatedToken, sessionAuthority);
		expect(reboundToken.collaborationGeneration).toBe(rotatedToken.collaborationGeneration);
		expect(reboundToken.sessionAuthority).toEqual({
			sessionId: "session-1",
			sessionGeneration: 4,
			authorityGeneration: 11,
		});
		expect(() => manager.replaceAuthorityToken(rotatedToken, sessionAuthority)).toThrow("lifecycle token");
	});

	test("serializes remote guest authority changes and rebinds transport media", async () => {
		const factory = new FakeFactory();
		const media = new FakeMediaStore();
		const frames: RpcCollaborationFrame[] = [];
		const firstCleanup = Promise.withResolvers<void>();
		const secondCleanup = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const secondInstalled = Promise.withResolvers<void>();
		const cleanupGates = [firstCleanup, secondCleanup];
		let transitionCount = 0;
		let sessionAuthority: RpcCollaborationSessionAuthority = Object.freeze({
			sessionId: "session-1",
			sessionGeneration: 2,
			authorityGeneration: 5,
		});
		const manager = new RpcCollaborationManager({
			factory,
			media,
			getSessionId: () => sessionAuthority.sessionId,
			getSessionAuthority: () => sessionAuthority,
			transitionAuthority: async (captureAuthority, applyAuthority, installAuthority) => {
				const transitionIndex = transitionCount++;
				const expected = captureAuthority();
				expect(expected).toEqual(sessionAuthority);
				if (transitionIndex === 1) secondStarted.resolve();
				applyAuthority();
				await cleanupGates[transitionIndex]?.promise;
				sessionAuthority = Object.freeze({
					...expected,
					authorityGeneration: expected.authorityGeneration + 1,
				});
				installAuthority(sessionAuthority);
				if (transitionIndex === 1) secondInstalled.resolve();
			},
			output: frame => frames.push(frame),
		});
		await manager.join({ link: "wss://relay/r/room.full" });
		const events = factory.events;
		if (!events) throw new Error("missing event bundle");
		const initialToken = events.lifecycleToken;
		if (!initialToken) throw new Error("missing initial lifecycle token");

		const framesBeforeChanges = frames.length;
		events.authority("view");
		events.participants([{ participantId: "queued", displayName: "queued", role: "guest", authority: "view" }]);
		const queuedMedia = events.media({ mediaType: "image/png", data: Uint8Array.from([1]) });
		events.authority("full");
		expect(transitionCount).toBe(1);
		expect(manager.snapshot().authority).toBe("view");
		expect(manager.snapshot().participants).toEqual([]);
		expect(events.lifecycleToken).toBeUndefined();
		expect(media.values.size).toBe(0);
		expect(frames).toHaveLength(framesBeforeChanges);

		firstCleanup.resolve();
		await secondStarted.promise;
		expect(
			frames.some(frame => frame.type === "collaboration_state" && frame.snapshot.authority === "view"),
		).toBeTrue();
		expect(transitionCount).toBe(2);
		expect(events.lifecycleToken).toBeUndefined();
		expect(manager.isLifecycleTokenCurrent(initialToken)).toBe(false);
		await queuedMedia;
		expect(manager.snapshot().participants.at(-1)?.participantId).toBe("queued");
		expect(media.lifecycleTokens.at(-1)?.sessionAuthority.authorityGeneration).toBe(6);

		secondCleanup.resolve();
		await secondInstalled.promise;
		await events.media({ mediaType: "image/png", data: Uint8Array.from([2]) });
		expect(
			frames.some(frame => frame.type === "collaboration_state" && frame.snapshot.authority === "full"),
		).toBeTrue();
		expect(manager.snapshot().authority).toBe("full");
		expect(events.lifecycleToken?.sessionAuthority.authorityGeneration).toBe(7);
		expect(media.lifecycleTokens.at(-1)).toBe(events.lifecycleToken);
	});
	test("tracks replication cursor and acknowledges retained non-authoritative frames", async () => {
		const { manager, factory, frames } = makeManager();
		await manager.join({ link: "wss://relay/r/room.full" });
		factory.events?.replicated({ kind: "snapshot", payload: { title: "remote" } });
		factory.events?.replicated({ kind: "event", payload: { type: "agent_start" } });

		const replicated = frames.filter(frame => frame.type === "collaboration_replicated");
		expect(replicated).toHaveLength(2);
		expect(replicated[0]).toMatchObject({ authoritative: false, cursor: { generation: 1, sequence: 1 } });
		expect(replicated[1]).toMatchObject({ cursor: { generation: 1, sequence: 2 } });
		expect(manager.acknowledge({ generation: 1, sequence: 1 })).toMatchObject({ acknowledged: 1, retained: 1 });
		expect(manager.snapshot().replication).toMatchObject({
			latestSequence: 2,
			acknowledgedSequence: 1,
			retainedFrames: 1,
		});
	});

	test("preserves typed projection loss metadata on replicated frames", async () => {
		const { manager, factory, frames } = makeManager();
		await manager.join({ link: "wss://relay/r/room.full" });
		factory.events?.replicated({
			kind: "event",
			payload: { items: [] },
			projection: {
				fidelity: "lossy",
				losses: [
					{
						path: "/items",
						reason: "array_item_limit",
						omittedCount: 1,
						recoverable: true,
					},
				],
				fullPayload: {
					mediaId: "full",
					mediaType: "application/json",
					byteLength: 12,
					sha256: "abc",
				},
			},
		});

		expect(frames.at(-1)).toMatchObject({
			type: "collaboration_replicated",
			projection: {
				fidelity: "lossy",
				losses: [{ path: "/items", reason: "array_item_limit", recoverable: true }],
				fullPayload: { mediaId: "full", mediaType: "application/json" },
			},
		});
	});

	test("marks gaps stale and requests resync when the unacknowledged window overflows", async () => {
		const { manager, factory, frames } = makeManager({ maxRetainedFrames: 2 });
		await manager.join({ link: "wss://relay/r/room.full" });
		factory.events?.replicated({ kind: "event", payload: { n: 1 } });
		factory.events?.replicated({ kind: "event", payload: { n: 2 } });
		factory.events?.replicated({ kind: "event", payload: { n: 3 } });

		expect(factory.connection?.resyncCount).toBe(1);
		expect(manager.snapshot()).toMatchObject({ state: "stale", replication: { stale: true, retainedFrames: 0 } });
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "collaboration_gap", reason: "backpressure_overflow" }),
		);
		expect(frames).toContainEqual(expect.objectContaining({ type: "collaboration_stale" }));
	});

	test("drops old-generation replication after a gap until resync starts a new generation", async () => {
		const { manager, factory, frames } = makeManager({ maxRetainedFrames: 2 });
		await manager.join({ link: "wss://relay/r/room.full" });
		factory.events?.replicated({ kind: "event", payload: { n: 1 } });
		factory.events?.replicated({ kind: "event", payload: { n: 2 } });
		factory.events?.replicated({ kind: "event", payload: { n: 3 } });
		const replicatedBeforeStaleFrame = frames.filter(frame => frame.type === "collaboration_replicated");

		factory.events?.replicated({ kind: "event", payload: { n: 4 } });

		expect(frames.filter(frame => frame.type === "collaboration_replicated")).toEqual(replicatedBeforeStaleFrame);
		expect(manager.snapshot().replication).toMatchObject({
			generation: 1,
			latestSequence: 3,
			stale: true,
		});

		factory.events?.status("connected");
		factory.events?.replicated({ kind: "snapshot", payload: { n: 5 } });
		expect(frames.at(-1)).toMatchObject({
			type: "collaboration_replicated",
			cursor: { generation: 2, sequence: 1 },
		});
	});

	test("reconnects with a new generation and rejects stale acknowledgements", async () => {
		const { manager, factory } = makeManager();
		await manager.join({ link: "wss://relay/r/room.full" });
		factory.events?.replicated({ kind: "event", payload: { n: 1 } });
		factory.events?.status("reconnecting", "network_lost");
		expect(manager.snapshot().state).toBe("reconnecting");
		factory.events?.status("connected");
		factory.events?.replicated({ kind: "snapshot", payload: { n: 2 } });

		expect(manager.snapshot().replication.generation).toBe(2);
		expect(() => manager.acknowledge({ generation: 1, sequence: 1 })).toThrow("generation");
	});

	test("externalizes collaboration media and serves bounded binary ranges", async () => {
		const { manager, factory, frames } = makeManager();
		await manager.join({ link: "wss://relay/r/room.full" });
		await factory.events?.media({ mediaType: "image/png", data: Uint8Array.from([1, 2, 3, 4]) });
		const replicated = frames.find(frame => frame.type === "collaboration_replicated");

		expect(replicated).toMatchObject({
			kind: "media",
			media: { mediaId: "0", mediaType: "image/png", byteLength: 4 },
		});
		expect(await manager.readMedia("0", 1, 2)).toMatchObject({ offset: 1, byteLength: 2, eof: false, data: "AgM=" });
	});
	test("closes a factory result that resolves after leave invalidates its lifecycle token", async () => {
		const factory = new DeferredJoinFactory();
		const manager = new RpcCollaborationManager({
			factory,
			media: new FakeMediaStore(),
			getSessionId: () => "session-1",
			output: () => {},
		});
		const opening = manager.join({ link: "wss://relay/r/room.full" });
		await Promise.resolve();
		await manager.leave("superseded");

		const late = new FakeConnection("guest", "full");
		factory.opened.resolve({ connection: late });
		await expect(opening).rejects.toThrow("lifecycle token");
		expect(late.leaveReasons).toEqual(["stale_open"]);
		expect(manager.snapshot()).toMatchObject({ state: "off", role: "none", authority: "none" });
	});

	test("coalesces leaves while allowing a new generation without a stale reset", async () => {
		const first = new FakeConnection("host", "full");
		const second = new FakeConnection("host", "full");
		const leaveGate = Promise.withResolvers<void>();
		first.leave = async reason => {
			first.leaveReasons.push(reason);
			await leaveGate.promise;
		};
		const factory = new SequenceHostFactory([first, second]);
		const manager = new RpcCollaborationManager({
			factory,
			media: new FakeMediaStore(),
			getSessionId: () => "session-1",
			output: () => {},
		});
		await manager.host({});
		const leaveA = manager.leave("first");
		const leaveB = manager.leave("second");
		expect(leaveB).toBe(leaveA);

		await manager.host({});
		expect(manager.snapshot()).toMatchObject({ state: "connected", role: "host" });
		leaveGate.resolve();
		await leaveA;
		expect(manager.snapshot()).toMatchObject({ state: "connected", role: "host" });
		expect(first.leaveReasons).toEqual(["first"]);
		expect(second.leaveReasons).toEqual([]);
	});

	test("rejects callbacks from an earlier connection after a new generation starts", async () => {
		const { manager, factory, frames } = makeManager();
		await manager.host({});
		const eventsA = factory.eventHistory[0];
		if (!eventsA) throw new Error("missing first event bundle");
		await manager.leave("replace");
		await manager.host({});

		eventsA.participants([{ participantId: "old", displayName: "old", role: "guest", authority: "full" }]);
		eventsA.replicated({ kind: "old", payload: { stale: true } });
		eventsA.status("reconnecting", "network_lost");

		expect(manager.snapshot()).toMatchObject({ state: "connected", role: "host" });
		expect(manager.snapshot().participants).toEqual([
			{ participantId: "host", displayName: "owner", role: "host", authority: "full" },
		]);
		expect(frames.filter(frame => frame.type === "collaboration_replicated")).toHaveLength(0);
	});

	test("drops media while stale and keeps prior-generation media unreadable", async () => {
		const { manager, factory, media, frames } = makeManager({ maxRetainedFrames: 1 });
		await manager.join({ link: "wss://relay/r/room.full" });
		const events = factory.events;
		if (!events) throw new Error("missing event bundle");
		await events.media({ mediaType: "image/png", data: Uint8Array.from([1]) });
		factory.events?.replicated({ kind: "one", payload: { n: 1 } });
		factory.events?.replicated({ kind: "two", payload: { n: 2 } });
		const savedBeforeStale = media.values.size;
		const framesBeforeStale = frames.filter(frame => frame.type === "collaboration_replicated").length;

		await expect(events.media({ mediaType: "image/png", data: Uint8Array.from([2]) })).rejects.toThrow();
		expect(media.values.size).toBe(savedBeforeStale);
		expect(frames.filter(frame => frame.type === "collaboration_replicated")).toHaveLength(framesBeforeStale);
	});

	test("scopes media reads to the active collaboration generation", async () => {
		const { manager, factory } = makeManager();
		await manager.join({ link: "wss://relay/r/room.full" });
		const mediaA = await factory.events?.media({ mediaType: "image/png", data: Uint8Array.from([1]) });
		if (!mediaA) throw new Error("missing first media descriptor");
		expect(await manager.readMedia(mediaA.mediaId)).toMatchObject({ mediaId: mediaA.mediaId });

		await manager.leave("room_changed");
		await expect(manager.readMedia(mediaA.mediaId)).rejects.toThrow();

		await manager.join({ link: "wss://relay/r/room.full" });
		const mediaB = await factory.events?.media({ mediaType: "image/png", data: Uint8Array.from([2]) });
		if (!mediaB) throw new Error("missing second media descriptor");
		await expect(manager.readMedia(mediaA.mediaId)).rejects.toThrow();
		expect(await manager.readMedia(mediaB.mediaId)).toMatchObject({ mediaId: mediaB.mediaId });
	});

	test("terminates when the bound local session changes", async () => {
		let sessionId = "session-1";
		const factory = new FakeFactory();
		const manager = new RpcCollaborationManager({
			factory,
			media: new FakeMediaStore(),
			getSessionId: () => sessionId,
			output: () => {},
		});
		await manager.host({});
		sessionId = "session-2";

		await manager.assertSessionIsolation();
		expect(factory.connection?.leaveReasons).toEqual(["session_changed"]);
		expect(manager.snapshot()).toMatchObject({ state: "off", role: "none" });
	});

	test("persists collaboration media with non-tool provenance", async () => {
		using temp = TempDir.createSync("@omp-rpc-collaboration-media-");
		const artifacts = new ArtifactManager(temp.path());
		const store = new RpcCollaborationSessionMediaStore(
			() => artifacts,
			() => "session-1",
		);

		const media = await store.save("image/png", Uint8Array.from([1, 2, 3]));
		expect(await artifacts.describe(media.mediaId)).toMatchObject({
			mediaType: "image/png",
			byteLength: 3,
			provenance: { source: "collaboration_media" },
			related: { sessionId: "session-1" },
		});
		expect(await store.read(media.mediaId, 1, 2)).toMatchObject({
			offset: 1,
			byteLength: 2,
			eof: true,
			data: "AgM=",
		});
	});

	test("reports projection limits and persists a full JSON reference", async () => {
		const stored: Uint8Array[] = [];
		const events = {
			status: () => {},
			participants: () => {},
			authority: () => {},
			replicated: () => {},
			media: async ({ mediaType, data }) => {
				stored.push(data);
				return {
					mediaId: "full",
					mediaType,
					byteLength: data.byteLength,
					sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
				};
			},
			gap: () => {},
		} satisfies RpcCollaborationOpenEvents;
		const original = { items: Array.from({ length: 4097 }, (_, index) => index) };

		const projected = await projectCollaborationPayload(original, events);

		if (
			projected.payload === null ||
			Array.isArray(projected.payload) ||
			typeof projected.payload !== "object" ||
			!Array.isArray(projected.payload.items)
		) {
			throw new Error("Expected projected items");
		}
		expect(projected.payload.items).toHaveLength(4096);
		expect(projected.projection).toMatchObject({
			fidelity: "lossy",
			losses: [
				{
					path: "/items",
					reason: "array_item_limit",
					omittedCount: 1,
					recoverable: true,
				},
			],
			fullPayload: { mediaId: "full", mediaType: "application/json" },
		});
		expect(JSON.parse(Buffer.from(stored[0]).toString("utf8"))).toEqual(original);
	});

	test("surfaces unrecoverable truncation inherited from the collaboration transport", async () => {
		let mediaCalls = 0;
		const events = {
			status: () => {},
			participants: () => {},
			authority: () => {},
			replicated: () => {},
			media: async ({ mediaType, data }) => {
				mediaCalls += 1;
				return { mediaId: "unused", mediaType, byteLength: data.byteLength, sha256: "unused" };
			},
			gap: () => {},
		} satisfies RpcCollaborationOpenEvents;

		const projected = await projectCollaborationPayload(
			{ text: "partial\n…[42 chars elided for collab session]" },
			events,
		);

		expect(projected.projection).toEqual({
			fidelity: "lossy",
			losses: [
				{
					path: "/text",
					reason: "source_transport_elision",
					omittedCount: 42,
					recoverable: false,
				},
			],
		});
		expect(mediaCalls).toBe(0);
	});
});
