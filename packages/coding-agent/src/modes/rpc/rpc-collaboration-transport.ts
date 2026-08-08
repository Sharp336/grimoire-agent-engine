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
	RpcCollaborationLifecycleToken,
	RpcCollaborationMediaDescriptor,
	RpcCollaborationMediaRange,
	RpcCollaborationMediaStore,
	RpcCollaborationOpenEvents,
	RpcCollaborationParticipant,
	RpcCollaborationProjection,
	RpcCollaborationProjectionLoss,
	RpcCollaborationSessionAuthority,
	RpcCollaborationTransportFactory,
} from "./rpc-collaboration";
import { sanitizeRpcText } from "./rpc-safe-text";

const JOIN_TIMEOUT_MS = 30_000;
const MAX_PENDING_GUEST_FRAMES = 256;
const MAX_PENDING_GUEST_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTED_DEPTH = 32;
const MAX_PROJECTED_ARRAY_ITEMS = 4096;
const MAX_PROJECTED_OBJECT_KEYS = 256;
const MAX_MEDIA_TYPE_BYTES = 256;
const MAX_RECORDED_PROJECTION_LOSSES = 128;
const COLLAB_SOURCE_ELISION = /…\[(\d+) (?:chars|items) elided for collab session\]$/;

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

interface RecordedProjectionLoss extends RpcCollaborationProjectionLoss {
	local: boolean;
}

interface ProjectionContext {
	events: RpcCollaborationOpenEvents;
	losses: RecordedProjectionLoss[];
	droppedLosses: number;
	droppedUnrecoverableLoss: boolean;
}

function appendPointer(path: string, component: string | number): string {
	return `${path}/${String(component).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function recordProjectionLoss(context: ProjectionContext, loss: RecordedProjectionLoss): void {
	if (context.losses.length < MAX_RECORDED_PROJECTION_LOSSES - 1) {
		context.losses.push(loss);
		return;
	}
	context.droppedLosses += 1;
	if (!loss.local) context.droppedUnrecoverableLoss = true;
}

async function projectUnknown(
	value: unknown,
	context: ProjectionContext,
	path: string,
	depth = 0,
): Promise<RpcCollaborationJsonValue> {
	if (depth >= MAX_PROJECTED_DEPTH) {
		recordProjectionLoss(context, { path, reason: "depth_limit", recoverable: false, local: true });
		return null;
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		const sourceElision = COLLAB_SOURCE_ELISION.exec(value);
		if (sourceElision) {
			recordProjectionLoss(context, {
				path,
				reason: "source_transport_elision",
				omittedCount: Number(sourceElision[1]),
				recoverable: false,
				local: false,
			});
		}
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		recordProjectionLoss(context, { path, reason: "unsupported_value", recoverable: false, local: true });
		return null;
	}
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, MAX_PROJECTED_ARRAY_ITEMS);
		if (keep < value.length) {
			recordProjectionLoss(context, {
				path,
				reason: "array_item_limit",
				omittedCount: value.length - keep,
				recoverable: false,
				local: true,
			});
		}
		const projected: RpcCollaborationJsonValue[] = [];
		for (let index = 0; index < keep; index++) {
			projected.push(await projectUnknown(value[index], context, appendPointer(path, index), depth + 1));
		}
		return projected;
	}
	if (!isRecord(value)) {
		recordProjectionLoss(context, { path, reason: "unsupported_value", recoverable: false, local: true });
		return null;
	}
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
		let bytes: Uint8Array;
		try {
			bytes = Buffer.from(value.data, "base64");
		} catch {
			recordProjectionLoss(context, { path, reason: "invalid_media", recoverable: false, local: true });
			return { type: "image", unavailable: true };
		}
		const media = await context.events.media({ mediaType: value.mimeType, data: bytes });
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
	const entries = Object.entries(value).filter(([, child]) => child !== undefined);
	const keep = Math.min(entries.length, MAX_PROJECTED_OBJECT_KEYS);
	if (keep < entries.length) {
		recordProjectionLoss(context, {
			path,
			reason: "object_key_limit",
			omittedCount: entries.length - keep,
			recoverable: false,
			local: true,
		});
	}
	const projected: Record<string, RpcCollaborationJsonValue> = {};
	for (let index = 0; index < keep; index++) {
		const [key, child] = entries[index];
		projected[key] = await projectUnknown(child, context, appendPointer(path, key), depth + 1);
	}
	return projected;
}

export async function projectCollaborationPayload(
	value: unknown,
	events: RpcCollaborationOpenEvents,
): Promise<{ payload: RpcCollaborationJsonValue; projection?: RpcCollaborationProjection }> {
	const context: ProjectionContext = {
		events,
		losses: [],
		droppedLosses: 0,
		droppedUnrecoverableLoss: false,
	};
	const payload = await projectUnknown(value, context, "");
	if (context.losses.length === 0 && context.droppedLosses === 0) return { payload };

	let fullPayload: RpcCollaborationMediaDescriptor | undefined;
	if (context.losses.some(loss => loss.local) || context.droppedLosses > 0) {
		try {
			const json = JSON.stringify(value);
			if (json !== undefined) {
				fullPayload = await events.media({
					mediaType: "application/json",
					data: Buffer.from(json, "utf8"),
					announce: false,
				});
			}
		} catch (cause) {
			logger.warn("rpc collaboration full projection payload could not be persisted", { error: String(cause) });
		}
	}

	const losses: RpcCollaborationProjectionLoss[] = context.losses.map(({ local, ...loss }) => ({
		...loss,
		recoverable: local && fullPayload !== undefined,
	}));
	if (context.droppedLosses > 0) {
		losses.push({
			path: "",
			reason: "loss_record_limit",
			omittedCount: context.droppedLosses,
			recoverable: fullPayload !== undefined && !context.droppedUnrecoverableLoss,
		});
	}
	return {
		payload,
		projection: {
			fidelity: "lossy",
			losses,
			...(fullPayload === undefined ? {} : { fullPayload }),
		},
	};
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
	#queuedFrames: Array<{ frame: CollabFrame; bytes: number }> = [];
	#deferredFrames: Array<{ frame: CollabFrame; bytes: number }> = [];
	#pendingFrameCount = 0;
	#pendingFrameBytes = 0;
	#processing = false;
	#activating = false;
	#active = false;
	#joined = false;
	#left = false;
	#ingressStale = false;
	#gapSignalled = false;
	#readOnly: boolean;
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
		this.#socket.onDrop = () => this.#signalIngressGap(new Error("collaboration socket send buffer overflow"));
		this.#socket.onOpen = () => {
			this.#pending = null;
			this.#socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: this.#displayName,
				writeToken: this.#writeToken,
			});
		};
		this.#socket.onFrame = frame => this.#enqueueFrame(frame);
		this.#socket.onClose = (reason, willReconnect) => {
			if (this.#left) return;
			if (!this.#joined) this.#initial.reject(new Error(reason));
			this.#events.status(willReconnect ? "reconnecting" : "failed", willReconnect ? "network_lost" : "room_closed");
		};
		this.#joinTimer = setTimeout(
			() => this.#initial.reject(new Error("timed out waiting for collaboration snapshot")),
			JOIN_TIMEOUT_MS,
		);
		this.#socket.connect();
		try {
			return await this.#initial.promise;
		} finally {
			this.#clearJoinTimer();
		}
	}

	async activate(initial: InitialReplica): Promise<void> {
		this.#activating = true;
		try {
			await this.#emitSnapshot(initial);
			while (!this.#left && this.#deferredFrames.length > 0) {
				const item = this.#deferredFrames.shift();
				if (!item) break;
				this.#pendingFrameCount -= 1;
				this.#pendingFrameBytes -= item.bytes;
				await this.#emitLiveFrame(item.frame);
			}
			if (!this.#left) this.#active = true;
		} finally {
			this.#activating = false;
		}
	}

	async leave(_reason: string): Promise<void> {
		this.#left = true;
		this.#clearJoinTimer();
		this.#clearPendingFrames();
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
		if (this.#left) return;
		this.#pending = null;
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#displayName,
			writeToken: this.#writeToken,
		});
	}

	#enqueueFrame(frame: CollabFrame): void {
		if (this.#left || (this.#ingressStale && frame.t !== "welcome")) return;
		const serialized = JSON.stringify(frame);
		const bytes = Math.max(1, Buffer.byteLength(serialized ?? "", "utf8"));
		if (
			this.#pendingFrameCount >= MAX_PENDING_GUEST_FRAMES ||
			this.#pendingFrameBytes + bytes > MAX_PENDING_GUEST_BYTES
		) {
			this.#signalIngressGap(new Error("collaboration guest ingress overflow"));
			return;
		}
		this.#queuedFrames.push({ frame, bytes });
		this.#pendingFrameCount += 1;
		this.#pendingFrameBytes += bytes;
		if (!this.#processing) void this.#drainFrames();
	}

	async #drainFrames(): Promise<void> {
		if (this.#processing) return;
		this.#processing = true;
		try {
			while (!this.#left && this.#queuedFrames.length > 0) {
				const item = this.#queuedFrames.shift();
				if (!item) break;
				this.#pendingFrameCount -= 1;
				this.#pendingFrameBytes -= item.bytes;
				try {
					await this.#handleFrame(item.frame, item.bytes);
				} catch (cause) {
					logger.warn("rpc collaboration guest frame failed", { error: String(cause) });
					this.#signalIngressGap(cause);
				}
			}
		} finally {
			this.#processing = false;
			if (!this.#left && this.#queuedFrames.length > 0) void this.#drainFrames();
		}
	}

	async #handleFrame(frame: CollabFrame, bytes: number): Promise<void> {
		if (this.#left || (this.#ingressStale && frame.t !== "welcome")) return;
		if (frame.t === "welcome") {
			if (frame.proto !== COLLAB_PROTO) throw new Error("collaboration protocol mismatch");
			this.#ingressStale = false;
			this.#gapSignalled = false;
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
		if (!this.#active || this.#activating) {
			this.#deferredFrames.push({ frame, bytes });
			this.#pendingFrameCount += 1;
			this.#pendingFrameBytes += bytes;
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
		const projected = await projectCollaborationPayload(
			{
				header: initial.welcome.header,
				state: initial.welcome.state,
				agents: initial.welcome.agents,
				entries: initial.entries,
			},
			this.#events,
		);
		this.#events.replicated({ kind: "snapshot", ...projected });
	}

	async #emitLiveFrame(frame: CollabFrame): Promise<void> {
		const projected = await projectCollaborationPayload(frame, this.#events);
		this.#events.replicated({ kind: frame.t, ...projected });
	}

	#signalIngressGap(cause: unknown): void {
		if (this.#left || this.#gapSignalled) return;
		this.#gapSignalled = true;
		this.#ingressStale = true;
		this.#clearPendingFrames();
		if (!this.#joined) {
			this.#left = true;
			this.#initial.reject(cause);
			return;
		}
		this.#events.gap();
	}

	#clearPendingFrames(): void {
		this.#queuedFrames = [];
		this.#deferredFrames = [];
		this.#pendingFrameCount = 0;
		this.#pendingFrameBytes = 0;
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
	readonly #getSessionAuthority: (() => RpcCollaborationSessionAuthority) | undefined;

	constructor(
		getManager: () => ArtifactManager | undefined,
		getSessionId: () => string,
		getSessionAuthority?: () => RpcCollaborationSessionAuthority,
	) {
		this.#getManager = getManager;
		this.#getSessionId = getSessionId;
		this.#getSessionAuthority = getSessionAuthority;
	}

	async save(
		mediaType: string,
		data: Uint8Array,
		lifecycleToken?: RpcCollaborationLifecycleToken,
	): Promise<RpcCollaborationMediaDescriptor> {
		const manager = this.#requireManager();
		const sessionId = lifecycleToken?.sessionAuthority.sessionId ?? this.#getSessionId();
		this.#assertTokenCurrent(lifecycleToken);
		const safeMediaType = sanitizeRpcText(mediaType, MAX_MEDIA_TYPE_BYTES) || "application/octet-stream";
		let allocation: { id: string; path: string } | undefined;
		try {
			allocation = await manager.allocatePath(
				"collaboration_media",
				{ sessionId },
				{ mediaType: safeMediaType, source: "collaboration_media" },
			);
			this.#assertTokenCurrent(lifecycleToken);
			await Bun.write(allocation.path, data);
			this.#assertTokenCurrent(lifecycleToken);
			const descriptor = await manager.describe(allocation.id);
			this.#assertTokenCurrent(lifecycleToken);
			if (descriptor.byteLength === null || descriptor.sha256 === null)
				throw new Error("Collaboration media was not persisted");
			return {
				mediaId: descriptor.id,
				mediaType: descriptor.mediaType,
				byteLength: descriptor.byteLength,
				sha256: descriptor.sha256,
			};
		} catch (cause) {
			if (allocation && lifecycleToken && !this.#isTokenCurrent(lifecycleToken)) {
				try {
					await manager.cancel(allocation.id, "collaboration authority changed");
				} catch {
					// The captured artifact authority may already be tearing down.
				}
			}
			throw cause;
		}
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

	#assertTokenCurrent(token: RpcCollaborationLifecycleToken | undefined): void {
		if (token && !this.#isTokenCurrent(token)) throw new Error("Collaboration media authority is stale");
	}

	#isTokenCurrent(token: RpcCollaborationLifecycleToken): boolean {
		try {
			const current = this.#getSessionAuthority?.();
			if (current) {
				return (
					current.sessionId === token.sessionAuthority.sessionId &&
					current.sessionGeneration === token.sessionAuthority.sessionGeneration &&
					current.authorityGeneration === token.sessionAuthority.authorityGeneration
				);
			}
			return this.#getSessionId() === token.sessionAuthority.sessionId;
		} catch {
			return false;
		}
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
		try {
			await host.start(relayUrl, webUrl);
		} catch (cause) {
			try {
				await host.stop("host_failed");
			} catch {
				// Preserve the startup failure; the host has no reachable manager yet.
			}
			throw cause;
		}
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
		try {
			const initial = await connection.open();
			return {
				connection,
				participants: projectGuestParticipants(initial.welcome),
				activate: () => connection.activate(initial),
			};
		} catch (cause) {
			try {
				await connection.leave("join_failed");
			} catch {
				// Preserve the initial replica failure.
			}
			throw cause;
		}
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
