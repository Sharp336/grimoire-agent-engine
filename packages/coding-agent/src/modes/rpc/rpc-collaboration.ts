import type { ImageContent } from "@oh-my-pi/pi-ai";

const DEFAULT_MAX_RETAINED_FRAMES = 256;
const DEFAULT_STALE_AFTER_MS = 15_000;
const MAX_RETAINED_FRAMES_LIMIT = 4096;

export type RpcCollaborationRole = "none" | "host" | "guest";
export type RpcCollaborationAuthority = "none" | "full" | "view";
export type RpcCollaborationState =
	| "off"
	| "hosting"
	| "joining"
	| "connected"
	| "reconnecting"
	| "stale"
	| "leaving"
	| "failed";

export type RpcCollaborationJsonValue =
	| string
	| number
	| boolean
	| null
	| RpcCollaborationJsonValue[]
	| { [key: string]: RpcCollaborationJsonValue };

export interface RpcCollaborationCursor {
	generation: number;
	sequence: number;
}

export interface RpcCollaborationParticipant {
	participantId: string;
	displayName: string;
	role: "host" | "guest";
	authority: "full" | "view";
}

export interface RpcCollaborationLinks {
	link: string;
	viewLink: string;
	webLink?: string;
	webViewLink?: string;
}

export interface RpcCollaborationReplicationSnapshot {
	generation: number;
	latestSequence: number;
	acknowledgedSequence: number;
	retainedFrames: number;
	stale: boolean;
}

export interface RpcCollaborationSnapshot {
	revision: number;
	state: RpcCollaborationState;
	role: RpcCollaborationRole;
	authority: RpcCollaborationAuthority;
	/** The host owns authoritative session state. Guest replication never does. */
	authoritative: boolean;
	sessionId?: string;
	links?: RpcCollaborationLinks;
	participants: RpcCollaborationParticipant[];
	replication: RpcCollaborationReplicationSnapshot;
	failure?: { code: string; retryable: boolean };
}

export interface RpcCollaborationMediaDescriptor {
	mediaId: string;
	mediaType: string;
	byteLength: number;
	sha256: string;
}

export type RpcCollaborationProjectionLossReason =
	| "depth_limit"
	| "array_item_limit"
	| "object_key_limit"
	| "unsupported_value"
	| "invalid_media"
	| "source_transport_elision"
	| "loss_record_limit";

export interface RpcCollaborationProjectionLoss {
	/** JSON Pointer into the source collaboration payload; the empty string identifies the root. */
	path: string;
	reason: RpcCollaborationProjectionLossReason;
	omittedCount?: number;
	/** True when fullPayload can recover the source value. */
	recoverable: boolean;
}

export interface RpcCollaborationProjection {
	fidelity: "lossy";
	losses: RpcCollaborationProjectionLoss[];
	/** Complete source JSON, persisted through collaboration_read_media when locally available. */
	fullPayload?: RpcCollaborationMediaDescriptor;
}

export interface RpcCollaborationMediaRange {
	mediaId: string;
	mediaType: string;
	offset: number;
	byteLength: number;
	eof: boolean;
	encoding: "base64";
	data: string;
}

export type RpcCollaborationFrame =
	| { type: "collaboration_state"; snapshot: RpcCollaborationSnapshot }
	| {
			type: "collaboration_replicated";
			authoritative: false;
			cursor: RpcCollaborationCursor;
			kind: string;
			payload?: RpcCollaborationJsonValue;
			media?: RpcCollaborationMediaDescriptor;
			projection?: RpcCollaborationProjection;
	  }
	| {
			type: "collaboration_gap";
			authoritative: false;
			generation: number;
			fromSequence: number;
			toSequence: number;
			reason: "backpressure_overflow" | "transport_gap";
	  }
	| {
			type: "collaboration_stale";
			authoritative: false;
			generation: number;
			reason: "backpressure_overflow" | "reconnect_timeout" | "transport_gap";
	  };

export type RpcCollaborationStatusReason = "network_lost" | "room_closed" | "transport_failed" | "resync_required";

export interface RpcCollaborationReplicatedInput {
	kind: string;
	payload?: RpcCollaborationJsonValue;
	projection?: RpcCollaborationProjection;
}

export interface RpcCollaborationMediaInput {
	mediaType: string;
	data: Uint8Array;
	/** False persists a referenced payload without emitting a standalone media frame. */
	announce?: boolean;
}

export interface RpcCollaborationOpenEvents {
	status(state: "connected" | "reconnecting" | "failed", reason?: RpcCollaborationStatusReason): void;
	participants(participants: RpcCollaborationParticipant[]): void;
	authority(authority: "full" | "view"): void;
	replicated(frame: RpcCollaborationReplicatedInput): void;
	media(media: RpcCollaborationMediaInput): Promise<RpcCollaborationMediaDescriptor>;
	gap(): void;
}

export interface RpcCollaborationConnection {
	readonly role: "host" | "guest";
	readonly authority: "full" | "view";
	leave(reason: string): Promise<void>;
	revoke(participantId: string): Promise<void>;
	rotate(): Promise<{ link: string; viewLink: string; webLink?: string; webViewLink?: string }>;
	sendPrompt(message: string, images?: ImageContent[]): void;
	sendAbort(): void;
	requestResync(): void;
}

export interface RpcCollaborationHostResult {
	connection: RpcCollaborationConnection;
	links: RpcCollaborationLinks;
	participants: RpcCollaborationParticipant[];
}

export interface RpcCollaborationJoinResult {
	connection: RpcCollaborationConnection;
	participants?: RpcCollaborationParticipant[];
	/** Releases the initial replica only after the manager establishes generation 1. */
	activate?(): Promise<void>;
}

export interface RpcCollaborationTransportFactory {
	host(
		options: { relayUrl?: string; webUrl?: string },
		events: RpcCollaborationOpenEvents,
	): Promise<RpcCollaborationHostResult>;
	join(
		options: { link: string; displayName?: string },
		events: RpcCollaborationOpenEvents,
	): Promise<RpcCollaborationJoinResult>;
}

export interface RpcCollaborationMediaStore {
	save(mediaType: string, data: Uint8Array): Promise<RpcCollaborationMediaDescriptor>;
	read(mediaId: string, offset?: number, length?: number): Promise<RpcCollaborationMediaRange>;
}

export interface RpcCollaborationManagerOptions {
	factory: RpcCollaborationTransportFactory;
	media: RpcCollaborationMediaStore;
	getSessionId(): string;
	output(frame: RpcCollaborationFrame): void;
	maxRetainedFrames?: number;
	staleAfterMs?: number;
}

interface RetainedReplication {
	cursor: RpcCollaborationCursor;
	frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }>;
}

export class RpcCollaborationAuthorityError extends Error {
	readonly code = "collaboration_authority_denied";

	constructor(message: string) {
		super(message);
		this.name = "RpcCollaborationAuthorityError";
	}
}

export class RpcCollaborationStateError extends Error {
	readonly code = "collaboration_invalid_state";

	constructor(message: string) {
		super(message);
		this.name = "RpcCollaborationStateError";
	}
}

/**
 * Host-neutral collaboration authority. Transports carry encrypted frames;
 * this manager owns RPC-visible role, authority, replication cursors,
 * acknowledgement windows, stale detection, and local-session isolation.
 */
export class RpcCollaborationManager {
	readonly #factory: RpcCollaborationTransportFactory;
	readonly #media: RpcCollaborationMediaStore;
	readonly #getSessionId: () => string;
	readonly #output: (frame: RpcCollaborationFrame) => void;
	readonly #maxRetainedFrames: number;
	readonly #staleAfterMs: number;
	#connection: RpcCollaborationConnection | null = null;
	#revision = 0;
	#state: RpcCollaborationState = "off";
	#role: RpcCollaborationRole = "none";
	#authority: RpcCollaborationAuthority = "none";
	#sessionId: string | undefined;
	#links: RpcCollaborationLinks | undefined;
	#participants: RpcCollaborationParticipant[] = [];
	#generation = 0;
	#latestSequence = 0;
	#acknowledgedSequence = 0;
	#retained: RetainedReplication[] = [];
	#stale = false;
	#failure: { code: string; retryable: boolean } | undefined;
	#reconnecting = false;
	#staleTimer: Timer | null = null;

	constructor(options: RpcCollaborationManagerOptions) {
		this.#factory = options.factory;
		this.#media = options.media;
		this.#getSessionId = options.getSessionId;
		this.#output = options.output;
		this.#maxRetainedFrames = Math.min(
			MAX_RETAINED_FRAMES_LIMIT,
			Math.max(1, options.maxRetainedFrames ?? DEFAULT_MAX_RETAINED_FRAMES),
		);
		this.#staleAfterMs = Math.max(1, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
	}

	snapshot(): RpcCollaborationSnapshot {
		return {
			revision: this.#revision,
			state: this.#state,
			role: this.#role,
			authority: this.#authority,
			authoritative: this.#role === "host",
			...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
			...(this.#links === undefined ? {} : { links: { ...this.#links } }),
			participants: this.#participants.map(participant => ({ ...participant })),
			replication: {
				generation: this.#generation,
				latestSequence: this.#latestSequence,
				acknowledgedSequence: this.#acknowledgedSequence,
				retainedFrames: this.#retained.length,
				stale: this.#stale,
			},
			...(this.#failure === undefined ? {} : { failure: { ...this.#failure } }),
		};
	}

	async host(options: { relayUrl?: string; webUrl?: string }): Promise<RpcCollaborationSnapshot> {
		this.#assertOff();
		this.#bind("hosting", "host", "full");
		try {
			const opened = await this.#factory.host(options, this.#events());
			this.#connection = opened.connection;
			this.#links = { ...opened.links };
			this.#participants = opened.participants.map(participant => ({ ...participant }));
			this.#state = "connected";
			this.#revision += 1;
			this.#emitState();
			return this.snapshot();
		} catch (cause) {
			this.#failOpen(cause);
			throw cause;
		}
	}

	async join(options: { link: string; displayName?: string }): Promise<RpcCollaborationSnapshot> {
		this.#assertOff();
		this.#bind("joining", "guest", "none");
		try {
			const opened = await this.#factory.join(options, this.#events());
			this.#connection = opened.connection;
			this.#role = opened.connection.role;
			this.#authority = opened.connection.authority;
			this.#participants = (opened.participants ?? []).map(participant => ({ ...participant }));
			this.#beginGeneration();
			this.#state = "connected";
			this.#revision += 1;
			await opened.activate?.();
			this.#emitState();
			return this.snapshot();
		} catch (cause) {
			this.#failOpen(cause);
			throw cause;
		}
	}

	async leave(reason = "client_requested"): Promise<RpcCollaborationSnapshot> {
		if (this.#state === "off") return this.snapshot();
		this.#state = "leaving";
		this.#revision += 1;
		this.#emitState();
		const connection = this.#connection;
		this.#connection = null;
		this.#clearStaleTimer();
		try {
			await connection?.leave(reason);
		} finally {
			this.#reset();
		}
		return this.snapshot();
	}

	async revoke(participantId: string): Promise<RpcCollaborationSnapshot> {
		const connection = this.#requireHost();
		if (
			!this.#participants.some(
				participant => participant.participantId === participantId && participant.role === "guest",
			)
		) {
			throw new RpcCollaborationStateError(`Collaboration participant does not exist: ${participantId}`);
		}
		await connection.revoke(participantId);
		this.#participants = this.#participants.map(participant =>
			participant.participantId === participantId ? { ...participant, authority: "view" } : participant,
		);
		this.#revision += 1;
		this.#emitState();
		return this.snapshot();
	}

	async rotate(): Promise<RpcCollaborationSnapshot> {
		const connection = this.#requireHost();
		const links = await connection.rotate();
		this.#links = { ...links };
		this.#participants = this.#participants.map(participant =>
			participant.role === "guest" ? { ...participant, authority: "view" } : participant,
		);
		this.#revision += 1;
		this.#emitState();
		return this.snapshot();
	}

	sendPrompt(message: string, images?: ImageContent[]): void {
		const connection = this.#requireWritableGuest();
		connection.sendPrompt(message, images);
	}

	sendAbort(): void {
		const connection = this.#requireWritableGuest();
		connection.sendAbort();
	}

	acknowledge(cursor: RpcCollaborationCursor): { acknowledged: number; retained: number } {
		if (this.#role !== "guest")
			throw new RpcCollaborationAuthorityError("Only a collaboration guest acknowledges replication");
		if (cursor.generation !== this.#generation) {
			throw new RpcCollaborationStateError(
				`Replication generation mismatch: expected ${this.#generation}, received ${cursor.generation}`,
			);
		}
		if (cursor.sequence < this.#acknowledgedSequence || cursor.sequence > this.#latestSequence) {
			throw new RpcCollaborationStateError(
				`Replication acknowledgement must be between ${this.#acknowledgedSequence} and ${this.#latestSequence}`,
			);
		}
		this.#acknowledgedSequence = cursor.sequence;
		this.#retained = this.#retained.filter(item => item.cursor.sequence > cursor.sequence);
		this.#revision += 1;
		return { acknowledged: this.#acknowledgedSequence, retained: this.#retained.length };
	}

	readMedia(mediaId: string, offset?: number, length?: number): Promise<RpcCollaborationMediaRange> {
		return this.#media.read(mediaId, offset, length);
	}

	async assertSessionIsolation(): Promise<void> {
		if (this.#sessionId === undefined || this.#getSessionId() === this.#sessionId) return;
		await this.leave("session_changed");
	}

	async dispose(): Promise<void> {
		await this.leave("rpc_disconnected");
	}

	#events(): RpcCollaborationOpenEvents {
		return {
			status: (state, reason) => this.#onStatus(state, reason),
			participants: participants => this.#onParticipants(participants),
			authority: authority => this.#onAuthority(authority),
			replicated: frame => this.#onReplicated(frame),
			media: media => this.#onMedia(media),
			gap: () => this.#markGap("transport_gap"),
		};
	}

	#bind(state: "hosting" | "joining", role: "host" | "guest", authority: RpcCollaborationAuthority): void {
		this.#sessionId = this.#getSessionId();
		this.#state = state;
		this.#role = role;
		this.#authority = authority;
		this.#failure = undefined;
		this.#revision += 1;
		this.#emitState();
	}

	#failOpen(_cause: unknown): void {
		this.#connection = null;
		this.#state = "failed";
		this.#failure = { code: "collaboration_open_failed", retryable: true };
		this.#revision += 1;
		this.#emitState();
	}

	#onStatus(state: "connected" | "reconnecting" | "failed", reason?: RpcCollaborationStatusReason): void {
		if (!this.#connection && this.#state !== "hosting" && this.#state !== "joining") return;
		this.#clearStaleTimer();
		if (state === "reconnecting") {
			this.#reconnecting = true;
			this.#state = "reconnecting";
			this.#failure = undefined;
			this.#staleTimer = setTimeout(() => this.#markStale("reconnect_timeout"), this.#staleAfterMs);
		} else if (state === "connected") {
			if (this.#role === "guest" && this.#reconnecting) this.#beginGeneration();
			this.#reconnecting = false;
			this.#state = "connected";
			this.#stale = false;
			this.#failure = undefined;
		} else {
			this.#state = "failed";
			this.#failure = { code: reason ?? "transport_failed", retryable: reason !== "room_closed" };
		}
		this.#revision += 1;
		this.#emitState();
	}

	#onParticipants(participants: RpcCollaborationParticipant[]): void {
		this.#participants = participants.map(participant => ({ ...participant }));
		this.#revision += 1;
		this.#emitState();
	}

	#onAuthority(authority: "full" | "view"): void {
		if (this.#role !== "guest") return;
		this.#authority = authority;
		this.#revision += 1;
		this.#emitState();
	}
	#onReplicated(input: RpcCollaborationReplicatedInput): void {
		if (this.#role !== "guest" || this.#state === "off" || this.#state === "leaving" || this.#stale) return;
		this.#latestSequence += 1;
		const cursor = { generation: this.#generation, sequence: this.#latestSequence };
		const frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }> = {
			type: "collaboration_replicated",
			authoritative: false,
			cursor,
			kind: input.kind,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			...(input.projection === undefined ? {} : { projection: input.projection }),
		};
		this.#retainAndEmit(cursor, frame);
	}

	async #onMedia(input: RpcCollaborationMediaInput): Promise<RpcCollaborationMediaDescriptor> {
		if (this.#role !== "guest" || this.#state === "off" || this.#state === "leaving") {
			throw new RpcCollaborationStateError("Collaboration media arrived without an active guest replica");
		}
		const media = await this.#media.save(input.mediaType, input.data);
		if (input.announce === false) return media;
		this.#latestSequence += 1;
		const cursor = { generation: this.#generation, sequence: this.#latestSequence };
		const frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }> = {
			type: "collaboration_replicated",
			authoritative: false,
			cursor,
			kind: "media",
			media,
		};
		this.#retainAndEmit(cursor, frame);
		return media;
	}

	#retainAndEmit(
		cursor: RpcCollaborationCursor,
		frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }>,
	): void {
		if (this.#retained.length >= this.#maxRetainedFrames) {
			this.#markGap("backpressure_overflow");
			return;
		}
		this.#retained.push({ cursor, frame });
		this.#revision += 1;
		this.#output(frame);
	}

	#markGap(reason: "backpressure_overflow" | "transport_gap"): void {
		if (this.#role !== "guest") return;
		const fromSequence = this.#acknowledgedSequence + 1;
		const toSequence = this.#latestSequence;
		this.#retained = [];
		this.#output({
			type: "collaboration_gap",
			authoritative: false,
			generation: this.#generation,
			fromSequence,
			toSequence,
			reason,
		});
		this.#markStale(reason);
		this.#reconnecting = true;
		this.#connection?.requestResync();
	}

	#markStale(reason: "backpressure_overflow" | "reconnect_timeout" | "transport_gap"): void {
		if (this.#role !== "guest" || this.#stale) return;
		this.#clearStaleTimer();
		this.#stale = true;
		this.#state = "stale";
		this.#revision += 1;
		this.#output({
			type: "collaboration_stale",
			authoritative: false,
			generation: this.#generation,
			reason,
		});
		this.#emitState();
	}

	#beginGeneration(): void {
		this.#generation += 1;
		this.#latestSequence = 0;
		this.#acknowledgedSequence = 0;
		this.#retained = [];
		this.#stale = false;
	}

	#requireHost(): RpcCollaborationConnection {
		if (this.#role !== "host" || this.#authority !== "full" || !this.#connection) {
			throw new RpcCollaborationAuthorityError("Collaboration host authority is required");
		}
		return this.#connection;
	}

	#requireWritableGuest(): RpcCollaborationConnection {
		if (this.#role !== "guest" || this.#authority !== "full" || !this.#connection || this.#state !== "connected") {
			throw new RpcCollaborationAuthorityError("Writable collaboration guest authority is required");
		}
		return this.#connection;
	}

	#assertOff(): void {
		if (this.#state !== "off") throw new RpcCollaborationStateError("A collaboration session is already active");
	}

	#reset(): void {
		this.#clearStaleTimer();
		this.#state = "off";
		this.#role = "none";
		this.#authority = "none";
		this.#sessionId = undefined;
		this.#links = undefined;
		this.#participants = [];
		this.#generation = 0;
		this.#latestSequence = 0;
		this.#acknowledgedSequence = 0;
		this.#retained = [];
		this.#stale = false;
		this.#failure = undefined;
		this.#reconnecting = false;
		this.#revision += 1;
		this.#emitState();
	}

	#clearStaleTimer(): void {
		if (this.#staleTimer === null) return;
		clearTimeout(this.#staleTimer);
		this.#staleTimer = null;
	}

	#emitState(): void {
		this.#output({ type: "collaboration_state", snapshot: this.snapshot() });
	}
}
