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

export interface RpcCollaborationSessionAuthority {
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly authorityGeneration: number;
}

export interface RpcCollaborationLifecycleToken {
	readonly collaborationGeneration: number;
	readonly sessionAuthority: RpcCollaborationSessionAuthority;
}

export type RpcCollaborationAuthorityCommit = (
	expected: RpcCollaborationSessionAuthority,
) => RpcCollaborationSessionAuthority;

export type RpcCollaborationAuthorityTransition = (
	captureAuthority: () => RpcCollaborationSessionAuthority,
	applyAuthority: () => void,
	installAuthority: (next: RpcCollaborationSessionAuthority) => void,
) => Promise<void>;

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
	readonly lifecycleToken?: RpcCollaborationLifecycleToken;
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
	save(
		mediaType: string,
		data: Uint8Array,
		lifecycleToken?: RpcCollaborationLifecycleToken,
	): Promise<RpcCollaborationMediaDescriptor>;
	read(mediaId: string, offset?: number, length?: number): Promise<RpcCollaborationMediaRange>;
}

export interface RpcCollaborationManagerOptions {
	factory: RpcCollaborationTransportFactory;
	media: RpcCollaborationMediaStore;
	getSessionId(): string;
	getSessionAuthority?: () => RpcCollaborationSessionAuthority;
	transitionAuthority?: RpcCollaborationAuthorityTransition;
	output(frame: RpcCollaborationFrame): void;
	maxRetainedFrames?: number;
	staleAfterMs?: number;
}

interface RetainedReplication {
	cursor: RpcCollaborationCursor;
	frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }>;
}

interface RpcCollaborationEventBinding {
	readonly collaborationGeneration: number;
	token: RpcCollaborationLifecycleToken;
}

interface RpcCollaborationAuthorityChange {
	readonly binding: RpcCollaborationEventBinding;
	readonly authority: "full" | "view";
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
	readonly #getSessionAuthority: (() => RpcCollaborationSessionAuthority) | undefined;
	readonly #transitionAuthority: RpcCollaborationAuthorityTransition | undefined;
	readonly #output: (frame: RpcCollaborationFrame) => void;
	readonly #maxRetainedFrames: number;
	readonly #staleAfterMs: number;
	readonly #closedConnections = new WeakSet<RpcCollaborationConnection>();
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
	#lifecycleGeneration = 0;
	#activeToken: RpcCollaborationLifecycleToken | undefined;
	#activeBinding: RpcCollaborationEventBinding | undefined;
	readonly #pendingAuthorityChanges: RpcCollaborationAuthorityChange[] = [];
	#authorityChangeRunning = false;
	readonly #pendingTransportCallbacks: Array<() => void> = [];
	#transportCallbacksBlocked = false;
	#mediaAuthorityGeneration = 0;
	#authorizedMedia = new Set<string>();
	#gapSignalled = false;
	#leavePromise: Promise<RpcCollaborationSnapshot> | undefined;

	constructor(options: RpcCollaborationManagerOptions) {
		this.#factory = options.factory;
		this.#media = options.media;
		this.#getSessionId = options.getSessionId;
		this.#getSessionAuthority = options.getSessionAuthority;
		this.#transitionAuthority = options.transitionAuthority;
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

	getLifecycleToken(): RpcCollaborationLifecycleToken | undefined {
		return this.#activeToken;
	}

	isLifecycleTokenCurrent(token: RpcCollaborationLifecycleToken): boolean {
		return this.#isCurrentToken(token);
	}

	replaceAuthorityToken(
		expected: RpcCollaborationLifecycleToken,
		nextAuthority: RpcCollaborationSessionAuthority,
	): RpcCollaborationLifecycleToken {
		return this.#installAuthoritySuccessor(expected, nextAuthority);
	}

	async host(options: { relayUrl?: string; webUrl?: string }): Promise<RpcCollaborationSnapshot> {
		this.#assertOff();
		const { token, binding } = this.#bind("hosting", "host", "full");
		let opened: RpcCollaborationHostResult | undefined;
		let installed = false;
		try {
			opened = await this.#factory.host(options, this.#events(binding));
			if (!this.#isCurrentToken(token)) {
				await this.#closeConnection(opened.connection, "stale_open");
				throw this.#staleOpenError();
			}
			this.#connection = opened.connection;
			installed = true;
			this.#links = { ...opened.links };
			this.#participants = opened.participants.map(participant => ({ ...participant }));
			this.#state = "connected";
			this.#revision += 1;
			this.#emitState();
			return this.snapshot();
		} catch (cause) {
			if (opened && !this.#closedConnections.has(opened.connection) && (installed || !this.#isCurrentToken(token))) {
				await this.#closeConnection(opened.connection, "open_failed");
			}
			if (this.#isCurrentToken(token)) this.#failOpen(cause, token);
			throw cause;
		}
	}

	async join(options: { link: string; displayName?: string }): Promise<RpcCollaborationSnapshot> {
		this.#assertOff();
		const { token, binding } = this.#bind("joining", "guest", "none");
		let opened: RpcCollaborationJoinResult | undefined;
		let installed = false;
		try {
			opened = await this.#factory.join(options, this.#events(binding));
			if (!this.#isCurrentToken(token)) {
				await this.#closeConnection(opened.connection, "stale_open");
				throw this.#staleOpenError();
			}
			this.#connection = opened.connection;
			installed = true;
			this.#role = opened.connection.role;
			this.#authority = opened.connection.authority;
			this.#participants = (opened.participants ?? []).map(participant => ({ ...participant }));
			this.#beginGeneration();
			this.#state = "connected";
			this.#revision += 1;
			await opened.activate?.();
			if (!this.#isCurrentToken(token)) {
				this.#discardStaleOpen(token);
				await this.#closeConnection(opened.connection, "stale_open");
				throw this.#staleOpenError();
			}
			this.#emitState();
			return this.snapshot();
		} catch (cause) {
			if (opened && !this.#closedConnections.has(opened.connection) && (installed || !this.#isCurrentToken(token))) {
				await this.#closeConnection(opened.connection, "join_failed");
			}
			if (this.#isCurrentToken(token)) this.#failOpen(cause, token);
			throw cause;
		}
	}

	leave(reason = "client_requested"): Promise<RpcCollaborationSnapshot> {
		if (this.#leavePromise) return this.#leavePromise;
		if (this.#state === "off") return Promise.resolve(this.snapshot());

		const deferred = Promise.withResolvers<RpcCollaborationSnapshot>();
		this.#leavePromise = deferred.promise;
		const connection = this.#connection;
		const token = this.#activeToken;
		this.#invalidateToken(token);
		this.#connection = null;
		this.#clearStaleTimer();
		this.#state = "leaving";
		this.#revision += 1;
		this.#emitState();

		// Make the authority boundary observable immediately. The physical close
		// remains part of the shared settlement promise, so a new generation may
		// start without an old leave continuation being able to reset it.
		this.#reset();
		const settledSnapshot = this.snapshot();
		void this.#finishLeave(connection, reason, settledSnapshot, deferred);
		return deferred.promise;
	}

	async revoke(
		participantId: string,
		commitAuthority?: RpcCollaborationAuthorityCommit,
	): Promise<RpcCollaborationSnapshot> {
		const token = this.#requireCurrentToken();
		const connection = this.#requireHost();
		if (
			!this.#participants.some(
				participant => participant.participantId === participantId && participant.role === "guest",
			)
		) {
			throw new RpcCollaborationStateError(`Collaboration participant does not exist: ${participantId}`);
		}
		await connection.revoke(participantId);
		if (!this.#isCurrentToken(token)) throw this.#staleOpenError();
		this.#participants = this.#participants.map(participant =>
			participant.participantId === participantId ? { ...participant, authority: "view" } : participant,
		);
		this.#revision += 1;
		this.#installCommittedAuthority(token, commitAuthority);
		this.#emitState();
		return this.snapshot();
	}

	async rotate(commitAuthority?: RpcCollaborationAuthorityCommit): Promise<RpcCollaborationSnapshot> {
		const token = this.#requireCurrentToken();
		const connection = this.#requireHost();
		const links = await connection.rotate();
		if (!this.#isCurrentToken(token)) throw this.#staleOpenError();
		this.#links = { ...links };
		this.#participants = this.#participants.map(participant =>
			participant.role === "guest" ? { ...participant, authority: "view" } : participant,
		);
		this.#revision += 1;
		this.#installCommittedAuthority(token, commitAuthority);
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
		this.#requireCurrentToken();
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

	async readMedia(mediaId: string, offset?: number, length?: number): Promise<RpcCollaborationMediaRange> {
		const token = this.#requireReadableMedia(mediaId);
		const mediaAuthorityGeneration = this.#mediaAuthorityGeneration;
		const range = await this.#media.read(mediaId, offset, length);
		if (
			!this.#isCurrentToken(token) ||
			mediaAuthorityGeneration !== this.#mediaAuthorityGeneration ||
			!this.#authorizedMedia.has(mediaId)
		) {
			throw new RpcCollaborationStateError("Collaboration media authority is no longer active");
		}
		return range;
	}

	async assertSessionIsolation(): Promise<void> {
		const token = this.#activeToken;
		if (!token || this.#sessionAuthorityMatches(token.sessionAuthority)) return;
		await this.leave("session_changed");
	}

	async dispose(): Promise<void> {
		await this.leave("rpc_disconnected");
	}

	#events(binding: RpcCollaborationEventBinding): RpcCollaborationOpenEvents {
		const resolveToken = (): RpcCollaborationLifecycleToken | undefined => this.#resolveBindingToken(binding);
		const resolveVisibleToken = (): RpcCollaborationLifecycleToken | undefined =>
			this.#transportCallbacksBlocked ? undefined : resolveToken();
		return {
			get lifecycleToken() {
				return resolveVisibleToken();
			},
			status: (state, reason) =>
				this.#dispatchTransportCallback(binding, token => this.#onStatus(token, state, reason)),
			participants: participants =>
				this.#dispatchTransportCallback(binding, token => this.#onParticipants(token, participants)),
			authority: authority =>
				this.#dispatchTransportCallback(binding, () => this.#enqueueAuthorityChange(binding, authority)),
			replicated: frame => this.#dispatchTransportCallback(binding, token => this.#onReplicated(token, frame)),
			media: media => this.#dispatchTransportMedia(binding, media),
			gap: () => this.#dispatchTransportCallback(binding, token => this.#markGap(token, "transport_gap")),
		};
	}

	#bind(
		state: "hosting" | "joining",
		role: "host" | "guest",
		authority: RpcCollaborationAuthority,
	): { token: RpcCollaborationLifecycleToken; binding: RpcCollaborationEventBinding } {
		this.#leavePromise = undefined;
		const sessionAuthority = this.#captureSessionAuthority();
		const token = Object.freeze({
			collaborationGeneration: ++this.#lifecycleGeneration,
			sessionAuthority,
		});
		const binding = { collaborationGeneration: token.collaborationGeneration, token };
		this.#activeToken = token;
		this.#activeBinding = binding;
		this.#sessionId = sessionAuthority.sessionId;
		this.#state = state;
		this.#role = role;
		this.#authority = authority;
		this.#failure = undefined;
		this.#clearAuthorizedMedia();
		this.#revision += 1;
		this.#emitState();
		return { token, binding };
	}

	#failOpen(_cause: unknown, token: RpcCollaborationLifecycleToken): void {
		if (this.#activeToken !== token) return;
		this.#invalidateToken(token);
		this.#connection = null;
		this.#state = "failed";
		this.#failure = { code: "collaboration_open_failed", retryable: true };
		this.#revision += 1;
		this.#emitState();
	}

	#onStatus(
		token: RpcCollaborationLifecycleToken,
		state: "connected" | "reconnecting" | "failed",
		reason?: RpcCollaborationStatusReason,
	): void {
		if (!this.#isCurrentToken(token)) return;
		this.#clearStaleTimer();
		if (state === "reconnecting") {
			this.#reconnecting = true;
			this.#state = "reconnecting";
			this.#failure = undefined;
			this.#staleTimer = setTimeout(() => {
				if (this.#isCurrentToken(token)) this.#markStale(token, "reconnect_timeout");
			}, this.#staleAfterMs);
		} else if (state === "connected") {
			if (this.#role === "guest" && this.#reconnecting) this.#beginGeneration();
			this.#reconnecting = false;
			this.#state = "connected";
			this.#stale = false;
			this.#failure = undefined;
		} else {
			this.#state = "failed";
			this.#failure = { code: reason ?? "transport_failed", retryable: reason !== "room_closed" };
			this.#invalidateToken(token);
		}
		this.#revision += 1;
		this.#emitState();
	}

	#onParticipants(token: RpcCollaborationLifecycleToken, participants: RpcCollaborationParticipant[]): void {
		if (!this.#isCurrentToken(token)) return;
		this.#participants = participants.map(participant => ({ ...participant }));
		this.#revision += 1;
		this.#emitState();
	}

	async #onAuthority(token: RpcCollaborationLifecycleToken, authority: "full" | "view"): Promise<void> {
		if (!this.#isCurrentToken(token) || this.#role !== "guest" || authority === this.#authority) return;
		if (this.#state !== "connected" || !this.#transitionAuthority) {
			this.#clearAuthorizedMedia();
			this.#authority = authority;
			this.#revision += 1;
			this.#emitState();
			return;
		}
		let transitionToken: RpcCollaborationLifecycleToken | undefined;
		let installed = false;
		try {
			await this.#transitionAuthority(
				() => {
					const current = this.#activeBinding ? this.#resolveBindingToken(this.#activeBinding) : undefined;
					if (!current || current.collaborationGeneration !== token.collaborationGeneration) {
						throw this.#staleOpenError();
					}
					transitionToken = current;
					return current.sessionAuthority;
				},
				() => {
					if (!transitionToken || !this.#isCurrentToken(transitionToken)) throw this.#staleOpenError();
					this.#transportCallbacksBlocked = true;
					this.#clearAuthorizedMedia();
					this.#authority = authority;
					this.#revision += 1;
				},
				nextAuthority => {
					if (!transitionToken) throw this.#staleOpenError();
					this.#installAuthoritySuccessor(transitionToken, nextAuthority);
					installed = true;
					this.#emitState();
				},
			);
		} catch {
			if (!installed && transitionToken) this.#failAuthorityChange(transitionToken);
		} finally {
			this.#transportCallbacksBlocked = false;
			this.#flushTransportCallbacks();
		}
	}

	#onReplicated(token: RpcCollaborationLifecycleToken, input: RpcCollaborationReplicatedInput): void {
		if (
			!this.#isCurrentToken(token) ||
			this.#role !== "guest" ||
			this.#state === "off" ||
			this.#state === "leaving" ||
			this.#state === "failed" ||
			this.#stale
		)
			return;
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
		this.#retainAndEmit(token, cursor, frame);
	}

	async #onMedia(
		token: RpcCollaborationLifecycleToken,
		input: RpcCollaborationMediaInput,
	): Promise<RpcCollaborationMediaDescriptor> {
		if (
			!this.#isCurrentToken(token) ||
			this.#role !== "guest" ||
			this.#state === "off" ||
			this.#state === "leaving" ||
			this.#state === "failed" ||
			this.#stale
		) {
			throw new RpcCollaborationStateError("Collaboration media arrived without an active guest replica");
		}
		const mediaAuthorityGeneration = this.#mediaAuthorityGeneration;
		const media = await this.#media.save(input.mediaType, input.data, token);
		if (!this.#isCurrentToken(token) || mediaAuthorityGeneration !== this.#mediaAuthorityGeneration) {
			throw new RpcCollaborationStateError("Collaboration media arrived after its authority expired");
		}
		this.#authorizedMedia.add(media.mediaId);
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
		this.#retainAndEmit(token, cursor, frame);
		return media;
	}

	#retainAndEmit(
		token: RpcCollaborationLifecycleToken,
		cursor: RpcCollaborationCursor,
		frame: Extract<RpcCollaborationFrame, { type: "collaboration_replicated" }>,
	): void {
		if (!this.#isCurrentToken(token)) return;
		if (this.#retained.length >= this.#maxRetainedFrames) {
			this.#markGap(token, "backpressure_overflow");
			return;
		}
		this.#retained.push({ cursor, frame });
		this.#revision += 1;
		this.#output(frame);
	}

	#markGap(token: RpcCollaborationLifecycleToken, reason: "backpressure_overflow" | "transport_gap"): void {
		if (!this.#isCurrentToken(token) || this.#role !== "guest" || this.#stale || this.#gapSignalled) return;
		this.#gapSignalled = true;
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
		if (!this.#isCurrentToken(token)) return;
		this.#reconnecting = true;
		this.#markStale(token, reason);
		if (this.#isCurrentToken(token)) this.#connection?.requestResync();
	}

	#markStale(
		token: RpcCollaborationLifecycleToken,
		reason: "backpressure_overflow" | "reconnect_timeout" | "transport_gap",
	): void {
		if (!this.#isCurrentToken(token) || this.#role !== "guest" || this.#stale) return;
		this.#clearStaleTimer();
		this.#stale = true;
		this.#state = "stale";
		this.#clearAuthorizedMedia();
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
		this.#gapSignalled = false;
		this.#clearAuthorizedMedia();
	}

	#requireHost(): RpcCollaborationConnection {
		this.#requireCurrentToken();
		if (this.#role !== "host" || this.#authority !== "full" || !this.#connection) {
			throw new RpcCollaborationAuthorityError("Collaboration host authority is required");
		}
		return this.#connection;
	}

	#requireWritableGuest(): RpcCollaborationConnection {
		this.#requireCurrentToken();
		if (this.#role !== "guest" || this.#authority !== "full" || !this.#connection || this.#state !== "connected") {
			throw new RpcCollaborationAuthorityError("Writable collaboration guest authority is required");
		}
		return this.#connection;
	}

	#requireCurrentToken(): RpcCollaborationLifecycleToken {
		const token = this.#activeToken;
		if (!token || !this.#isCurrentToken(token))
			throw new RpcCollaborationStateError("Collaboration authority is stale");
		return token;
	}

	#requireReadableMedia(mediaId: string): RpcCollaborationLifecycleToken {
		const token = this.#requireCurrentToken();
		if (this.#role !== "guest" || this.#state !== "connected" || this.#stale || !this.#authorizedMedia.has(mediaId)) {
			throw new RpcCollaborationAuthorityError("Collaboration media authority is required");
		}
		return token;
	}

	#assertOff(): void {
		if (this.#state !== "off") throw new RpcCollaborationStateError("A collaboration session is already active");
	}

	#captureSessionAuthority(): RpcCollaborationSessionAuthority {
		const supplied = this.#getSessionAuthority?.();
		const authority = supplied ?? {
			sessionId: this.#getSessionId(),
			sessionGeneration: 0,
			authorityGeneration: 0,
		};
		return Object.freeze({
			sessionId: authority.sessionId,
			sessionGeneration: authority.sessionGeneration,
			authorityGeneration: authority.authorityGeneration,
		});
	}

	#installCommittedAuthority(
		token: RpcCollaborationLifecycleToken,
		commitAuthority: RpcCollaborationAuthorityCommit | undefined,
	): RpcCollaborationLifecycleToken {
		if (!commitAuthority) return token;
		const binding = this.#activeBinding;
		if (this.#activeToken !== token || !binding || binding.token !== token || !this.#isCurrentToken(token)) {
			throw this.#staleOpenError();
		}
		return this.#installAuthoritySuccessor(token, commitAuthority(token.sessionAuthority));
	}

	#installAuthoritySuccessor(
		token: RpcCollaborationLifecycleToken,
		nextAuthority: RpcCollaborationSessionAuthority,
	): RpcCollaborationLifecycleToken {
		const binding = this.#activeBinding;
		if (!binding || this.#activeToken !== token || this.#activeBinding !== binding || binding.token !== token) {
			throw this.#staleOpenError();
		}
		if (
			nextAuthority.sessionId !== token.sessionAuthority.sessionId ||
			nextAuthority.sessionGeneration !== token.sessionAuthority.sessionGeneration ||
			nextAuthority.authorityGeneration !== token.sessionAuthority.authorityGeneration + 1
		) {
			throw new RpcCollaborationStateError("Collaboration authority commit returned an invalid successor");
		}
		const nextToken = Object.freeze({
			collaborationGeneration: token.collaborationGeneration,
			sessionAuthority: Object.freeze({
				sessionId: nextAuthority.sessionId,
				sessionGeneration: nextAuthority.sessionGeneration,
				authorityGeneration: nextAuthority.authorityGeneration,
			}),
		});
		this.#activeToken = nextToken;
		binding.token = nextToken;
		return nextToken;
	}

	#sessionAuthorityMatches(expected: RpcCollaborationSessionAuthority): boolean {
		try {
			const current = this.#captureSessionAuthority();
			return (
				current.sessionId === expected.sessionId &&
				current.sessionGeneration === expected.sessionGeneration &&
				current.authorityGeneration === expected.authorityGeneration
			);
		} catch {
			return false;
		}
	}

	#dispatchTransportCallback(
		binding: RpcCollaborationEventBinding,
		callback: (token: RpcCollaborationLifecycleToken) => void,
	): void {
		const invoke = (): void => {
			const token = this.#resolveBindingToken(binding);
			if (token) callback(token);
		};
		if (this.#transportCallbacksBlocked) this.#pendingTransportCallbacks.push(invoke);
		else invoke();
	}

	#dispatchTransportMedia(
		binding: RpcCollaborationEventBinding,
		media: RpcCollaborationMediaInput,
	): Promise<RpcCollaborationMediaDescriptor> {
		if (!this.#transportCallbacksBlocked) {
			const token = this.#resolveBindingToken(binding);
			if (!token) {
				return Promise.reject(
					new RpcCollaborationStateError("Collaboration media arrived without active authority"),
				);
			}
			return this.#onMedia(token, media);
		}
		const deferred = Promise.withResolvers<RpcCollaborationMediaDescriptor>();
		this.#pendingTransportCallbacks.push(() => {
			const token = this.#resolveBindingToken(binding);
			if (!token) {
				deferred.reject(new RpcCollaborationStateError("Collaboration media arrived without active authority"));
				return;
			}
			void this.#onMedia(token, media).then(deferred.resolve, deferred.reject);
		});
		return deferred.promise;
	}

	#flushTransportCallbacks(): void {
		for (;;) {
			const callback = this.#pendingTransportCallbacks.shift();
			if (!callback) return;
			try {
				callback();
			} catch {
				// Deferred transport callbacks are isolated from authority settlement.
			}
		}
	}

	#resolveBindingToken(binding: RpcCollaborationEventBinding): RpcCollaborationLifecycleToken | undefined {
		const token = binding.token;
		return this.#activeBinding === binding &&
			this.#activeToken === token &&
			binding.collaborationGeneration === token.collaborationGeneration &&
			this.#isCurrentToken(token)
			? token
			: undefined;
	}

	#enqueueAuthorityChange(binding: RpcCollaborationEventBinding, authority: "full" | "view"): void {
		this.#pendingAuthorityChanges.push({ binding, authority });
		if (this.#authorityChangeRunning) return;
		this.#authorityChangeRunning = true;
		void this.#drainAuthorityChanges();
	}

	async #drainAuthorityChanges(): Promise<void> {
		try {
			for (;;) {
				const change = this.#pendingAuthorityChanges.shift();
				if (!change) return;
				const token = this.#resolveBindingToken(change.binding);
				if (token) await this.#onAuthority(token, change.authority);
			}
		} finally {
			this.#authorityChangeRunning = false;
			if (this.#pendingAuthorityChanges.length > 0) {
				this.#authorityChangeRunning = true;
				void this.#drainAuthorityChanges();
			}
		}
	}

	#failAuthorityChange(token: RpcCollaborationLifecycleToken): void {
		if (this.#activeToken !== token) return;
		this.#state = "failed";
		this.#failure = { code: "collaboration_authority_transition_failed", retryable: false };
		this.#invalidateToken(token);
		this.#revision += 1;
		this.#emitState();
	}

	#isCurrentToken(token: RpcCollaborationLifecycleToken): boolean {
		return (
			this.#activeToken === token &&
			this.#state !== "off" &&
			this.#state !== "leaving" &&
			this.#state !== "failed" &&
			this.#sessionAuthorityMatches(token.sessionAuthority)
		);
	}

	#invalidateToken(token: RpcCollaborationLifecycleToken | undefined): void {
		if (!token || this.#activeToken !== token) return;
		if (this.#activeBinding?.token === token) this.#activeBinding = undefined;
		this.#activeToken = undefined;
		this.#lifecycleGeneration += 1;
		this.#clearAuthorizedMedia();
	}

	#discardStaleOpen(token: RpcCollaborationLifecycleToken): void {
		if (this.#activeToken !== token) return;
		this.#invalidateToken(token);
		this.#connection = null;
		this.#reset();
	}

	async #closeConnection(connection: RpcCollaborationConnection, reason: string): Promise<void> {
		if (this.#closedConnections.has(connection)) return;
		this.#closedConnections.add(connection);
		try {
			await connection.leave(reason);
		} catch {
			// Cleanup is best effort; the lifecycle token remains invalidated.
		}
	}

	async #finishLeave(
		connection: RpcCollaborationConnection | null,
		reason: string,
		snapshot: RpcCollaborationSnapshot,
		deferred: PromiseWithResolvers<RpcCollaborationSnapshot>,
	): Promise<void> {
		try {
			if (connection) await this.#closeConnection(connection, reason);
			deferred.resolve(snapshot);
		} catch (cause) {
			deferred.reject(cause);
		} finally {
			if (this.#leavePromise === deferred.promise) this.#leavePromise = undefined;
		}
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
		this.#activeToken = undefined;
		this.#activeBinding = undefined;
		this.#gapSignalled = false;
		this.#clearAuthorizedMedia();
		this.#revision += 1;
		this.#emitState();
	}

	#clearAuthorizedMedia(): void {
		this.#authorizedMedia.clear();
		this.#mediaAuthorityGeneration += 1;
	}

	#clearStaleTimer(): void {
		if (this.#staleTimer === null) return;
		clearTimeout(this.#staleTimer);
		this.#staleTimer = null;
	}

	#staleOpenError(): RpcCollaborationStateError {
		return new RpcCollaborationStateError("Collaboration lifecycle token is no longer current");
	}

	#emitState(): void {
		this.#output({ type: "collaboration_state", snapshot: this.snapshot() });
	}
}
