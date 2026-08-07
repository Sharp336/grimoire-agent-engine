import { describe, expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	RpcCollaborationAuthorityError,
	type RpcCollaborationConnection,
	type RpcCollaborationFrame,
	RpcCollaborationManager,
	type RpcCollaborationMediaStore,
	type RpcCollaborationOpenEvents,
	type RpcCollaborationTransportFactory,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collaboration";
import { RpcCollaborationSessionMediaStore } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collaboration-transport";
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
	connection: FakeConnection | undefined;

	async host(_options: { relayUrl?: string; webUrl?: string }, events: RpcCollaborationOpenEvents) {
		this.events = events;
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
		this.connection = new FakeConnection("guest", _options.link.endsWith(".view") ? "view" : "full");
		return { connection: this.connection };
	}
}

class FakeMediaStore implements RpcCollaborationMediaStore {
	readonly values = new Map<string, { mediaType: string; data: Uint8Array }>();
	#nextId = 0;

	async save(mediaType: string, data: Uint8Array) {
		const mediaId = String(this.#nextId++);
		this.values.set(mediaId, { mediaType, data });
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
});
