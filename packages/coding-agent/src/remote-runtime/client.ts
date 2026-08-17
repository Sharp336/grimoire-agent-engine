import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { REMOTE_RUNTIME_PROTOCOL_VERSION, type RemoteRuntimeConfig } from "./config";

export const REMOTE_RUNTIME_MAX_FRAME_BYTES = 1_048_576;
export const REMOTE_RUNTIME_REQUIRED_CAPABILITIES = Object.freeze([
	"structured-subagent",
	"running-child-registration",
	"registry",
	"peer-transport",
	"observations",
]);
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_OPERATION_LENGTH = 96;
const MAX_TRACKED_SETTLED_REQUESTS = 1_024;
const MAX_TRACKED_ABANDONED_REQUESTS = 1_024;
const MAX_TRACKED_CANCEL_REQUESTS = 1_024;
const MAX_OBSERVATION_STREAMS = 1_024;
const MAX_REQUEST_TIMEOUT_MS = 2_147_000_000;
const BOOTSTRAP_RESULT_KEYS: Record<string, true> = {
	version: true,
	capabilities: true,
	maxFrameBytes: true,
};
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const STREAM_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATION_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const REQUEST_ENVELOPE_KEYS: Record<string, true> = {
	protocol: true,
	kind: true,
	requestId: true,
	idempotencyKey: true,
	context: true,
	operation: true,
	payload: true,
};
const RESULT_ENVELOPE_KEYS: Record<string, true> = {
	protocol: true,
	kind: true,
	requestId: true,
	result: true,
};
const ERROR_ENVELOPE_KEYS: Record<string, true> = {
	protocol: true,
	kind: true,
	requestId: true,
	error: true,
};
const REMOTE_ERROR_KEYS: Record<string, true> = { code: true, message: true, retryable: true };
const CANCEL_ENVELOPE_KEYS: Record<string, true> = {
	protocol: true,
	kind: true,
	requestId: true,
	idempotencyKey: true,
	context: true,
	targetRequestId: true,
	reason: true,
};
const CANCEL_ACK_KEYS: Record<string, true> = { cancelled: true };
const OBSERVATION_ENVELOPE_KEYS: Record<string, true> = {
	protocol: true,
	kind: true,
	stream: true,
	cursor: true,
	observation: true,
};

export interface RemoteRuntimeRequestContext {
	readonly controllerId: string;
	readonly executionId: string;
	readonly revision: string;
	readonly grantId: string;
	readonly policyDigest: string;
	readonly parentExecutionId: string | null;
	readonly rootExecutionId: string;
	readonly depth: number;
	readonly assignmentId: string;
	readonly budgetRef: string;
	readonly schemaRef: string;
}

export interface RemoteRuntimeRequestEnvelope {
	readonly protocol: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly kind: "request";
	readonly requestId: string;
	readonly idempotencyKey: string;
	readonly context: RemoteRuntimeRequestContext;
	readonly operation: string;
	readonly payload: unknown;
}

export interface RemoteRuntimeCancelEnvelope {
	readonly protocol: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly kind: "cancel";
	readonly requestId: string;
	readonly idempotencyKey: string;
	readonly context: RemoteRuntimeRequestContext;
	readonly targetRequestId: string;
	readonly reason: "aborted" | "timeout";
}

export interface RemoteRuntimeResultEnvelope {
	readonly protocol: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly kind: "result";
	readonly requestId: string;
	readonly result: unknown;
}

export interface RemoteRuntimeError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface RemoteRuntimeErrorEnvelope {
	readonly protocol: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly kind: "error";
	readonly requestId: string;
	readonly error: RemoteRuntimeError;
}

export interface RemoteRuntimeObservationEnvelope {
	readonly protocol: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly kind: "observation";
	readonly stream: string;
	readonly cursor: number;
	readonly observation: unknown;
}

export interface RemoteRuntimeRequestOptions {
	readonly signal?: AbortSignal;
	readonly idempotencyKey?: string;
	readonly timeoutMs?: number | null;
}

interface PendingRequest {
	readonly operation: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timeout?: NodeJS.Timeout;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
	written: boolean;
}

type ObservationListener = (envelope: RemoteRuntimeObservationEnvelope) => void;

interface SocketIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
	readonly mode: number;
}

/** Stable, deliberately detail-free error safe for user-visible propagation and logs. */
export class RemoteRuntimeProtocolError extends Error {
	readonly code: string;
	readonly operation?: string;

	constructor(code: string, message: string, operation?: string) {
		super(message);
		this.name = "RemoteRuntimeProtocolError";
		this.code = code;
		this.operation = operation;
	}
}

function assertExactKeys(value: Record<string, unknown>, expected: Record<string, true>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(expected, key))
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", `${label} has unknown fields.`);
	}
	for (const key of Object.keys(expected)) {
		if (!Object.hasOwn(value, key))
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", `${label} is incomplete.`);
	}
}

function boundedOperation(operation: string): void {
	if (operation.length > MAX_OPERATION_LENGTH || !OPERATION_RE.test(operation)) {
		throw new RemoteRuntimeProtocolError("INVALID_OPERATION", "Remote runtime operation is malformed.");
	}
}

/** One persistent, multiplexed NDJSON connection to the sealed control plane. */
export class RemoteRuntimeClient {
	readonly #config: RemoteRuntimeConfig;
	readonly #context: RemoteRuntimeRequestContext;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #settledRequestIds = new Set<string>();
	readonly #abandonedRequestIds = new Set<string>();
	readonly #cancelRequestIds = new Set<string>();
	readonly #observationCursors = new Map<string, number>();
	readonly #observationListeners = new Map<string, Set<ObservationListener>>();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#connectResolve: (() => void) | undefined;
	#connectReject: ((error: Error) => void) | undefined;
	#socketVerified = false;
	#buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	#closed = false;

	constructor(config: RemoteRuntimeConfig) {
		this.#config = config;
		this.#context = Object.freeze({
			controllerId: config.controllerId,
			executionId: config.executionId,
			revision: config.revision,
			grantId: config.grantId,
			policyDigest: config.policyDigest,
			parentExecutionId: config.parentExecutionId,
			rootExecutionId: config.rootExecutionId,
			depth: config.depth,
			assignmentId: config.assignmentId,
			budgetRef: config.budgetRef,
			schemaRef: config.schemaRef,
		});
	}

	/** Establish the socket and require an explicit version/capability acknowledgement before callers can run. */
	async start(signal?: AbortSignal): Promise<void> {
		const result = await this.request(
			"runtime.bootstrap",
			{
				version: REMOTE_RUNTIME_PROTOCOL_VERSION,
				capabilities: REMOTE_RUNTIME_REQUIRED_CAPABILITIES,
				maxFrameBytes: REMOTE_RUNTIME_MAX_FRAME_BYTES,
			},
			{ signal, idempotencyKey: `${this.#config.executionId}:bootstrap` },
		);
		try {
			if (typeof result !== "object" || result === null || Array.isArray(result)) {
				throw new RemoteRuntimeProtocolError("VERSION_MISMATCH", "Remote runtime bootstrap was rejected.");
			}
			const response = result as Record<string, unknown>;
			assertExactKeys(response, BOOTSTRAP_RESULT_KEYS, "Remote runtime bootstrap result");
			if (response.version !== REMOTE_RUNTIME_PROTOCOL_VERSION) {
				throw new RemoteRuntimeProtocolError("VERSION_MISMATCH", "Remote runtime protocol version mismatch.");
			}
			if (
				!Array.isArray(response.capabilities) ||
				response.capabilities.length !== REMOTE_RUNTIME_REQUIRED_CAPABILITIES.length ||
				new Set(response.capabilities).size !== REMOTE_RUNTIME_REQUIRED_CAPABILITIES.length ||
				response.capabilities.some(
					capability =>
						typeof capability !== "string" || !REMOTE_RUNTIME_REQUIRED_CAPABILITIES.includes(capability),
				)
			) {
				throw new RemoteRuntimeProtocolError(
					"CAPABILITY_MISMATCH",
					"Remote runtime capability acknowledgement mismatch.",
				);
			}
			if (response.maxFrameBytes !== REMOTE_RUNTIME_MAX_FRAME_BYTES) {
				throw new RemoteRuntimeProtocolError(
					"FRAME_LIMIT_MISMATCH",
					"Remote runtime frame limit acknowledgement mismatch.",
				);
			}
		} catch (error) {
			const failure =
				error instanceof RemoteRuntimeProtocolError
					? error
					: new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime bootstrap was rejected.");
			this.#terminalFailure(failure);
			throw failure;
		}
	}

	onObservation(stream: string, listener: ObservationListener): () => void {
		if (!STREAM_RE.test(stream)) {
			throw new RemoteRuntimeProtocolError("INVALID_STREAM", "Remote runtime observation stream is malformed.");
		}
		let listeners = this.#observationListeners.get(stream);
		if (!listeners) {
			if (this.#observationListeners.size >= MAX_OBSERVATION_STREAMS) {
				throw new RemoteRuntimeProtocolError("TOO_MANY_STREAMS", "Remote runtime observation limit exceeded.");
			}
			listeners = new Set();
			this.#observationListeners.set(stream, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) {
				this.#observationListeners.delete(stream);
				this.#observationCursors.delete(stream);
			}
		};
	}

	async request(operation: string, payload: unknown, options: RemoteRuntimeRequestOptions = {}): Promise<unknown> {
		boundedOperation(operation);
		if (this.#closed) throw new RemoteRuntimeProtocolError("CLOSED", "Remote runtime is unavailable.", operation);
		if (options.signal?.aborted) {
			throw new RemoteRuntimeProtocolError("ABORTED", "Remote runtime request was cancelled.", operation);
		}
		const requestId = randomUUID();
		const idempotencyKey = options.idempotencyKey ?? `${this.#config.executionId}:${requestId}`;
		if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
			throw new RemoteRuntimeProtocolError(
				"INVALID_IDEMPOTENCY_KEY",
				"Remote runtime idempotency key is malformed.",
			);
		}
		const timeoutMs = options.timeoutMs === undefined ? this.#config.requestTimeoutMs : options.timeoutMs;
		if (
			(timeoutMs === null && operation !== "subagent.run") ||
			(timeoutMs !== null &&
				(!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS))
		) {
			throw new RemoteRuntimeProtocolError("INVALID_TIMEOUT", "Remote runtime request timeout is malformed.");
		}
		const envelope: RemoteRuntimeRequestEnvelope = {
			protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
			kind: "request",
			requestId,
			idempotencyKey,
			context: this.#context,
			operation,
			payload,
		};
		const frame = this.#encodeFrame(envelope, operation);
		const deferred = Promise.withResolvers<unknown>();
		const timeout =
			timeoutMs === null
				? undefined
				: setTimeout(() => {
						this.#cancelPending(requestId, "timeout");
					}, timeoutMs);
		const onAbort = options.signal
			? () => {
					this.#cancelPending(requestId, "aborted");
				}
			: undefined;
		const pending: PendingRequest = {
			operation,
			resolve: deferred.resolve,
			reject: deferred.reject,
			timeout,
			signal: options.signal,
			onAbort,
			written: false,
		};
		this.#pending.set(requestId, pending);
		options.signal?.addEventListener("abort", onAbort as () => void, { once: true });
		try {
			await Promise.race([this.#ensureConnected(), deferred.promise]);
			if (!this.#pending.has(requestId)) return await deferred.promise;
			const socket = this.#socket;
			if (!socket || socket.destroyed)
				throw new RemoteRuntimeProtocolError("UNAVAILABLE", "Remote runtime is unavailable.");
			pending.written = true;
			socket.write(frame);
		} catch (error) {
			if (this.#pending.delete(requestId)) {
				this.#cleanupPending(pending);
				pending.reject(
					error instanceof RemoteRuntimeProtocolError
						? error
						: new RemoteRuntimeProtocolError("UNAVAILABLE", "Remote runtime is unavailable.", operation),
				);
			}
		}
		return deferred.promise;
	}

	/** Close the exact connection owned by this runtime and reject all still-pending operations. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.destroy();
		this.#failAll(new RemoteRuntimeProtocolError("CLOSED", "Remote runtime was closed."));
		this.#observationListeners.clear();
	}

	#encodeFrame(envelope: RemoteRuntimeRequestEnvelope | RemoteRuntimeCancelEnvelope, operation?: string): Buffer {
		let json: string;
		try {
			json = JSON.stringify(envelope);
		} catch {
			throw new RemoteRuntimeProtocolError(
				"UNSERIALIZABLE",
				"Remote runtime payload is not serializable.",
				operation,
			);
		}
		const frame = Buffer.from(`${json}\n`);
		if (frame.byteLength > REMOTE_RUNTIME_MAX_FRAME_BYTES) {
			throw new RemoteRuntimeProtocolError(
				"FRAME_TOO_LARGE",
				"Remote runtime payload exceeds the frame limit.",
				operation,
			);
		}
		return frame;
	}

	async #verifySocketPath(expected?: SocketIdentity): Promise<SocketIdentity> {
		try {
			const stat = await fs.lstat(this.#config.socketPath);
			const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
			if (
				effectiveUid === undefined ||
				stat.isSymbolicLink() ||
				!stat.isSocket() ||
				stat.uid !== effectiveUid ||
				(stat.mode & 0o077) !== 0
			) {
				throw new Error("untrusted");
			}
			const identity: SocketIdentity = {
				dev: stat.dev,
				ino: stat.ino,
				uid: stat.uid,
				mode: stat.mode,
			};
			if (
				expected &&
				(identity.dev !== expected.dev ||
					identity.ino !== expected.ino ||
					identity.uid !== expected.uid ||
					identity.mode !== expected.mode)
			) {
				throw new Error("changed");
			}
			let directory = await fs.realpath(path.dirname(this.#config.socketPath));
			while (true) {
				const directoryStat = await fs.lstat(directory);
				if (
					directoryStat.isSymbolicLink() ||
					!directoryStat.isDirectory() ||
					(directoryStat.uid !== effectiveUid && directoryStat.uid !== 0) ||
					((directoryStat.mode & 0o022) !== 0 && (directoryStat.mode & 0o1000) === 0)
				) {
					throw new Error("writable");
				}
				const parent = path.dirname(directory);
				if (parent === directory) break;
				directory = parent;
			}
			return identity;
		} catch {
			throw new RemoteRuntimeProtocolError(
				"UNTRUSTED_SOCKET",
				"Remote runtime socket failed local authority verification.",
			);
		}
	}

	async #openVerifiedSocket(): Promise<void> {
		try {
			const identity = await this.#verifySocketPath();
			if (this.#closed) throw new RemoteRuntimeProtocolError("CLOSED", "Remote runtime is unavailable.");
			const socket = net.createConnection({ path: this.#config.socketPath });
			this.#socketVerified = false;
			this.#socket = socket;
			socket.once("connect", () => {
				void this.#verifySocketPath(identity).then(
					() => {
						if (this.#closed || this.#socket !== socket || socket.destroyed) return;
						this.#socketVerified = true;
						this.#connectResolve?.();
						this.#connectResolve = undefined;
						this.#connectReject = undefined;
					},
					error => {
						this.#terminalFailure(
							error instanceof RemoteRuntimeProtocolError
								? error
								: new RemoteRuntimeProtocolError(
										"UNTRUSTED_SOCKET",
										"Remote runtime socket failed local authority verification.",
									),
						);
					},
				);
			});
			socket.on("data", data => {
				if (!this.#socketVerified) {
					this.#terminalFailure(
						new RemoteRuntimeProtocolError(
							"UNTRUSTED_SOCKET",
							"Remote runtime sent data before local authority verification completed.",
						),
					);
					return;
				}
				this.#onData(typeof data === "string" ? Buffer.from(data) : data);
			});
			socket.on("end", () => {
				if (!this.#closed && this.#buffer.length > 0) {
					this.#terminalFailure(
						new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime ended with an incomplete frame."),
					);
				}
			});
			socket.on("error", () => {
				this.#terminalFailure(new RemoteRuntimeProtocolError("UNAVAILABLE", "Remote runtime is unavailable."));
			});
			socket.on("close", () => {
				if (!this.#closed)
					this.#terminalFailure(new RemoteRuntimeProtocolError("UNAVAILABLE", "Remote runtime disconnected."));
			});
		} catch (error) {
			this.#terminalFailure(
				error instanceof RemoteRuntimeProtocolError
					? error
					: new RemoteRuntimeProtocolError("UNAVAILABLE", "Remote runtime is unavailable."),
			);
		}
	}

	#ensureConnected(): Promise<void> {
		if (this.#closed)
			return Promise.reject(new RemoteRuntimeProtocolError("CLOSED", "Remote runtime is unavailable."));
		if (this.#socketVerified && this.#socket && !this.#socket.destroyed && this.#socket.readyState === "open") {
			return Promise.resolve();
		}
		if (this.#connectPromise) return this.#connectPromise;
		const deferred = Promise.withResolvers<void>();
		this.#connectPromise = deferred.promise;
		this.#connectResolve = deferred.resolve;
		this.#connectReject = deferred.reject;
		void this.#openVerifiedSocket();
		return deferred.promise;
	}

	#onData(data: Buffer): void {
		if (this.#closed) return;
		this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
		while (true) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline === -1) {
				if (this.#buffer.byteLength > REMOTE_RUNTIME_MAX_FRAME_BYTES) {
					this.#terminalFailure(
						new RemoteRuntimeProtocolError("FRAME_TOO_LARGE", "Remote runtime frame exceeds the limit."),
					);
				}
				return;
			}
			if (newline + 1 > REMOTE_RUNTIME_MAX_FRAME_BYTES) {
				this.#terminalFailure(
					new RemoteRuntimeProtocolError("FRAME_TOO_LARGE", "Remote runtime frame exceeds the limit."),
				);
				return;
			}
			const line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			if (line.byteLength === 0 || line.at(-1) === 0x0d) {
				this.#terminalFailure(
					new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime frame is malformed."),
				);
				return;
			}
			try {
				this.#handleLine(UTF8_DECODER.decode(line));
			} catch (error) {
				this.#terminalFailure(
					error instanceof RemoteRuntimeProtocolError
						? error
						: new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime frame is malformed."),
				);
				return;
			}
		}
	}

	#handleLine(line: string): void {
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime frame is malformed.");
		}
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime frame is malformed.");
		}
		const envelope = decoded as Record<string, unknown>;
		if (envelope.protocol !== REMOTE_RUNTIME_PROTOCOL_VERSION) {
			throw new RemoteRuntimeProtocolError("VERSION_MISMATCH", "Remote runtime protocol version mismatch.");
		}
		if (envelope.kind === "result") {
			assertExactKeys(envelope, RESULT_ENVELOPE_KEYS, "Remote runtime result envelope");
			this.#settleResult(envelope.requestId, envelope.result);
			return;
		}
		if (envelope.kind === "error") {
			assertExactKeys(envelope, ERROR_ENVELOPE_KEYS, "Remote runtime error envelope");
			this.#settleError(envelope.requestId, envelope.error);
			return;
		}
		if (envelope.kind === "observation") {
			assertExactKeys(envelope, OBSERVATION_ENVELOPE_KEYS, "Remote runtime observation envelope");
			this.#deliverObservation(envelope);
			return;
		}
		throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime frame kind is unsupported.");
	}

	#settleResult(requestIdValue: unknown, result: unknown): void {
		const requestId = this.#validatedResponseRequestId(requestIdValue);
		if (this.#cancelRequestIds.delete(requestId)) {
			if (typeof result !== "object" || result === null || Array.isArray(result)) {
				throw new RemoteRuntimeProtocolError(
					"MALFORMED_FRAME",
					"Remote runtime cancel acknowledgement is malformed.",
				);
			}
			const acknowledgement = result as Record<string, unknown>;
			assertExactKeys(acknowledgement, CANCEL_ACK_KEYS, "Remote runtime cancel acknowledgement");
			if (acknowledgement.cancelled !== true) {
				throw new RemoteRuntimeProtocolError(
					"MALFORMED_FRAME",
					"Remote runtime cancel acknowledgement is malformed.",
				);
			}
			return;
		}
		const pending = this.#pending.get(requestId);
		if (!pending) {
			if (this.#abandonedRequestIds.delete(requestId)) return;
			if (this.#settledRequestIds.has(requestId)) {
				throw new RemoteRuntimeProtocolError(
					"DUPLICATE_TERMINAL",
					"Remote runtime sent duplicate terminal frames.",
				);
			}
			throw new RemoteRuntimeProtocolError("UNKNOWN_REQUEST", "Remote runtime responded to an unknown request.");
		}
		this.#pending.delete(requestId);
		this.#rememberSettled(requestId);
		this.#cleanupPending(pending);
		pending.resolve(result);
	}

	#settleError(requestIdValue: unknown, errorValue: unknown): void {
		const requestId = this.#validatedResponseRequestId(requestIdValue);
		const cancelAcknowledgement = this.#cancelRequestIds.has(requestId);
		if (typeof errorValue !== "object" || errorValue === null || Array.isArray(errorValue)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime error envelope is malformed.");
		}
		const remoteError = errorValue as Record<string, unknown>;
		assertExactKeys(remoteError, REMOTE_ERROR_KEYS, "Remote runtime error");
		if (
			typeof remoteError.code !== "string" ||
			remoteError.code.length > MAX_ERROR_CODE_LENGTH ||
			!ERROR_CODE_RE.test(remoteError.code) ||
			typeof remoteError.message !== "string" ||
			Buffer.byteLength(remoteError.message) > 4_096 ||
			typeof remoteError.retryable !== "boolean"
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime error envelope is malformed.");
		}
		if (cancelAcknowledgement) {
			this.#cancelRequestIds.delete(requestId);
			return;
		}
		const pending = this.#pending.get(requestId);
		if (!pending) {
			if (this.#abandonedRequestIds.delete(requestId)) return;
			if (this.#settledRequestIds.has(requestId)) {
				throw new RemoteRuntimeProtocolError(
					"DUPLICATE_TERMINAL",
					"Remote runtime sent duplicate terminal frames.",
				);
			}
			throw new RemoteRuntimeProtocolError("UNKNOWN_REQUEST", "Remote runtime responded to an unknown request.");
		}
		this.#pending.delete(requestId);
		this.#rememberSettled(requestId);
		this.#cleanupPending(pending);
		pending.reject(
			new RemoteRuntimeProtocolError(
				remoteError.code,
				`Remote runtime ${pending.operation} failed (${remoteError.code}).`,
				pending.operation,
			),
		);
	}

	#deliverObservation(envelope: Record<string, unknown>): void {
		if (
			typeof envelope.stream !== "string" ||
			!STREAM_RE.test(envelope.stream) ||
			!Number.isSafeInteger(envelope.cursor) ||
			(envelope.cursor as number) <= 0
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime observation envelope is malformed.");
		}
		const listeners = this.#observationListeners.get(envelope.stream);
		if (!listeners || listeners.size === 0) return;
		const prior = this.#observationCursors.get(envelope.stream) ?? 0;
		if (envelope.cursor !== prior + 1) {
			throw new RemoteRuntimeProtocolError(
				"OBSERVATION_ORDER",
				"Remote runtime observation cursor is not contiguous.",
			);
		}
		this.#observationCursors.set(envelope.stream, envelope.cursor as number);
		const observation: RemoteRuntimeObservationEnvelope = {
			protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
			kind: "observation",
			stream: envelope.stream,
			cursor: envelope.cursor as number,
			observation: envelope.observation,
		};
		for (const listener of listeners) {
			try {
				listener(observation);
			} catch {
				// A launch-local consumer failure must not terminate unrelated multiplexed requests.
			}
		}
	}

	#validatedResponseRequestId(value: unknown): string {
		if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_FRAME", "Remote runtime response requestId is malformed.");
		}
		return value;
	}

	#cancelPending(requestId: string, reason: "aborted" | "timeout"): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		this.#cleanupPending(pending);
		this.#rememberSettled(requestId);
		this.#rememberAbandoned(requestId);
		if (pending.written && this.#socket && !this.#socket.destroyed) {
			const cancelRequestId = randomUUID();
			this.#rememberCancel(cancelRequestId);
			const cancel: RemoteRuntimeCancelEnvelope = {
				protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
				kind: "cancel",
				requestId: cancelRequestId,
				idempotencyKey: `${this.#config.executionId}:${cancelRequestId}`,
				context: this.#context,
				targetRequestId: requestId,
				reason,
			};
			try {
				this.#socket.write(this.#encodeFrame(cancel));
			} catch {
				// The original request still fails closed; cancellation is best effort after disconnect.
			}
		}
		pending.reject(
			new RemoteRuntimeProtocolError(
				reason === "timeout" ? "TIMEOUT" : "ABORTED",
				reason === "timeout" ? "Remote runtime request timed out." : "Remote runtime request was cancelled.",
				pending.operation,
			),
		);
	}

	#cleanupPending(pending: PendingRequest): void {
		clearTimeout(pending.timeout);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#rememberSettled(requestId: string): void {
		this.#settledRequestIds.add(requestId);
		if (this.#settledRequestIds.size <= MAX_TRACKED_SETTLED_REQUESTS) return;
		const oldest = this.#settledRequestIds.values().next().value;
		if (typeof oldest === "string") this.#settledRequestIds.delete(oldest);
	}

	#rememberAbandoned(requestId: string): void {
		this.#abandonedRequestIds.delete(requestId);
		this.#abandonedRequestIds.add(requestId);
		if (this.#abandonedRequestIds.size <= MAX_TRACKED_ABANDONED_REQUESTS) return;
		const oldest = this.#abandonedRequestIds.values().next().value;
		if (typeof oldest === "string") this.#abandonedRequestIds.delete(oldest);
	}

	#rememberCancel(requestId: string): void {
		this.#cancelRequestIds.add(requestId);
		if (this.#cancelRequestIds.size <= MAX_TRACKED_CANCEL_REQUESTS) return;
		const oldest = this.#cancelRequestIds.values().next().value;
		if (typeof oldest === "string") this.#cancelRequestIds.delete(oldest);
	}

	#terminalFailure(error: RemoteRuntimeProtocolError): void {
		this.#connectReject?.(error);
		this.#connectResolve = undefined;
		this.#connectReject = undefined;
		this.#socketVerified = false;
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
		this.#failAll(error);
	}

	#failAll(error: RemoteRuntimeProtocolError): void {
		for (const [requestId, pending] of this.#pending) {
			this.#pending.delete(requestId);
			this.#rememberSettled(requestId);
			this.#cleanupPending(pending);
			pending.reject(error);
		}
	}
}

// These constants are exported only for exact-frame contract tests and controller implementations.
export const REMOTE_RUNTIME_FRAME_KEYS = Object.freeze({
	request: REQUEST_ENVELOPE_KEYS,
	cancel: CANCEL_ENVELOPE_KEYS,
	result: RESULT_ENVELOPE_KEYS,
	error: ERROR_ENVELOPE_KEYS,
	observation: OBSERVATION_ENVELOPE_KEYS,
});
