import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { importRoomKey } from "../../collab/crypto";
import { collabDisplayName } from "../../collab/display-name";
import { CollabHost, type CollabHostContext, type CollabHostPeer } from "../../collab/host";
import { COLLAB_PROTO, type CollabFrame, DEFAULT_RELAY_URL, parseCollabLink } from "../../collab/protocol";
import { CollabSocket } from "../../collab/relay-client";
import type { AgentSession } from "../../session/agent-session";
import { type ArtifactManager, MAX_ARTIFACT_RANGE_BYTES } from "../../session/artifacts";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcCollaborationConnection,
	RpcCollaborationHostResult,
	RpcCollaborationJoinResult,
	RpcCollaborationJsonValue,
	RpcCollaborationMediaDescriptor,
	RpcCollaborationMediaRange,
	RpcCollaborationMediaStore,
	RpcCollaborationOpenEvents,
	RpcCollaborationParticipant,
	RpcCollaborationTransportFactory,
} from "./rpc-collaboration";
import { sanitizeRpcText } from "./rpc-safe-text";

const JOIN_TIMEOUT_MS = 30_000;
const MAX_PROJECTED_DEPTH = 32;
const MAX_PROJECTED_ARRAY_ITEMS = 4096;
const MAX_PROJECTED_OBJECT_KEYS = 256;
const MAX_MEDIA_TYPE_BYTES = 256;

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;

interface PendingSnapshot {
	welcome: WelcomeFrame;
	entries: SnapshotChunkFrame["entries"];
}

interface InitialReplica {
	welcome: WelcomeFrame;
	entries: SnapshotChunkFrame["entries"];
}

function projectHostParticipants(displayName: string, peers: readonly CollabHostPeer[]): RpcCollaborationParticipant[] {
	return [
		{ participantId: "host", displayName, role: "host", authority: "full" },
		...peers.map(peer => ({
			participantId: peer.participantId,
			displayName: peer.name,
			role: "guest" as const,
			authority: peer.canWrite ? ("full" as const) : ("view" as const),
		})),
	];
}

function projectGuestParticipants(
	frame: WelcomeFrame | Extract<CollabFrame, { t: "state" }>,
): RpcCollaborationParticipant[] {
	const participants = frame.state.participants;
	let guestIndex = 0;
	return participants.map(participant => {
		const role = participant.role;
		const participantId = role === "host" ? "host" : `guest-${++guestIndex}`;
		return {
			participantId,
			displayName: participant.name,
			role,
			authority: participant.readOnly ? "view" : "full",
		};
	});
}

async function projectUnknown(
	value: unknown,
	events: RpcCollaborationOpenEvents,
	depth = 0,
): Promise<RpcCollaborationJsonValue> {
	if (depth >= MAX_PROJECTED_DEPTH) return null;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) {
		const projected: RpcCollaborationJsonValue[] = [];
		for (const item of value.slice(0, MAX_PROJECTED_ARRAY_ITEMS)) {
			projected.push(await projectUnknown(item, events, depth + 1));
		}
		return projected;
	}
	if (!isRecord(value)) return null;
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
		let bytes: Uint8Array;
		try {
			bytes = Buffer.from(value.data, "base64");
		} catch {
			return { type: "image", unavailable: true };
		}
		const media = await events.media({ mediaType: value.mimeType, data: bytes });
		return {
			type: "image",
			media: {
				mediaId: media.mediaId,
				mediaType: media.mediaType,
				byteLength: media.byteLength,
				sha256: media.sha256,
			},
		};
	}
	const projected: Record<string, RpcCollaborationJsonValue> = {};
	for (const [key, child] of Object.entries(value).slice(0, MAX_PROJECTED_OBJECT_KEYS)) {
		if (child === undefined) continue;
		projected[key] = await projectUnknown(child, events, depth + 1);
	}
	return projected;
}

class RpcCollaborationHostConnection implements RpcCollaborationConnection {
	readonly role = "host";
	readonly authority = "full";
	readonly #host: CollabHost;

	constructor(host: CollabHost) {
		this.#host = host;
	}

	leave(reason: string): Promise<void> {
		return this.#host.stop(reason);
	}

	async revoke(participantId: string): Promise<void> {
		this.#host.revokeWriteAccess(participantId);
	}

	async rotate() {
		return this.#host.rotateWriteAccess();
	}

	sendPrompt(_message: string, _images?: ImageContent[]): void {
		throw new Error("The collaboration host cannot send a guest prompt");
	}

	sendAbort(): void {
		throw new Error("The collaboration host cannot send a guest interrupt");
	}

	requestResync(): void {
		// Host replication is authoritative and does not consume an RPC acknowledgement window.
	}
}

class RpcCollaborationGuestConnection implements RpcCollaborationConnection {
	readonly role = "guest";
	readonly #socket: CollabSocket;
	readonly #events: RpcCollaborationOpenEvents;
	readonly #displayName: string;
	readonly #writeToken: string | undefined;
	readonly #initial = Promise.withResolvers<InitialReplica>();
	#pending: PendingSnapshot | null = null;
	#applyChain: Promise<void> = Promise.resolve();
	#active = false;
	#joined = false;
	#left = false;
	#readOnly: boolean;
	#deferredFrames: CollabFrame[] = [];
	#joinTimer: Timer | null = null;

	constructor(socket: CollabSocket, events: RpcCollaborationOpenEvents, displayName: string, writeToken?: string) {
		this.#socket = socket;
		this.#events = events;
		this.#displayName = displayName;
		this.#writeToken = writeToken;
		this.#readOnly = writeToken === undefined;
	}

	get authority(): "full" | "view" {
		return this.#readOnly ? "view" : "full";
	}

	async open(): Promise<InitialReplica> {
		this.#socket.onDrop = () => this.#events.gap();
		this.#socket.onOpen = () => {
			this.#pending = null;
			this.#socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: this.#displayName,
				writeToken: this.#writeToken,
			});
		};
		this.#socket.onFrame = frame => {
			this.#applyChain = this.#applyChain
				.then(() => this.#handleFrame(frame))
				.catch(cause => {
					logger.warn("rpc collaboration guest frame failed", { error: String(cause) });
					if (!this.#joined) this.#initial.reject(cause);
					else this.#events.gap();
				});
		};
		this.#socket.onClose = (reason, willReconnect) => {
			if (this.#left) return;
			if (!this.#joined) this.#initial.reject(new Error(reason));
			this.#events.status(willReconnect ? "reconnecting" : "failed", willReconnect ? "network_lost" : "room_closed");
		};
		this.#socket.connect();
		this.#joinTimer = setTimeout(
			() => this.#initial.reject(new Error("timed out waiting for collaboration snapshot")),
			JOIN_TIMEOUT_MS,
		);
		try {
			return await this.#initial.promise;
		} finally {
			this.#clearJoinTimer();
		}
	}

	async activate(initial: InitialReplica): Promise<void> {
		this.#active = true;
		await this.#emitSnapshot(initial);
		const deferred = this.#deferredFrames;
		this.#deferredFrames = [];
		for (const frame of deferred) await this.#emitLiveFrame(frame);
	}

	async leave(_reason: string): Promise<void> {
		this.#left = true;
		this.#clearJoinTimer();
		this.#socket.close();
	}

	async revoke(_participantId: string): Promise<void> {
		throw new Error("Only a collaboration host can revoke access");
	}

	async rotate(): Promise<{ link: string; viewLink: string; webLink?: string; webViewLink?: string }> {
		throw new Error("Only a collaboration host can rotate access");
	}

	sendPrompt(message: string, images?: ImageContent[]): void {
		if (this.#readOnly) throw new Error("Collaboration guest access is read-only");
		this.#socket.send({ t: "prompt", text: message, images: images && images.length > 0 ? images : undefined });
	}

	sendAbort(): void {
		if (this.#readOnly) throw new Error("Collaboration guest access is read-only");
		this.#socket.send({ t: "abort" });
	}

	requestResync(): void {
		this.#pending = null;
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#displayName,
			writeToken: this.#writeToken,
		});
	}

	async #handleFrame(frame: CollabFrame): Promise<void> {
		if (this.#left) return;
		if (frame.t === "welcome") {
			if (frame.proto !== COLLAB_PROTO) throw new Error("collaboration protocol mismatch");
			this.#readOnly = frame.readOnly === true;
			this.#events.authority(this.authority);
			this.#pending = { welcome: frame, entries: [] };
			if (frame.entryCount === 0) await this.#finishSnapshot();
			return;
		}
		if (frame.t === "snapshot-chunk") {
			if (!this.#pending) return;
			this.#pending.entries.push(...frame.entries);
			if (frame.final || this.#pending.entries.length >= this.#pending.welcome.entryCount)
				await this.#finishSnapshot();
			return;
		}
		if (frame.t === "error" && !this.#joined) {
			throw new Error(frame.message);
		}
		if (!this.#joined) return;
		if (frame.t === "bye") {
			this.#events.status("failed", "room_closed");
			this.#socket.close();
			return;
		}
		if (frame.t === "authority") {
			this.#readOnly = frame.readOnly;
			this.#events.authority(this.authority);
		}
		if (frame.t === "state") this.#events.participants(projectGuestParticipants(frame));
		if (!this.#active) {
			this.#deferredFrames.push(frame);
			return;
		}
		await this.#emitLiveFrame(frame);
	}

	async #finishSnapshot(): Promise<void> {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = null;
		const initial = { welcome: pending.welcome, entries: pending.entries };
		const wasJoined = this.#joined;
		this.#joined = true;
		this.#events.participants(projectGuestParticipants(pending.welcome));
		if (!wasJoined) {
			this.#initial.resolve(initial);
			return;
		}
		this.#events.status("connected");
		await this.#emitSnapshot(initial);
	}

	async #emitSnapshot(initial: InitialReplica): Promise<void> {
		const payload = await projectUnknown(
			{
				header: initial.welcome.header,
				state: initial.welcome.state,
				agents: initial.welcome.agents,
				entries: initial.entries,
			},
			this.#events,
		);
		this.#events.replicated({ kind: "snapshot", payload });
	}

	async #emitLiveFrame(frame: CollabFrame): Promise<void> {
		const payload = await projectUnknown(frame, this.#events);
		this.#events.replicated({ kind: frame.t, payload });
	}

	#clearJoinTimer(): void {
		if (this.#joinTimer === null) return;
		clearTimeout(this.#joinTimer);
		this.#joinTimer = null;
	}
}

export class RpcCollaborationSessionMediaStore implements RpcCollaborationMediaStore {
	readonly #getManager: () => ArtifactManager | undefined;
	readonly #getSessionId: () => string;

	constructor(getManager: () => ArtifactManager | undefined, getSessionId: () => string) {
		this.#getManager = getManager;
		this.#getSessionId = getSessionId;
	}

	async save(mediaType: string, data: Uint8Array): Promise<RpcCollaborationMediaDescriptor> {
		const manager = this.#requireManager();
		const safeMediaType = sanitizeRpcText(mediaType, MAX_MEDIA_TYPE_BYTES) || "application/octet-stream";
		const allocation = await manager.allocatePath(
			"collaboration_media",
			{ sessionId: this.#getSessionId() },
			{ mediaType: safeMediaType, source: "collaboration_media" },
		);
		await Bun.write(allocation.path, data);
		const descriptor = await manager.describe(allocation.id);
		if (descriptor.byteLength === null || descriptor.sha256 === null)
			throw new Error("Collaboration media was not persisted");
		return {
			mediaId: descriptor.id,
			mediaType: descriptor.mediaType,
			byteLength: descriptor.byteLength,
			sha256: descriptor.sha256,
		};
	}

	async read(mediaId: string, offset = 0, length = MAX_ARTIFACT_RANGE_BYTES): Promise<RpcCollaborationMediaRange> {
		const range = await this.#requireManager().readRange(mediaId, { offset, length });
		if (range.descriptor.provenance.source !== "collaboration_media") {
			throw new Error(`Artifact is not collaboration media: ${mediaId}`);
		}
		return {
			mediaId,
			mediaType: range.descriptor.mediaType,
			offset: range.offset,
			byteLength: range.byteLength,
			eof: range.eof,
			encoding: range.encoding,
			data: range.data,
		};
	}

	#requireManager(): ArtifactManager {
		const manager = this.#getManager();
		if (!manager) throw new Error("Collaboration media storage is unavailable for this session");
		return manager;
	}
}

export class RpcCollaborationTransportFactoryImpl implements RpcCollaborationTransportFactory {
	readonly #session: AgentSession;
	readonly #eventBus: EventBus | undefined;

	constructor(session: AgentSession, eventBus?: EventBus) {
		this.#session = session;
		this.#eventBus = eventBus;
	}

	async host(
		options: { relayUrl?: string; webUrl?: string },
		events: RpcCollaborationOpenEvents,
	): Promise<RpcCollaborationHostResult> {
		const context = this.#hostContext();
		const displayName = collabDisplayName(context);
		const host = new CollabHost(context, {
			onStatus: (state, reason) => events.status(state, reason),
			onParticipants: peers => events.participants(projectHostParticipants(displayName, peers)),
		});
		context.collabHost = host;
		const relayUrl = options.relayUrl ?? this.#session.settings.get("collab.relayUrl") ?? DEFAULT_RELAY_URL;
		const webUrl = options.webUrl ?? this.#session.settings.get("collab.webUrl") ?? "";
		await host.start(relayUrl, webUrl);
		return {
			connection: new RpcCollaborationHostConnection(host),
			links: {
				link: host.link,
				viewLink: host.viewLink,
				...(host.webLink ? { webLink: host.webLink } : {}),
				...(host.webViewLink ? { webViewLink: host.webViewLink } : {}),
			},
			participants: projectHostParticipants(displayName, host.peers),
		};
	}

	async join(
		options: { link: string; displayName?: string },
		events: RpcCollaborationOpenEvents,
	): Promise<RpcCollaborationJoinResult> {
		const parsed = parseCollabLink(options.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		const displayName = options.displayName?.trim() || collabDisplayName({ settings: this.#session.settings });
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const connection = new RpcCollaborationGuestConnection(socket, events, displayName, writeToken);
		const initial = await connection.open();
		return {
			connection,
			participants: projectGuestParticipants(initial.welcome),
			activate: () => connection.activate(initial),
		};
	}

	#hostContext(): CollabHostContext {
		const session = this.#session;
		return {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			eventBus: this.#eventBus,
			statusLine: {
				getCachedContextBreakdown: () =>
					session.getContextBreakdown() ?? {
						contextWindow: session.model?.contextWindow ?? 0,
						anchored: false,
						usedTokens: 0,
						systemPromptTokens: 0,
						systemToolsTokens: 0,
						systemContextTokens: 0,
						skillsTokens: 0,
						messagesTokens: 0,
					},
				setCollabStatus: () => {},
				invalidate: () => {},
			},
			ui: { requestRender: () => {} },
			updatePendingMessagesDisplay: () => {},
			showStatus: message => logger.debug("rpc collaboration status", { message }),
		};
	}
}
