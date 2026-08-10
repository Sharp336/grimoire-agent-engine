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
	maxSubscriptions?: number;
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
	readonly code: "stale_cursor" | "replay_limit_exceeded" | "subscription_capacity";
	readonly recovery: "resnapshot" | undefined;

	constructor(
		code: "stale_cursor" | "replay_limit_exceeded" | "subscription_capacity",
		message: string,
		recovery?: "resnapshot",
	) {
		super(message);
		this.name = "SessionCursorError";
		this.code = code;
		this.recovery = recovery ?? (code === "replay_limit_exceeded" ? "resnapshot" : undefined);
	}
}

export class SessionSubscriptionCapacityError extends SessionCursorError {
	readonly retryable = true;
	readonly limit: number;

	constructor(limit: number) {
		super("subscription_capacity", `Session observation subscription capacity is ${limit}`);
		this.name = "SessionSubscriptionCapacityError";
		this.limit = limit;
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
	maxSubscriptions?: number;
}

export interface SessionOpenOptions {
	after?: SessionObservationPosition;
	snapshot?: boolean;
	afterCursor?: SessionJournalCursor;
}

export interface SessionOpenResult {
	snapshot?: SessionSnapshot;
	durableCursor?: SessionJournalCursor;
	watermark: SessionObservationPosition;
	replayComplete: true;
	replayPending: boolean;
	replayBarrier: Promise<void>;
	observations: AsyncIterator<SessionObservation>;
	acknowledge(sequence: number): Promise<void>;
	close(): Promise<void>;
}

export const DEFAULT_MAX_SESSION_SUBSCRIPTIONS = 64;

type SessionHostSubscriptionMetadata = {
	durableCursor?: SessionJournalCursor;
	watermark: SessionObservationPosition;
	transportEpoch?: string;
	replayObservations?: readonly SessionAuthorityObservation[];
	initialLiveObservations?: readonly SessionAuthorityObservation[];
};

function createSessionObservationEnvelope(
	observation: SessionAuthorityObservation,
	sessionId: string,
	epoch: string,
	sequence: number,
	replay: boolean,
): SessionObservationEnvelope {
	return {
		type: "observation",
		sessionId,
		epoch,
		sequence,
		eventId: observation.durability === "durable" ? observation.eventId : `${epoch}:${sequence}`,
		...(observation.causationId === undefined ? {} : { causationId: observation.causationId }),
		kind: observation.kind,
		payload: observation.payload,
		durability: observation.durability,
		...(observation.durability === "durable" ? { journalCursor: observation.journalCursor } : {}),
		terminalSettlement: observation.terminalSettlement,
		replay,
	};
}

export class SessionHost {
	readonly #authority: SessionAuthority;
	readonly #epoch: string;
	readonly #capacity: number;
	readonly #maxSubscriptions: number;
	readonly #events: Array<SessionObservationEnvelope | undefined>;
	readonly #waiters = new Set<() => void>();
	readonly #subscriptions = new Set<SessionHostSubscription>();
	readonly #unsubscribe: () => void;
	#latestSequence = 0;
	#replaying = false;
	#deferredObservations: SessionAuthorityObservation[] = [];
	#deferredOverflow = false;
	#durableOpenTail: Promise<void> = Promise.resolve();
	#closePromise: Promise<SessionAuthoritySettlement> | undefined;
	#closed = false;

	constructor(authority: SessionAuthority, options: SessionHostOptions) {
		if (!Number.isSafeInteger(options.maxBufferedObservations) || options.maxBufferedObservations < 1) {
			throw new Error("maxBufferedObservations must be a positive safe integer");
		}
		const maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SESSION_SUBSCRIPTIONS;
		if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1) {
			throw new Error("maxSubscriptions must be a positive safe integer");
		}
		this.#authority = authority;
		this.#epoch = options.epoch ?? crypto.randomUUID();
		this.#capacity = options.maxBufferedObservations;
		this.#maxSubscriptions = maxSubscriptions;
		this.#events = new Array<SessionObservationEnvelope | undefined>(this.#capacity);
		this.#unsubscribe = authority.subscribe(observation => this.#record(observation));
	}

	get sessionId(): string {
		return this.#authority.sessionId;
	}

	get position(): SessionObservationPosition {
		return { epoch: this.#epoch, sequence: this.#latestSequence };
	}

	get maxSubscriptions(): number {
		return this.#maxSubscriptions;
	}

	get maxBufferedObservations(): number {
		return this.#capacity;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async open(options: SessionOpenOptions = {}): Promise<SessionOpenResult> {
		if (this.#closePromise || this.#closed) throw new Error("Session host is closing");
		if (options.after && options.afterCursor) {
			throw new SessionCursorError("stale_cursor", "Transport and durable cursors cannot be combined");
		}
		if (options.after && (!Number.isSafeInteger(options.after.sequence) || options.after.sequence < 0)) {
			throw new SessionCursorError("stale_cursor", "Transport cursor sequence must be a non-negative safe integer");
		}
		if (options.afterCursor) {
			this.#assertSubscriptionCapacity();
			return this.#withDurableOpen(() => this.#openDurable(options.afterCursor!, options.snapshot !== false));
		}

		const afterSequence = options.after?.sequence ?? this.#latestSequence;
		if (options.after && options.after.epoch !== this.#epoch) {
			return this.#createSubscription(
				afterSequence,
				{
					type: "gap",
					sessionId: this.sessionId,
					epoch: this.#epoch,
					afterSequence,
					firstAvailableSequence: this.#firstAvailableSequence(),
					latestSequence: this.#latestSequence,
					recovery: "resnapshot",
				},
				undefined,
				{ watermark: this.position },
			);
		}
		if (options.after && options.after.sequence > this.#latestSequence) {
			return this.#createSubscription(
				afterSequence,
				{
					type: "gap",
					sessionId: this.sessionId,
					epoch: this.#epoch,
					afterSequence,
					firstAvailableSequence: this.#firstAvailableSequence(),
					latestSequence: this.#latestSequence,
					recovery: "resnapshot",
				},
				undefined,
				{ watermark: this.position },
			);
		}
		if (options.snapshot === false) {
			return this.#createSubscription(afterSequence, undefined, undefined, {
				watermark: { epoch: this.#epoch, sequence: afterSequence },
			});
		}
		return this.#openSnapshot();
	}

	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome> {
		if (this.#closePromise || this.#closed) {
			return Promise.resolve({
				outcome: "failed",
				error: { code: "session_closing", message: "Session host is closing", retryable: false },
			});
		}
		return this.#authority.invoke(command, context);
	}

	close(): Promise<SessionAuthoritySettlement> {
		if (this.#closePromise) return this.#closePromise;
		if (this.#closed) return Promise.resolve<SessionAuthoritySettlement>({ state: "settled" });
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
		this.#closeSubscriptions();
		this.#wakeAll();
	}
	#closeSubscriptions(): void {
		const subscriptions = Array.from(this.#subscriptions);
		this.#subscriptions.clear();
		for (const subscription of subscriptions) void subscription.close();
	}

	#assertSubscriptionCapacity(): void {
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			throw new SessionSubscriptionCapacityError(this.#maxSubscriptions);
		}
	}

	async #withDurableOpen<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#durableOpenTail;
		const turn = Promise.withResolvers<void>();
		this.#durableOpenTail = previous.catch(() => undefined).then(() => turn.promise);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #openDurable(afterCursor: SessionJournalCursor, withSnapshot: boolean): Promise<SessionOpenResult> {
		this.#assertSubscriptionCapacity();
		this.#replaying = true;
		this.#deferredObservations = [];
		this.#deferredOverflow = false;
		let replay: SessionAuthorityReplay | undefined;
		let authoritySnapshot: SessionAuthoritySnapshot | undefined;
		let snapshotCaptured = false;
		let deferredLive: SessionAuthorityObservation[] = [];
		try {
			replay = await this.#authority.replay(afterCursor, this.#capacity);
			if (replay.observations.length > this.#capacity) {
				throw new SessionCursorError(
					"replay_limit_exceeded",
					`Durable replay exceeds the limit of ${this.#capacity}; resnapshot is required`,
					"resnapshot",
				);
			}
			if (withSnapshot) {
				authoritySnapshot = await this.#authority.snapshot(() => {
					snapshotCaptured = true;
				});
				if (!snapshotCaptured) throw new Error("Session authority did not capture the snapshot watermark");
			}
		} finally {
			this.#replaying = false;
			deferredLive = this.#deferredObservations;
			const deferredOverflow = this.#deferredOverflow;
			this.#deferredObservations = [];
			this.#deferredOverflow = false;
			for (const observation of deferredLive) {
				this.#append(observation);
				this.#enqueueDurableObservation(observation);
			}
			if (deferredOverflow) {
				this.#deferredOverflow = true;
				this.#signalDeferredReplayOverflow();
			}
		}

		if (!replay) throw new Error("Session authority did not return durable replay");
		if (this.#deferredOverflow || replay.observations.length + deferredLive.length > this.#capacity) {
			throw new SessionCursorError(
				"replay_limit_exceeded",
				"Live observations exceeded the durable replay handoff capacity; resnapshot is required",
				"resnapshot",
			);
		}
		const transportEpoch = crypto.randomUUID();
		const watermark = { epoch: transportEpoch, sequence: replay.observations.length };
		const snapshot =
			authoritySnapshot === undefined
				? undefined
				: {
						...authoritySnapshot,
						sessionId: this.sessionId,
						watermark,
					};
		return this.#createSubscription(0, undefined, snapshot, {
			durableCursor: replay.journalCursor,
			watermark,
			transportEpoch,
			replayObservations: replay.observations,
			initialLiveObservations: deferredLive,
		});
	}

	async #openSnapshot(): Promise<SessionOpenResult> {
		this.#assertSubscriptionCapacity();
		let snapshotSequence: number | undefined;
		const authoritySnapshot = await this.#authority.snapshot(() => {
			snapshotSequence = this.#latestSequence;
		});
		if (snapshotSequence === undefined) {
			throw new Error("Session authority did not capture the snapshot watermark");
		}
		const watermark = { epoch: this.#epoch, sequence: snapshotSequence };
		return this.#createSubscription(
			snapshotSequence,
			undefined,
			{
				...authoritySnapshot,
				sessionId: this.sessionId,
				watermark,
			},
			{ durableCursor: authoritySnapshot.journalCursor, watermark },
		);
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
		this.#append(observation);
		this.#enqueueDurableObservation(observation);
	}

	#append(observation: SessionAuthorityObservation): void {
		const sequence = ++this.#latestSequence;
		const envelope = createSessionObservationEnvelope(observation, this.sessionId, this.#epoch, sequence, false);
		this.#events[(sequence - 1) % this.#capacity] = envelope;
		this.#wakeAll();
	}

	#enqueueDurableObservation(observation: SessionAuthorityObservation): void {
		for (const subscription of this.#subscriptions) {
			if (subscription.isDurable) subscription.enqueueLive(observation);
		}
	}

	#signalDeferredReplayOverflow(): void {
		const sequence = ++this.#latestSequence;
		this.#events[(sequence - 1) % this.#capacity] = undefined;
		for (const subscription of this.#subscriptions) subscription.signalReplayOverflow();
		this.#wakeAll();
	}

	#createSubscription(
		afterSequence: number,
		initial?: SessionObservationGap,
		snapshot?: SessionSnapshot,
		metadata: SessionHostSubscriptionMetadata = { watermark: this.position },
	): SessionOpenResult {
		if (this.#closePromise || this.#closed) throw new Error("Session host is closing");
		this.#assertSubscriptionCapacity();
		const subscription = new SessionHostSubscription(this, afterSequence, initial, snapshot, metadata);
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
		const expectedSequence = sequence + 1;
		const envelope = this.#events[sequence % this.#capacity];
		if (!envelope || envelope.sequence !== expectedSequence) {
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
		return envelope;
	}

	async nextAfter(subscription: SessionHostSubscription, sequence: number): Promise<SessionObservation | undefined> {
		while (!subscription.closed) {
			if (subscription.pendingCount >= this.#capacity) {
				const overflow = this.#readAfter(subscription.acknowledgedSequence);
				if (overflow?.type === "gap") return overflow;
			} else {
				const available = this.#readAfter(sequence);
				if (available) return available;
			}
			if (this.#closed) return undefined;
			const wake = Promise.withResolvers<void>();
			this.#waiters.add(wake.resolve);
			const available = subscription.pendingCount < this.#capacity ? this.#readAfter(sequence) : undefined;
			if (available || subscription.closed || this.#closed) {
				this.#waiters.delete(wake.resolve);
				continue;
			}
			await wake.promise;
		}
		return undefined;
	}

	async waitForObservation(subscription: SessionHostSubscription): Promise<void> {
		while (!subscription.closed && !this.#closed && !subscription.hasAvailable) {
			const wake = Promise.withResolvers<void>();
			this.#waiters.add(wake.resolve);
			if (subscription.closed || this.#closed || subscription.hasAvailable) {
				this.#waiters.delete(wake.resolve);
				continue;
			}
			await wake.promise;
		}
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
	readonly durableCursor?: SessionJournalCursor;
	readonly watermark: SessionObservationPosition;
	readonly replayComplete = true as const;
	readonly replayPending: boolean;
	readonly replayBarrier: Promise<void>;
	readonly observations: AsyncIterator<SessionObservation>;
	readonly isDurable: boolean;
	readonly #host: SessionHost;
	readonly #transportEpoch: string;
	readonly #replayQueue: SessionObservationEnvelope[];
	readonly #resolveReplayBarrier: () => void;
	#liveQueue: SessionObservationEnvelope[] = [];
	#replayIndex = 0;
	#liveIndex = 0;
	#nextSequence = 0;
	#cursor: number;
	#acknowledged: number;
	#initial: SessionObservation | undefined;
	#overflow: SessionObservationGap | undefined;
	closed = false;

	get acknowledgedSequence(): number {
		return this.#acknowledged;
	}

	get pendingCount(): number {
		return this.#cursor - this.#acknowledged;
	}

	get hasAvailable(): boolean {
		return (
			this.#initial !== undefined ||
			this.#overflow !== undefined ||
			this.#replayIndex < this.#replayQueue.length ||
			this.#liveIndex < this.#liveQueue.length
		);
	}

	constructor(
		host: SessionHost,
		afterSequence: number,
		initial: SessionObservation | undefined,
		snapshot: SessionSnapshot | undefined,
		metadata: SessionHostSubscriptionMetadata,
	) {
		const replayBarrier = Promise.withResolvers<void>();
		this.#host = host;
		this.#cursor = afterSequence;
		this.#acknowledged = afterSequence;
		this.#initial = initial;
		this.snapshot = snapshot;
		this.durableCursor = metadata.durableCursor;
		this.watermark = metadata.watermark;
		this.isDurable = metadata.transportEpoch !== undefined;
		this.#transportEpoch = metadata.transportEpoch ?? metadata.watermark.epoch;
		const replayObservations = metadata.replayObservations ?? [];
		this.#replayQueue = replayObservations.map((observation, index) =>
			createSessionObservationEnvelope(observation, this.#host.sessionId, this.#transportEpoch, index + 1, true),
		);
		this.#nextSequence = this.#replayQueue.length;
		this.replayPending = this.#replayQueue.length > 0;
		this.replayBarrier = replayBarrier.promise;
		this.#resolveReplayBarrier = replayBarrier.resolve;
		if (initial?.type === "gap" || !this.replayPending) this.#resolveReplayBarrier();
		for (const observation of metadata.initialLiveObservations ?? []) this.enqueueLive(observation);
		this.observations = {
			next: () => this.#next(),
			return: async () => {
				await this.close();
				return { done: true, value: undefined };
			},
		};
	}

	enqueueLive(observation: SessionAuthorityObservation): void {
		if (this.closed) return;
		this.#nextSequence++;
		if (this.#overflow) {
			this.#overflow.latestSequence = this.#nextSequence;
			return;
		}
		const queued =
			this.#replayQueue.length - this.#replayIndex + this.#liveQueue.length - this.#liveIndex + this.pendingCount;
		if (queued >= this.#host.maxBufferedObservations) {
			this.#overflow = {
				type: "gap",
				sessionId: this.#host.sessionId,
				epoch: this.#transportEpoch,
				afterSequence: this.#acknowledged,
				firstAvailableSequence: Math.max(1, this.#nextSequence - this.#host.maxBufferedObservations + 1),
				latestSequence: this.#nextSequence,
				recovery: "resnapshot",
			};
			this.#host.subscriptionAcknowledged();
			return;
		}
		this.#liveQueue.push(
			createSessionObservationEnvelope(
				observation,
				this.#host.sessionId,
				this.#transportEpoch,
				this.#nextSequence,
				false,
			),
		);
		this.#host.subscriptionAcknowledged();
	}

	signalReplayOverflow(): void {
		if (this.closed || this.#overflow) return;
		this.#nextSequence++;
		this.#overflow = {
			type: "gap",
			sessionId: this.#host.sessionId,
			epoch: this.#transportEpoch,
			afterSequence: this.#acknowledged,
			firstAvailableSequence: Math.max(1, this.#nextSequence - this.#host.maxBufferedObservations + 1),
			latestSequence: this.#nextSequence,
			recovery: "resnapshot",
		};
		this.#host.subscriptionAcknowledged();
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
		this.#resolveReplayBarrier();
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
		if (!this.isDurable) {
			const observation = await this.#host.nextAfter(this, this.#cursor);
			if (!observation) {
				await this.close();
				return { done: true, value: undefined };
			}
			if (observation.type === "gap") {
				await this.close();
				return { done: false, value: observation };
			}
			this.#cursor = observation.sequence;
			return { done: false, value: observation };
		}
		while (!this.closed) {
			if (this.#replayIndex < this.#replayQueue.length) {
				const observation = this.#replayQueue[this.#replayIndex++];
				this.#cursor = observation.sequence;
				if (this.#replayIndex === this.#replayQueue.length) this.#resolveReplayBarrier();
				return { done: false, value: observation };
			}
			if (this.#overflow) {
				const overflow = this.#overflow;
				this.#overflow = undefined;
				await this.close();
				return { done: false, value: overflow };
			}
			if (this.#liveIndex < this.#liveQueue.length) {
				const observation = this.#liveQueue[this.#liveIndex++];
				this.#cursor = observation.sequence;
				if (this.#liveIndex === this.#liveQueue.length) {
					this.#liveQueue = [];
					this.#liveIndex = 0;
				}
				return { done: false, value: observation };
			}
			if (this.#host.closed) {
				await this.close();
				return { done: true, value: undefined };
			}
			await this.#host.waitForObservation(this);
		}
		return { done: true, value: undefined };
	}
}
