export const SESSION_SEMANTIC_PROFILE = {
	name: "omp.session",
	major: 3,
	minMinor: 0,
	maxMinor: 0,
} as const;

export const MAX_SESSION_IDEMPOTENCY_KEYS = 1_024;

export interface SessionSemanticProfileRange {
	name: "omp.session";
	major: number;
	minMinor?: number;
	maxMinor?: number;
}

export interface SessionSemanticProfile {
	name: "omp.session";
	major: 3;
	minor: number;
}

export interface SessionHostLimits {
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	maxArtifactReadBytes: number;
	maxPendingObservations: number;
	maxIdempotencyKeys: number;
}

export interface SessionHostUnsupportedReason {
	code: string;
	message: string;
}

export interface SessionHostRecoveryGuarantees {
	transportReplay: "bounded";
	durableReplay: "session_journal";
	snapshotHandoff: "watermark";
	acknowledgement: "cumulative";
	gapRecovery: "resnapshot";
	duplicateHandling: "stable_event_id";
}

export interface SessionHostMutationGuarantees {
	correlation: "request_id";
	concurrency: "expected_revision";
	cancellation: "cooperative";
	terminalOutcomes: readonly ["completed", "cancelled", "failed", "unknown"];
	idempotency: {
		scope: "authority_lifetime";
		retention: "bounded";
		conflict: "reject";
		overflow: "reject";
	};
}

interface SessionHostCapabilityBase {
	id: string;
	version: number;
	operations: readonly string[];
	events: readonly string[];
	platforms: readonly string[];
}

export type SessionHostCapabilityDefinition =
	| (SessionHostCapabilityBase & { supported: true; unsupportedReason?: never })
	| (SessionHostCapabilityBase & { supported: false; unsupportedReason: SessionHostUnsupportedReason });

export interface SessionHostManifestInput {
	ompVersion: string;
	framingVersions: readonly number[];
	limits: SessionHostLimits;
	capabilities: readonly SessionHostCapabilityDefinition[];
	recovery: SessionHostRecoveryGuarantees;
	mutations: SessionHostMutationGuarantees;
}

export interface SessionHostManifest extends SessionHostManifestInput {
	semanticProfiles: readonly [typeof SESSION_SEMANTIC_PROFILE];
}

export interface SessionHostClientCapabilities {
	interactions: readonly string[];
	semanticContent: readonly string[];
}

export interface SessionHostNegotiationRequest {
	profile: SessionSemanticProfileRange;
	framingVersion: number;
	hostCapabilities: SessionHostClientCapabilities;
	requestedCapabilities: readonly string[];
}

export interface SessionHostNegotiated {
	ok: true;
	profile: SessionSemanticProfile;
	framingVersion: number;
	capabilities: SessionHostCapabilityDefinition[];
	hostCapabilities: SessionHostClientCapabilities;
}

export interface SessionHostIncompatible {
	ok: false;
	code: "unsupported_semantic_version" | "unsupported_framing_version" | "framing_not_selected";
	message: string;
	supportedProfiles: readonly [typeof SESSION_SEMANTIC_PROFILE];
}

export type SessionHostNegotiationResult = SessionHostNegotiated | SessionHostIncompatible;

export function createSessionHostManifest(input: SessionHostManifestInput): SessionHostManifest {
	return {
		...input,
		semanticProfiles: [SESSION_SEMANTIC_PROFILE],
	};
}

export function negotiateSessionHost(
	manifest: SessionHostManifest,
	request: SessionHostNegotiationRequest,
): SessionHostNegotiationResult {
	const requested = request.profile;
	const minimum = requested.minMinor ?? SESSION_SEMANTIC_PROFILE.minMinor;
	const maximum = requested.maxMinor ?? SESSION_SEMANTIC_PROFILE.maxMinor;
	if (
		requested.name !== SESSION_SEMANTIC_PROFILE.name ||
		requested.major !== SESSION_SEMANTIC_PROFILE.major ||
		minimum > SESSION_SEMANTIC_PROFILE.maxMinor ||
		maximum < SESSION_SEMANTIC_PROFILE.minMinor
	) {
		return {
			ok: false,
			code: "unsupported_semantic_version",
			message: `Unsupported ${requested.name} semantic major ${requested.major}`,
			supportedProfiles: [SESSION_SEMANTIC_PROFILE],
		};
	}
	if (!manifest.framingVersions.includes(request.framingVersion)) {
		return {
			ok: false,
			code: "unsupported_framing_version",
			message: `Unsupported RPC framing version ${request.framingVersion}`,
			supportedProfiles: [SESSION_SEMANTIC_PROFILE],
		};
	}

	const advertised = new Map(manifest.capabilities.map(capability => [capability.id, capability]));
	const capabilities = request.requestedCapabilities.map(
		(id): SessionHostCapabilityDefinition =>
			advertised.get(id) ?? {
				id,
				version: 0,
				supported: false,
				operations: [],
				events: [],
				platforms: [],
				unsupportedReason: {
					code: "unknown_capability",
					message: "Capability is not advertised",
				},
			},
	);

	return {
		ok: true,
		profile: {
			name: SESSION_SEMANTIC_PROFILE.name,
			major: SESSION_SEMANTIC_PROFILE.major,
			minor: Math.min(maximum, SESSION_SEMANTIC_PROFILE.maxMinor),
		},
		framingVersion: request.framingVersion,
		capabilities,
		hostCapabilities: request.hostCapabilities,
	};
}

export type SessionJsonValue =
	| string
	| number
	| boolean
	| null
	| SessionJsonValue[]
	| { [key: string]: SessionJsonValue };

export interface SessionJournalCursor {
	sessionId: string;
	leafId: string | null;
	entryId: string | null;
}

export interface SessionObservationPosition {
	epoch: string;
	sequence: number;
}

export type SessionTerminalSettlement = "none" | "completed" | "cancelled" | "failed";

interface SessionAuthorityObservationBase {
	kind: string;
	payload: SessionJsonValue;
	causationId?: string;
	terminalSettlement: SessionTerminalSettlement;
}

export type SessionAuthorityObservation =
	| (SessionAuthorityObservationBase & {
			durability: "durable";
			eventId: string;
			journalCursor: SessionJournalCursor;
	  })
	| (SessionAuthorityObservationBase & {
			durability: "transient";
			eventId?: never;
			journalCursor?: never;
	  });

export interface SessionObservationEnvelope extends SessionObservationPosition {
	type: "observation";
	sessionId: string;
	eventId: string;
	causationId?: string;
	kind: string;
	payload: SessionJsonValue;
	durability: "durable" | "transient";
	journalCursor?: SessionJournalCursor;
	replay: boolean;
	terminalSettlement: SessionTerminalSettlement;
}

export interface SessionObservationGap {
	type: "gap";
	sessionId: string;
	epoch: string;
	afterSequence: number;
	firstAvailableSequence: number;
	latestSequence: number;
	recovery: "resnapshot";
}

export type SessionObservation = SessionObservationEnvelope | SessionObservationGap;

export interface SessionAuthoritySnapshot {
	revision: number;
	state: SessionJsonValue;
	journalCursor: SessionJournalCursor;
}

export interface SessionAuthorityReplay {
	observations: readonly SessionAuthorityObservation[];
	journalCursor: SessionJournalCursor;
}

export class SessionCursorError extends Error {
	readonly code: "stale_cursor" | "replay_limit_exceeded";

	constructor(code: "stale_cursor" | "replay_limit_exceeded", message: string) {
		super(message);
		this.name = "SessionCursorError";
		this.code = code;
	}
}

export interface SessionSnapshot extends SessionAuthoritySnapshot {
	sessionId: string;
	watermark: SessionObservationPosition;
}

export interface SessionCommand {
	kind: string;
	input?: SessionJsonValue;
	expectedRevision?: number;
	idempotencyKey?: string;
}

export interface SessionCommandContext {
	requestId: string;
	signal?: AbortSignal;
}

export interface SessionCommandOutcome {
	outcome: "completed" | "cancelled" | "failed" | "unknown";
	revision?: number;
	result?: SessionJsonValue;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	};
}

export interface SessionAuthoritySettlement {
	state: "settled";
}

export interface SessionAuthority {
	readonly sessionId: string;
	/**
	 * Calls captureWatermark exactly once after sampling state and delivering
	 * every prior observation, before any later observation can be delivered.
	 */
	snapshot(captureWatermark: () => void): Promise<SessionAuthoritySnapshot>;
	replay(after: SessionJournalCursor, limit: number): Promise<SessionAuthorityReplay>;
	subscribe(listener: (observation: SessionAuthorityObservation) => void): () => void;
	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome>;
	settle(): Promise<SessionAuthoritySettlement>;
	dispose(): void;
}

export interface SessionHostOptions {
	epoch?: string;
	maxBufferedObservations: number;
}

export interface SessionOpenOptions {
	after?: SessionObservationPosition;
	snapshot?: boolean;
	afterCursor?: SessionJournalCursor;
}

export interface SessionOpenResult {
	snapshot?: SessionSnapshot;
	observations: AsyncIterator<SessionObservation>;
	acknowledge(sequence: number): Promise<void>;
	close(): Promise<void>;
}

export class SessionHost {
	readonly #authority: SessionAuthority;
	readonly #epoch: string;
	readonly #capacity: number;
	readonly #events: Array<SessionObservationEnvelope | undefined>;
	readonly #waiters = new Set<() => void>();
	readonly #subscriptions = new Set<SessionHostSubscription>();
	readonly #unsubscribe: () => void;
	#latestSequence = 0;
	#replaying = false;
	#deferredObservations: SessionAuthorityObservation[] = [];
	#deferredOverflow = false;
	#closePromise: Promise<SessionAuthoritySettlement> | undefined;
	#closed = false;

	constructor(authority: SessionAuthority, options: SessionHostOptions) {
		if (!Number.isSafeInteger(options.maxBufferedObservations) || options.maxBufferedObservations < 1) {
			throw new Error("maxBufferedObservations must be a positive safe integer");
		}
		this.#authority = authority;
		this.#epoch = options.epoch ?? crypto.randomUUID();
		this.#capacity = options.maxBufferedObservations;
		this.#events = new Array<SessionObservationEnvelope | undefined>(this.#capacity);
		this.#unsubscribe = authority.subscribe(observation => this.#record(observation));
	}

	get sessionId(): string {
		return this.#authority.sessionId;
	}

	get position(): SessionObservationPosition {
		return { epoch: this.#epoch, sequence: this.#latestSequence };
	}
	async open(options: SessionOpenOptions = {}): Promise<SessionOpenResult> {
		if (this.#closePromise) throw new Error("Session host is closing");
		if (options.after && options.afterCursor) {
			throw new SessionCursorError("stale_cursor", "Transport and durable cursors cannot be combined");
		}
		if (options.after && options.after.epoch !== this.#epoch) {
			return this.#createSubscription(options.after.sequence, {
				type: "gap",
				sessionId: this.sessionId,
				epoch: this.#epoch,
				afterSequence: options.after.sequence,
				firstAvailableSequence: this.#firstAvailableSequence(),
				latestSequence: this.#latestSequence,
				recovery: "resnapshot",
			});
		}

		let afterSequence = options.after?.sequence ?? this.#latestSequence;
		if (options.afterCursor) {
			if (this.#subscriptions.size > 0) {
				throw new SessionCursorError(
					"replay_limit_exceeded",
					"Durable replay requires all existing subscriptions to close",
				);
			}
			afterSequence = this.#latestSequence;
			this.#replaying = true;
			let replayOverflow = false;
			try {
				const replay = await this.#authority.replay(options.afterCursor, this.#capacity);
				for (const observation of replay.observations) this.#append(observation, true);
			} finally {
				this.#replaying = false;
				const deferred = this.#deferredObservations;
				this.#deferredObservations = [];
				replayOverflow = this.#deferredOverflow;
				this.#deferredOverflow = false;
				if (!replayOverflow) {
					for (const observation of deferred) this.#append(observation, false);
				}
			}
			if (replayOverflow) {
				throw new SessionCursorError(
					"replay_limit_exceeded",
					"Live observations exceeded the replay handoff buffer; resnapshot is required",
				);
			}
		}
		if (options.snapshot === false) return this.#createSubscription(afterSequence);

		let snapshotSequence: number | undefined;
		const authoritySnapshot = await this.#authority.snapshot(() => {
			snapshotSequence = this.#latestSequence;
		});
		if (snapshotSequence === undefined) {
			throw new Error("Session authority did not capture the snapshot watermark");
		}
		afterSequence = snapshotSequence;
		const watermark = { epoch: this.#epoch, sequence: afterSequence };
		return this.#createSubscription(afterSequence, undefined, {
			...authoritySnapshot,
			sessionId: this.sessionId,
			watermark,
		});
	}

	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome> {
		if (this.#closePromise) {
			return Promise.resolve({
				outcome: "failed",
				error: { code: "session_closing", message: "Session host is closing", retryable: false },
			});
		}
		return this.#authority.invoke(command, context);
	}

	close(): Promise<SessionAuthoritySettlement> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = (async () => {
			try {
				return await this.#authority.settle();
			} finally {
				this.#unsubscribe();
				this.#authority.dispose();
				this.#closed = true;
				this.#subscriptions.clear();
				this.#wakeAll();
			}
		})();
		return this.#closePromise;
	}

	disconnect(): void {
		if (this.#closed || this.#closePromise) return;
		this.#unsubscribe();
		this.#authority.dispose();
		this.#closed = true;
		this.#subscriptions.clear();
		this.#wakeAll();
	}

	#record(observation: SessionAuthorityObservation): void {
		if (this.#closed) return;
		if (this.#replaying) {
			if (this.#deferredObservations.length >= this.#capacity) {
				this.#deferredOverflow = true;
				return;
			}
			this.#deferredObservations.push(observation);
			return;
		}
		this.#append(observation, false);
	}

	#append(observation: SessionAuthorityObservation, replay: boolean): void {
		const sequence = ++this.#latestSequence;
		const envelope: SessionObservationEnvelope = {
			type: "observation",
			sessionId: this.sessionId,
			epoch: this.#epoch,
			sequence,
			eventId: observation.durability === "durable" ? observation.eventId : `${this.#epoch}:${sequence}`,
			...(observation.causationId === undefined ? {} : { causationId: observation.causationId }),
			kind: observation.kind,
			payload: observation.payload,
			durability: observation.durability,
			...(observation.durability === "durable" ? { journalCursor: observation.journalCursor } : {}),
			terminalSettlement: observation.terminalSettlement,
			replay,
		};
		this.#events[(sequence - 1) % this.#capacity] = envelope;
		this.#wakeAll();
	}

	#createSubscription(
		afterSequence: number,
		initial?: SessionObservationGap,
		snapshot?: SessionSnapshot,
	): SessionOpenResult {
		const subscription = new SessionHostSubscription(this, afterSequence, initial, snapshot);
		this.#subscriptions.add(subscription);
		return subscription;
	}

	#firstAvailableSequence(): number {
		return Math.max(1, this.#latestSequence - this.#capacity + 1);
	}

	#readAfter(sequence: number): SessionObservation | undefined {
		const firstAvailableSequence = this.#firstAvailableSequence();
		if (sequence + 1 < firstAvailableSequence) {
			return {
				type: "gap",
				sessionId: this.sessionId,
				epoch: this.#epoch,
				afterSequence: sequence,
				firstAvailableSequence,
				latestSequence: this.#latestSequence,
				recovery: "resnapshot",
			};
		}
		if (sequence >= this.#latestSequence) return undefined;
		return this.#events[sequence % this.#capacity];
	}

	async nextAfter(subscription: SessionHostSubscription, sequence: number): Promise<SessionObservation | undefined> {
		while (!subscription.closed) {
			if (subscription.pendingCount >= this.#capacity) {
				const overflow = this.#readAfter(subscription.acknowledgedSequence);
				if (overflow?.type === "gap") return overflow;
			}
			const available = this.#readAfter(sequence);
			if (available) return available;
			if (this.#closed) return undefined;
			const wake = Promise.withResolvers<void>();
			this.#waiters.add(wake.resolve);
			if (this.#readAfter(sequence) || this.#closed) {
				this.#waiters.delete(wake.resolve);
				continue;
			}
			await wake.promise;
		}
		return undefined;
	}

	removeSubscription(subscription: SessionHostSubscription): void {
		this.#subscriptions.delete(subscription);
		this.#wakeAll();
	}

	subscriptionAcknowledged(): void {
		this.#wakeAll();
	}

	#wakeAll(): void {
		for (const wake of this.#waiters) wake();
		this.#waiters.clear();
	}
}

class SessionHostSubscription implements SessionOpenResult {
	readonly snapshot?: SessionSnapshot;
	readonly observations: AsyncIterator<SessionObservation>;
	readonly #host: SessionHost;
	#cursor: number;
	#acknowledged: number;
	#initial: SessionObservation | undefined;
	closed = false;

	get acknowledgedSequence(): number {
		return this.#acknowledged;
	}

	get pendingCount(): number {
		return this.#cursor - this.#acknowledged;
	}

	constructor(host: SessionHost, afterSequence: number, initial?: SessionObservation, snapshot?: SessionSnapshot) {
		this.#host = host;
		this.#cursor = afterSequence;
		this.#acknowledged = afterSequence;
		this.#initial = initial;
		this.snapshot = snapshot;
		this.observations = {
			next: () => this.#next(),
			return: async () => {
				await this.close();
				return { done: true, value: undefined };
			},
		};
	}

	async acknowledge(sequence: number): Promise<void> {
		if (!Number.isSafeInteger(sequence) || sequence < this.#acknowledged || sequence > this.#cursor) {
			throw new Error(`Invalid observation acknowledgement ${sequence}`);
		}
		this.#acknowledged = sequence;
		this.#host.subscriptionAcknowledged();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.#host.removeSubscription(this);
	}

	async #next(): Promise<IteratorResult<SessionObservation>> {
		if (this.closed) return { done: true, value: undefined };
		if (this.#initial) {
			const initial = this.#initial;
			this.#initial = undefined;
			if (initial.type === "gap") await this.close();
			return { done: false, value: initial };
		}
		const observation = await this.#host.nextAfter(this, this.#cursor);
		if (!observation) return { done: true, value: undefined };
		if (observation.type === "gap") {
			await this.close();
			return { done: false, value: observation };
		}
		this.#cursor = observation.sequence;
		return { done: false, value: observation };
	}
}
