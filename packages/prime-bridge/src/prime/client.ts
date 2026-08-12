import { randomUUID } from "node:crypto";
import {
	PRIME_DAEMON_PROTOCOL_NAME,
	PRIME_DAEMON_PROTOCOL_VERSION,
	type PrimeDaemonCursor,
	type PrimeDaemonEvent,
	type PrimeDaemonEventEnvelope,
	type PrimeDaemonHello,
	type PrimeDaemonResponse,
	parsePrimeDaemonHello,
	parsePrimeDaemonOutbound,
} from "@oh-my-pi/prime-bridge-protocol";
import type { BridgeStore } from "../store";
import { type AssembledSnapshot, SnapshotAssembler, snapshotIdentity } from "./snapshot-assembler";
import { defaultPrimeDaemonSocketPath } from "./socket-path";

type JsonObject = Record<string, unknown>;
type EventListener = (event: PrimeDaemonEventEnvelope) => void | Promise<void>;
type PendingResolver = (value: unknown) => void;
type PendingRejecter = (error: Error) => void;
interface PendingCommand {
	id: string;
	commandType: string;
	mutation: boolean;
	resolve?: PendingResolver;
	reject?: PendingRejecter;
	timer?: Timer;
	attachSessionId?: string;
	detachSessionId?: string;
	snapshotId?: string;
	attachData?: JsonObject;
	awaitSnapshot?: boolean;
	ackFor?: string;
	promise?: Promise<unknown>;
	deadline?: number;
	settled?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_RECONNECT_DEADLINE_MS = 60_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class CommandResultUncertainError extends Error {
	readonly commandId: string;

	constructor(commandId: string, message = "Prime daemon command result is uncertain") {
		super(`${message}: ${commandId}`);
		this.name = "CommandResultUncertainError";
		this.commandId = commandId;
	}
}

export interface PrimeDaemonClientOptions {
	store: BridgeStore;
	socketPath?: string;
	clientCapabilities?: readonly string[];
	reconnectTimeoutMs?: number;
	requestTimeoutMs?: number;
	reconnectDeadlineMs?: number;
}

export class PrimeDaemonClient {
	readonly store: BridgeStore;
	readonly socketPath: string;
	readonly reconnectTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly reconnectDeadlineMs: number;
	#configuredCapabilities: readonly string[];
	#capabilities: string[] = [];
	#socket: Bun.Socket<undefined> | undefined;
	#connectPromise: Promise<void> | undefined;
	#helloPromise: Promise<PrimeDaemonHello> | undefined;
	#helloResolve: ((hello: PrimeDaemonHello) => void) | undefined;
	#helloReject: ((error: Error) => void) | undefined;
	#daemonHello: PrimeDaemonHello | undefined;
	#inputBytes = Buffer.alloc(0);
	#closed = false;
	#listeners = new Set<EventListener>();
	#pending = new Map<string, PendingCommand>();
	#helloReceived = false;
	#snapshot = new SnapshotAssembler();
	#eventChain: Promise<void> = Promise.resolve();
	#notificationChain: Promise<void> = Promise.resolve();
	#reconnectTimer: Timer | undefined;
	#transportGeneration = 0;
	#attachedSessions = new Set<string>();
	#ignoredSnapshots = new Set<string>();
	#recovering = false;
	#ignoredSnapshotSessions = new Set<string>();
	#recoverySleepTimer: Timer | undefined;
	constructor(options: PrimeDaemonClientOptions) {
		this.store = options.store;
		this.socketPath = defaultPrimeDaemonSocketPath(options.socketPath);
		this.#configuredCapabilities = [
			...(options.clientCapabilities ?? ["attach_snapshot", "event_sequence", "chunked_snapshot"]),
		].filter(
			(capability, index, capabilities) =>
				capability !== "extension_ui" &&
				capability !== "supportsExtensionUi" &&
				capabilities.indexOf(capability) === index,
		);
		this.reconnectTimeoutMs = options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.reconnectDeadlineMs = options.reconnectDeadlineMs ?? DEFAULT_RECONNECT_DEADLINE_MS;
		if (!Number.isSafeInteger(this.reconnectTimeoutMs) || this.reconnectTimeoutMs < 1)
			throw new RangeError("reconnectTimeoutMs must be positive");
		if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1)
			throw new RangeError("requestTimeoutMs must be positive");
		if (!Number.isSafeInteger(this.reconnectDeadlineMs) || this.reconnectDeadlineMs < this.reconnectTimeoutMs)
			throw new RangeError("reconnectDeadlineMs must cover reconnectTimeoutMs");
	}

	get daemonHello(): PrimeDaemonHello | undefined {
		return this.#daemonHello === undefined ? undefined : structuredClone(this.#daemonHello);
	}

	get capabilities(): readonly string[] {
		return this.#capabilities;
	}

	get connected(): boolean {
		return this.#socket?.readyState === 1 && this.#helloPromise === undefined;
	}

	async connect(): Promise<void> {
		return this.#connect();
	}

	async #connect(deadline?: number): Promise<void> {
		if (this.#closed) throw new Error("Prime daemon client is closed");
		if (this.#socket?.readyState === 1 && this.#helloPromise === undefined) return;
		if (this.#connectPromise) {
			if (deadline === undefined) return this.#connectPromise;
			try {
				return await this.#awaitWithin(this.#connectPromise, deadline, "Prime daemon reconnect deadline exceeded");
			} catch (error) {
				if (Date.now() >= deadline) {
					this.#transportGeneration += 1;
					this.#socket?.terminate();
				}
				throw error;
			}
		}
		const promise = this.#openConnection(deadline);
		this.#connectPromise = promise;
		try {
			await promise;
		} finally {
			if (this.#connectPromise === promise) this.#connectPromise = undefined;
		}
	}

	async listSessions(options: JsonObject = {}): Promise<unknown> {
		return this.#command("list", options);
	}

	async createSession(options: JsonObject = {}): Promise<unknown> {
		return this.#command("create", options, true);
	}

	async attach(activeSessionId: string): Promise<JsonObject> {
		await this.connect();
		this.#ignoredSnapshotSessions.delete(activeSessionId);
		const cursor = this.store.getCursor(activeSessionId);
		const data = await this.#command(
			"attach",
			{
				activeSessionId,
				clientId: this.store.getOrCreateClientId(),
				capabilities: this.#capabilities,
				...(cursor ? { resumeCursor: cursor } : {}),
			},
			false,
			activeSessionId,
		);
		return this.#object(data, "attach response");
	}

	async prompt(activeSessionId: string, message: string, options: JsonObject = {}): Promise<unknown> {
		return this.#command("prompt", { ...options, activeSessionId, message }, true);
	}

	async sendMessage(
		targetActiveSessionId: string,
		message: string,
		deliveryMode?: "auto" | "steer" | "follow_up",
		bridgeMessageId?: string,
	): Promise<unknown> {
		if (bridgeMessageId !== undefined && bridgeMessageId.length === 0)
			throw new Error("bridgeMessageId must not be empty");
		const command: JsonObject = { type: "send_message", targetActiveSessionId, message };
		if (deliveryMode !== undefined) command.deliveryMode = deliveryMode;
		return this.#command(
			"send_message",
			command,
			true,
			undefined,
			undefined,
			undefined,
			bridgeMessageId === undefined ? undefined : `bridge:${bridgeMessageId}`,
		);
	}

	async acknowledgeBridgeMessage(meshMessageId: string): Promise<void> {
		if (this.store.getLatestReceipt(meshMessageId) === null)
			throw new Error("bridge message receipt is required before ACK");
		if (!this.connected) await this.connect();
		const commandId = `bridge:${meshMessageId}`;
		if (!this.store.listPendingCommands().some(record => record.commandId === commandId)) return;
		this.#write(
			JSON.stringify({
				type: "command",
				id: randomUUID(),
				protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
				clientId: this.store.getOrCreateClientId(),
				command: { type: "ack_result", commandId },
			}),
		);
		this.store.completeCommand(commandId);
	}

	async detach(activeSessionId?: string): Promise<unknown> {
		return this.#command(
			"detach",
			activeSessionId === undefined ? {} : { activeSessionId },
			true,
			undefined,
			activeSessionId ?? "",
		);
	}

	subscribe(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		clearTimeout(this.#recoverySleepTimer);
		this.#recoverySleepTimer = undefined;
		if (this.#closed) return;
		this.#closed = true;
		this.#transportGeneration += 1;
		if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		const error = new Error("Prime daemon client closed");
		this.#helloReject?.(error);
		this.#helloResolve = undefined;
		this.#helloReject = undefined;
		this.#helloPromise = undefined;
		this.#daemonHello = undefined;
		for (const [id, pending] of this.#pending) {
			if (pending.timer !== undefined) clearTimeout(pending.timer);
			pending.timer = undefined;
			this.#pending.delete(id);
			if (pending.mutation) {
				this.#recordUncertainResponse(pending, error);
				pending.reject?.(new CommandResultUncertainError(id, error.message));
			} else pending.reject?.(error);
		}
		this.#listeners.clear();
		this.#snapshot.reset();
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.terminate();
	}

	async #openConnection(deadline?: number): Promise<void> {
		const generation = ++this.#transportGeneration;
		this.#daemonHello = undefined;
		this.#helloPromise = new Promise<PrimeDaemonHello>((resolve, reject) => {
			this.#helloResolve = resolve;
			this.#helloReject = reject;
		});
		this.#helloPromise.catch(() => undefined);
		let socket: Bun.Socket<undefined> | undefined;
		try {
			const connectPromise = Bun.connect<undefined>({
				unix: this.socketPath,
				socket: {
					open: opened => {
						if (this.#closed || generation !== this.#transportGeneration) {
							opened.terminate();
							return;
						}
						socket = opened;
						this.#socket = opened;
					},
					data: (incoming, data) => this.#consumeData(incoming, generation, Buffer.from(data)),
					error: (failed, error) => this.#onClosed(failed, generation, error),
					close: closed => this.#onClosed(closed, generation, new Error("Prime daemon socket closed")),
				},
			});
			void connectPromise.catch(() => undefined);
			if (deadline === undefined) {
				const timer = setTimeout(() => socket?.terminate(), this.requestTimeoutMs);
				try {
					this.#socket = await connectPromise;
				} finally {
					clearTimeout(timer);
				}
			} else {
				const connectDeadline = Math.min(deadline, Date.now() + this.requestTimeoutMs);
				this.#socket = await this.#awaitWithin(
					connectPromise,
					connectDeadline,
					connectDeadline === deadline
						? "Prime daemon reconnect deadline exceeded"
						: "Timed out connecting to Prime daemon",
				);
			}
			const helloPromise = this.#helloPromise;
			if (!helloPromise) throw new Error("Prime daemon hello waiter was lost");
			const hello =
				deadline === undefined
					? await new Promise<PrimeDaemonHello>((resolve, reject) => {
							const timeout = setTimeout(
								() => reject(new Error("Timed out waiting for Prime daemon hello")),
								this.requestTimeoutMs,
							);
							helloPromise.then(
								value => {
									clearTimeout(timeout);
									resolve(value);
								},
								error => {
									clearTimeout(timeout);
									reject(error);
								},
							);
						})
					: await this.#awaitWithin(
							helloPromise,
							Math.min(deadline, Date.now() + this.requestTimeoutMs),
							"Prime daemon reconnect deadline exceeded",
						);
			this.#capabilities = this.#configuredCapabilities.filter(capability =>
				hello.serverCapabilities.includes(capability),
			);
			this.#helloPromise = undefined;
			if (this.#closed || generation !== this.#transportGeneration) throw new Error("Prime daemon client closed");
			this.#helloReject = undefined;
			this.#assertBeforeDeadline(deadline);
			await this.#replayJournal(deadline);
			this.#assertBeforeDeadline(deadline);
			await this.#reattachSessions(deadline);
			this.#assertBeforeDeadline(deadline);
		} catch (error) {
			this.#onClosed(socket, generation, error instanceof Error ? error : new Error(String(error)));
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async #awaitWithin<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
		const remaining = deadline - Date.now();
		void promise.catch(() => undefined);
		if (remaining <= 0) throw new Error(message);
		let timer: Timer | undefined;
		const timeout = new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), remaining);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	#assertBeforeDeadline(deadline: number | undefined): void {
		if (deadline !== undefined && Date.now() >= deadline) throw new Error("Prime daemon reconnect deadline exceeded");
	}

	#consumeData(socket: Bun.Socket<undefined>, generation: number, bytes: Buffer): void {
		if (generation !== this.#transportGeneration || socket !== this.#socket) return;
		this.#inputBytes = Buffer.concat([this.#inputBytes, bytes]);
		if (this.#inputBytes.length > MAX_FRAME_BYTES) {
			this.#onClosed(socket, generation, new Error("Prime daemon JSONL frame buffer exceeded limit"));
			return;
		}
		while (this.#inputBytes.length > 0) {
			const source = this.#inputBytes;
			const parsed = Bun.JSONL.parseChunk(source);
			if (parsed.error) {
				this.#onClosed(socket, generation, parsed.error);
				return;
			}
			if (parsed.read === 0) return;
			const rawLines = source
				.subarray(0, parsed.read)
				.toString("utf8")
				.split("\n")
				.filter(line => line.length > 0)
				.map(line => (line.endsWith("\r") ? line.slice(0, -1) : line));
			this.#inputBytes = source.subarray(parsed.read);
			for (const [index, value] of parsed.values.entries()) {
				const rawJson = rawLines[index] ?? JSON.stringify(value);
				const task = () => this.#handleFrame(value, rawJson, generation);
				this.#eventChain = this.#eventChain
					.then(task)
					.catch(error =>
						this.#onClosed(socket, generation, error instanceof Error ? error : new Error(String(error))),
					);
			}
		}
	}

	async #handleFrame(value: unknown, rawJson: string, generation: number): Promise<void> {
		if (generation !== this.#transportGeneration) return;
		if (this.#helloPromise && !this.#helloReceived) {
			if (typeof value === "object" && value !== null && (value as JsonObject).type !== "daemon_hello")
				await this.#helloPromise;
			else {
				const hello = parsePrimeDaemonHello(value);
				if (
					hello.protocol.name !== PRIME_DAEMON_PROTOCOL_NAME ||
					typeof hello.protocol.version !== "number" ||
					!Number.isSafeInteger(hello.protocol.version) ||
					hello.protocol.version < PRIME_DAEMON_PROTOCOL_VERSION
				)
					throw new Error("Unsupported Prime daemon protocol");
				this.#helloReceived = true;
				this.#daemonHello = hello;
				this.#helloResolve?.(hello);
				return;
			}
		}
		const frame = parsePrimeDaemonOutbound(value);
		if (frame.type === "response" && "success" in frame) {
			await this.#handleResponse(frame as PrimeDaemonResponse, rawJson);
			return;
		}
		if (frame.type === "event" && "event" in frame && "emittedAt" in frame) {
			await this.#handleEvent(frame as PrimeDaemonEventEnvelope);
			return;
		}
		if (frame.type !== "daemon_hello") await this.#handleDirectEvent(frame as PrimeDaemonEvent);
	}

	async #handleDirectEvent(event: PrimeDaemonEvent): Promise<void> {
		const meta =
			typeof event.meta === "object" && event.meta !== null && !Array.isArray(event.meta)
				? (event.meta as JsonObject)
				: {};
		const envelope: PrimeDaemonEventEnvelope = {
			type: "event",
			...(typeof meta.id === "string" ? { id: meta.id } : {}),
			...(typeof meta.protocol === "object" && meta.protocol !== null && !Array.isArray(meta.protocol)
				? { protocol: meta.protocol }
				: {}),
			...(typeof meta.activeSessionId === "string"
				? { activeSessionId: meta.activeSessionId }
				: typeof event.activeSessionId === "string"
					? { activeSessionId: event.activeSessionId }
					: {}),
			...(typeof meta.sequence === "number" ? { sequence: meta.sequence } : {}),
			...(meta.cursor !== undefined ? { cursor: meta.cursor as PrimeDaemonCursor } : {}),
			...(typeof meta.emittedAt === "string" ? { emittedAt: meta.emittedAt } : {}),
			event: event as JsonObject,
		} as PrimeDaemonEventEnvelope;
		await this.#handleEvent(envelope);
	}

	#clearPendingTimer(pending: PendingCommand): void {
		if (pending.timer === undefined) return;
		clearTimeout(pending.timer);
		pending.timer = undefined;
	}

	async #handleResponse(response: PrimeDaemonResponse, rawJson: string): Promise<void> {
		if (response.id === undefined) return;
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		if (response.command !== pending.commandType) throw new Error(`Response command mismatch for ${response.id}`);
		this.#clearPendingTimer(pending);
		if (pending.ackFor !== undefined) {
			this.#pending.delete(pending.id);
			if (response.success) {
				this.store.completeCommand(pending.ackFor);
				pending.resolve?.(response.data);
			} else {
				pending.reject?.(new Error(response.error ?? "Prime daemon ACK failed"));
			}
			return;
		}
		if (pending.mutation) this.store.recordCommandResponse(pending.id, rawJson);
		const bridgeCommand = pending.id.startsWith("bridge:");
		if (!response.success) {
			const uncertain = this.#isUncertain(response);
			this.#pending.delete(pending.id);
			if (uncertain) pending.reject?.(new CommandResultUncertainError(pending.id));
			else pending.reject?.(new Error(response.error ?? "Prime daemon command failed"));
			if (pending.mutation && (!bridgeCommand || !uncertain)) await this.#ackAndComplete(pending);
			return;
		}
		if (pending.attachSessionId !== undefined) {
			pending.attachData = this.#object(response.data, "attach response");
			const stream = pending.attachData.snapshotStream;
			if (stream !== undefined) {
				const streamRecord = this.#object(stream, "snapshot stream");
				if (typeof streamRecord.id !== "string" || streamRecord.id.length === 0)
					throw new Error("snapshot stream id is required");
				pending.snapshotId = streamRecord.id;
			}
			if (pending.attachData.lastEventCursor !== undefined) {
				const cursor = this.#cursor(pending.attachData.lastEventCursor);
				if (
					pending.attachData.lastEventSequence !== undefined &&
					(typeof pending.attachData.lastEventSequence !== "number" ||
						pending.attachData.lastEventSequence !== cursor.sequence)
				)
					throw new Error("attach cursor does not match lastEventSequence");
				pending.attachData.lastEventCursor = cursor;
				this.store.setCursor(pending.attachSessionId, cursor);
			}
			pending.awaitSnapshot = this.#attachNeedsSnapshot(pending.attachData);
			if (pending.awaitSnapshot) {
				const timeoutMs =
					pending.deadline === undefined
						? this.requestTimeoutMs
						: Math.min(this.requestTimeoutMs, Math.max(1, pending.deadline - Date.now()));
				pending.timer = setTimeout(() => {
					if (pending.snapshotId)
						this.#ignoredSnapshots.add(snapshotIdentity(pending.attachSessionId as string, pending.snapshotId));
					else this.#ignoredSnapshotSessions.add(pending.attachSessionId as string);
					if (pending.snapshotId) this.#snapshot.reset(pending.attachSessionId as string, pending.snapshotId);
					else this.#snapshot.resetSession(pending.attachSessionId as string);
					this.#clearPendingTimer(pending);
					this.#pending.delete(pending.id);
					pending.reject?.(new Error("Prime daemon snapshot timed out"));
					if (pending.deadline !== undefined) this.#socket?.terminate();
				}, timeoutMs);
				this.#pending.set(pending.id, pending);
				return;
			}
			this.#attachedSessions.add(pending.attachSessionId);
		}
		if (pending.detachSessionId !== undefined) {
			if (pending.detachSessionId === "") this.#attachedSessions.clear();
			else this.#attachedSessions.delete(pending.detachSessionId);
		}
		if (pending.mutation) {
			this.#pending.delete(pending.id);
			pending.resolve?.(response.data);
			if (!bridgeCommand) await this.#ackAndComplete(pending);
			return;
		}
		this.#pending.delete(pending.id);
		pending.resolve?.(response.data);
	}
	async #handleEvent(event: PrimeDaemonEventEnvelope): Promise<void> {
		const payload = event.event;
		const activeSessionId =
			typeof event.activeSessionId === "string"
				? event.activeSessionId
				: typeof payload.activeSessionId === "string"
					? payload.activeSessionId
					: undefined;
		if (activeSessionId !== undefined && payload.type === "session_closed" && payload.reason !== "update")
			this.#attachedSessions.delete(activeSessionId);
		const cursor = this.#eventCursor(event);
		if (event.sequence !== undefined && cursor === undefined)
			throw new Error("event sequence requires a generation cursor");
		if (cursor && activeSessionId === undefined) throw new Error("event cursor requires active session");
		if (cursor && activeSessionId !== undefined) {
			const prior = this.store.getCursor(activeSessionId);
			if (prior?.generation === cursor.generation && cursor.sequence <= prior.sequence) return;
		}
		if (typeof payload.activeSessionId === "string" && typeof payload.snapshotId === "string") {
			if (this.#ignoredSnapshotSessions.has(payload.activeSessionId)) {
				if (payload.type === "session_snapshot_end" || payload.type === "session_snapshot_failed") {
					this.#ignoredSnapshotSessions.delete(payload.activeSessionId);
					this.#snapshot.reset(payload.activeSessionId, payload.snapshotId);
				}
				return;
			}
			const key = snapshotIdentity(payload.activeSessionId, payload.snapshotId);
			if (this.#ignoredSnapshots.has(key)) {
				if (payload.type === "session_snapshot_begin") this.#ignoredSnapshots.delete(key);
				else {
					if (payload.type === "session_snapshot_end" || payload.type === "session_snapshot_failed")
						this.#ignoredSnapshots.delete(key);
					return;
				}
			}
			if (payload.type === "session_snapshot_begin") {
				const pendingAttach = [...this.#pending.values()].find(
					item =>
						item.attachSessionId === payload.activeSessionId &&
						item.awaitSnapshot &&
						item.snapshotId === undefined,
				);
				if (pendingAttach) pendingAttach.snapshotId = payload.snapshotId;
			}
		}
		let assembled: AssembledSnapshot | undefined;
		try {
			assembled = this.#snapshot.add(payload);
		} catch (error) {
			if (typeof payload.activeSessionId === "string" && typeof payload.snapshotId === "string") {
				const pending = [...this.#pending.values()].find(
					item => item.attachSessionId === payload.activeSessionId && item.snapshotId === payload.snapshotId,
				);
				if (pending) this.#clearPendingTimer(pending);
				this.#pending.delete(pending?.id ?? "");
				pending?.reject?.(error instanceof Error ? error : new Error(String(error)));
				this.#ignoredSnapshots.add(snapshotIdentity(payload.activeSessionId, payload.snapshotId));
				this.#snapshot.reset(payload.activeSessionId, payload.snapshotId);
				return;
			}
			throw error;
		}
		this.#notificationChain = this.#notificationChain.then(async () => {
			for (const listener of this.#listeners) {
				try {
					await listener(event);
				} catch (error) {
					process.emitWarning(error instanceof Error ? error.message : String(error), {
						code: "PRIME_BRIDGE_LISTENER",
					});
				}
			}
		});
		if (cursor && activeSessionId !== undefined) this.store.setCursor(activeSessionId, cursor);
		else if (assembled?.lastEventCursor)
			this.store.setCursor(assembled.activeSessionId, this.#cursor(assembled.lastEventCursor));
		if (assembled) await this.#finishSnapshot(assembled);
	}

	async #finishSnapshot(snapshot: AssembledSnapshot): Promise<void> {
		const key = snapshotIdentity(snapshot.activeSessionId, snapshot.snapshotId);
		if (this.#ignoredSnapshots.delete(key)) return;
		const pending = [...this.#pending.values()].find(
			item =>
				item.attachSessionId === snapshot.activeSessionId &&
				item.snapshotId === snapshot.snapshotId &&
				item.awaitSnapshot,
		);
		if (!pending?.attachData) return;
		pending.attachData.snapshot = snapshot.snapshot;
		pending.attachData.lastEventSequence = snapshot.lastEventSequence;
		if (snapshot.lastEventCursor) pending.attachData.lastEventCursor = snapshot.lastEventCursor;
		this.#attachedSessions.add(snapshot.activeSessionId);
		try {
			await this.#ackAndComplete(pending);
		} catch (error) {
			this.#clearPendingTimer(pending);
			this.#pending.delete(pending.id);
			pending.reject?.(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
		this.#clearPendingTimer(pending);
		this.#pending.delete(pending.id);
		pending.resolve?.(pending.attachData);
	}

	async #command(
		commandType: string,
		fields: JsonObject,
		mutation = false,
		attachSessionId?: string,
		detachSessionId?: string,
		deadline?: number,
		commandId?: string,
	): Promise<unknown> {
		const id = commandId ?? randomUUID();
		if (commandId !== undefined) {
			const existing = this.store.listPendingCommands().find(record => record.commandId === commandId);
			if (existing && existing.responseJson !== null) return this.#storedResponse(existing.responseJson, commandId);
		}
		this.#assertBeforeDeadline(deadline);
		if (!this.connected) await this.#connect(deadline);
		this.#assertBeforeDeadline(deadline);
		if (commandId !== undefined) {
			const existing = this.store.listPendingCommands().find(record => record.commandId === commandId);
			if (existing && existing.responseJson !== null) return this.#storedResponse(existing.responseJson, commandId);
			const replayed = this.#pending.get(commandId);
			if (replayed?.promise) return replayed.promise;
			if (replayed) {
				const promise = new Promise<unknown>((resolve, reject) => {
					replayed.resolve = resolve;
					replayed.reject = reject;
				});
				replayed.promise = promise;
				return promise;
			}
		}
		const command: JsonObject = { ...fields, type: commandType };
		const envelope: JsonObject = {
			type: "command",
			id,
			protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
			clientId: this.store.getOrCreateClientId(),
			command,
		};
		const envelopeJson = JSON.stringify(envelope);
		if (mutation) this.store.persistCommand(id, envelopeJson);
		let pending!: PendingCommand;
		const promise = new Promise<unknown>((resolve, reject) => {
			pending = { id, commandType, mutation, resolve, reject, attachSessionId, detachSessionId, deadline };
			const timeoutMs =
				deadline === undefined
					? this.requestTimeoutMs
					: Math.min(this.requestTimeoutMs, Math.max(1, deadline - Date.now()));
			pending.timer = setTimeout(() => {
				this.#clearPendingTimer(pending);
				if (mutation) {
					pending.settled = true;
					const timeoutError = new Error("Prime daemon command timed out");
					this.#recordUncertainResponse(pending, timeoutError);
					reject(new CommandResultUncertainError(id, timeoutError.message));
					this.#socket?.terminate();
				} else {
					this.#pending.delete(id);
					reject(new Error("Prime daemon command timed out"));
					if (deadline !== undefined) this.#socket?.terminate();
				}
			}, timeoutMs);
			this.#pending.set(id, pending);
			try {
				this.#write(envelopeJson);
			} catch (error) {
				this.#clearPendingTimer(pending);
				this.#pending.delete(id);
				if (mutation) {
					pending.settled = true;
					const writeError = error instanceof Error ? error : new Error(String(error));
					this.#recordUncertainResponse(pending, writeError);
					pending.reject?.(new CommandResultUncertainError(id, writeError.message));
					this.#socket?.terminate();
				} else {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		pending.promise = promise;
		return promise;
	}

	async #replayJournal(deadline?: number): Promise<void> {
		for (const record of this.store.listPendingCommands()) {
			this.#assertBeforeDeadline(deadline);
			if (this.#pending.has(record.commandId)) continue;
			const envelope = JSON.parse(record.envelopeJson) as JsonObject;
			const command = this.#object(envelope.command, "stored command");
			const commandType = typeof command.type === "string" ? command.type : "unknown";
			const bridgeMessageId = record.commandId.startsWith("bridge:")
				? record.commandId.slice("bridge:".length)
				: undefined;
			const detachSessionId =
				commandType === "detach"
					? typeof command.activeSessionId === "string"
						? command.activeSessionId
						: ""
					: undefined;
			if (detachSessionId !== undefined) {
				if (detachSessionId === "") this.#attachedSessions.clear();
				else this.#attachedSessions.delete(detachSessionId);
			}
			if (record.responseJson !== null) {
				if (
					record.commandId.startsWith("bridge:") &&
					this.store.getLatestReceipt(bridgeMessageId as string) === null
				) {
					const stored = JSON.parse(record.responseJson) as PrimeDaemonResponse;
					if (stored.success || this.#isUncertain(stored)) continue;
				}
				this.#write(
					JSON.stringify({
						type: "command",
						id: randomUUID(),
						protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
						clientId: this.store.getOrCreateClientId(),
						command: { type: "ack_result", commandId: record.commandId },
					}),
				);
				this.store.completeCommand(record.commandId);
				continue;
			}
			const pending: PendingCommand = { id: record.commandId, commandType, mutation: true, detachSessionId };
			const timeoutMs =
				deadline === undefined
					? this.requestTimeoutMs
					: Math.min(this.requestTimeoutMs, Math.max(1, deadline - Date.now()));
			pending.timer = setTimeout(() => {
				this.#clearPendingTimer(pending);
				this.#pending.delete(record.commandId);
				const timeoutError = new Error("Prime daemon command replay timed out");
				this.#recordUncertainResponse(pending, timeoutError);
				this.#socket?.terminate();
			}, timeoutMs);
			this.#pending.set(record.commandId, pending);
			this.#write(record.envelopeJson);
		}
	}

	async #ackAndComplete(pending: PendingCommand): Promise<void> {
		if (!pending.mutation) return;
		this.#write(
			JSON.stringify({
				type: "command",
				id: randomUUID(),
				protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
				clientId: this.store.getOrCreateClientId(),
				command: { type: "ack_result", commandId: pending.id },
			}),
		);
		this.store.completeCommand(pending.id);
	}

	#write(json: string): void {
		if (this.#helloPromise || !this.#socket || this.#socket.readyState !== 1)
			throw new Error("Prime daemon is not connected or hello is incomplete");
		const frame = `${json}\n`;
		const expectedBytes = Buffer.byteLength(frame, "utf8");
		const writtenBytes = this.#socket.write(frame);
		if (writtenBytes !== expectedBytes) {
			this.#socket.terminate();
			throw new Error(
				writtenBytes < 0
					? "Prime daemon socket write failed"
					: `Prime daemon socket write was short: ${writtenBytes} of ${expectedBytes} bytes`,
			);
		}
	}

	#eventCursor(event: PrimeDaemonEventEnvelope): PrimeDaemonCursor | undefined {
		if (event.cursor !== undefined) return this.#cursor(event.cursor);
		const payload = event.event;
		const meta = payload.meta;
		if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
			const metaRecord = meta as JsonObject;
			if (metaRecord.sequence !== undefined && metaRecord.cursor === undefined)
				throw new Error("event sequence requires a generation cursor");
			if (metaRecord.cursor !== undefined) return this.#cursor(metaRecord.cursor);
		}
		return undefined;
	}

	#cursor(value: unknown): PrimeDaemonCursor {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("event cursor must be an object");
		const cursor = value as JsonObject;
		if (
			typeof cursor.generation !== "string" ||
			cursor.generation.length === 0 ||
			typeof cursor.sequence !== "number" ||
			!Number.isSafeInteger(cursor.sequence) ||
			cursor.sequence < 0
		) {
			throw new Error("event cursor requires generation and non-negative sequence");
		}
		return { ...cursor, generation: cursor.generation, sequence: cursor.sequence };
	}

	#attachNeedsSnapshot(data: JsonObject): boolean {
		if (data.snapshotStream !== undefined) return true;
		const snapshot = data.snapshot;
		if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return false;
		const snapshotRecord = snapshot as JsonObject;
		const messages = snapshotRecord.messages;
		const summary = snapshotRecord.summary;
		if (!Array.isArray(messages) || typeof summary !== "object" || summary === null || Array.isArray(summary))
			return false;
		const count = (summary as JsonObject).messageCount;
		return typeof count === "number" && Number.isSafeInteger(count) && count > messages.length;
	}

	#isUncertain(response: PrimeDaemonResponse): boolean {
		if (typeof response.errorInfo !== "object" || response.errorInfo === null || Array.isArray(response.errorInfo))
			return false;
		return (response.errorInfo as JsonObject).code === "command_result_uncertain";
	}

	#recordUncertainResponse(pending: PendingCommand, error: Error): void {
		if (!pending.mutation) return;
		const journalRecord = this.store.listPendingCommands().find(record => record.commandId === pending.id);
		if (journalRecord === undefined || journalRecord.responseJson !== null) return;
		this.store.recordCommandResponse(
			pending.id,
			JSON.stringify({
				type: "response",
				id: pending.id,
				command: pending.commandType,
				success: false,
				error: error.message,
				errorInfo: { code: "command_result_uncertain" },
			}),
		);
	}

	#storedResponse(responseJson: string, commandId: string): unknown {
		const response = JSON.parse(responseJson) as PrimeDaemonResponse;
		if (response.success) return response.data;
		if (this.#isUncertain(response)) throw new CommandResultUncertainError(commandId);
		throw new Error(response.error ?? "Prime daemon command failed");
	}

	#object(value: unknown, label: string): JsonObject {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(`${label} must be an object`);
		return value as JsonObject;
	}
	async #reattachSessions(deadline?: number): Promise<void> {
		for (const activeSessionId of this.#attachedSessions) {
			this.#assertBeforeDeadline(deadline);
			const cursor = this.store.getCursor(activeSessionId);
			try {
				await this.#command(
					"attach",
					{
						activeSessionId,
						clientId: this.store.getOrCreateClientId(),
						capabilities: this.#capabilities,
						...(cursor ? { resumeCursor: cursor } : {}),
					},
					false,
					activeSessionId,
					undefined,
					deadline,
				);
			} catch (error) {
				if (!this.connected) throw error;
			}
		}
	}

	#scheduleRecovery(): void {
		let hasJournal = false;
		try {
			hasJournal = this.store.listPendingCommands().length > 0;
		} catch {
			return;
		}
		if (
			this.#closed ||
			this.#reconnectTimer !== undefined ||
			this.#recovering ||
			(this.#attachedSessions.size === 0 && !hasJournal)
		)
			return;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#recoverUntilDeadline();
		}, this.reconnectTimeoutMs);
	}

	async #recoverUntilDeadline(): Promise<void> {
		this.#recovering = true;
		try {
			const deadline = Date.now() + this.reconnectDeadlineMs;
			let delay = this.reconnectTimeoutMs;
			while (!this.#closed && Date.now() < deadline) {
				try {
					await this.#connect(deadline);
					return;
				} catch {
					const remaining = deadline - Date.now();
					if (remaining <= 0) return;
					await new Promise<void>(resolve => {
						this.#recoverySleepTimer = setTimeout(
							() => {
								this.#recoverySleepTimer = undefined;
								resolve();
							},
							Math.min(delay, remaining),
						);
					});
					delay = Math.min(delay * 2, 2_000);
				}
			}
		} finally {
			this.#recovering = false;
		}
	}

	#onClosed(socket: Bun.Socket<undefined> | undefined, generation: number, error: Error): void {
		if (generation !== this.#transportGeneration || (this.#socket !== undefined && socket !== this.#socket)) return;
		socket?.terminate();
		if (this.#socket === socket) this.#socket = undefined;
		this.#transportGeneration += 1;
		this.#inputBytes = Buffer.alloc(0);
		this.#snapshot.reset();
		this.#helloReject?.(error);
		this.#helloPromise = undefined;
		this.#helloResolve = undefined;
		this.#helloReject = undefined;
		this.#daemonHello = undefined;
		this.#helloReceived = false;
		for (const [id, pending] of this.#pending) {
			this.#clearPendingTimer(pending);
			this.#pending.delete(id);
			if (pending.ackFor !== undefined) pending.reject?.(error);
			else if (!pending.settled) {
				if (pending.mutation) {
					this.#recordUncertainResponse(pending, error);
					pending.reject?.(new CommandResultUncertainError(id, error.message));
				} else pending.reject?.(error);
			}
		}
		if (!this.#closed) this.#scheduleRecovery();
	}
}
