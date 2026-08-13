import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import {
	ATTACH_FORCE_TIMEOUT_MS,
	ATTACH_OUTPUT_BACKLOG_BYTES,
	ATTACH_OUTPUT_CHUNK_BYTES,
	ATTACH_PROTOCOL_VERSION,
	ATTACH_RECONNECT_GRACE_MS,
	type AttachClientFrame,
	type AttachHelloFrame,
	type AttachServerFrame,
	type AttachStatusSnapshot,
	decodeAttachFrame,
	encodeAttachFrame,
} from "./protocol";
import {
	attachEndpoint,
	attachHostDir,
	type LiveSessionMetadata,
	publishLiveSession,
	removeLiveSession,
} from "./registry";
import { AttachedSocketTerminal, type SwitchableTerminal } from "./terminal";

interface AuthenticatedSocket {
	socket: net.Socket;
	buffer: string;
	attachmentId?: string;
	lastSequence: number;
}

interface RemoteClaim {
	attachmentId: string;
	resumeToken: string;
	label: string;
	connectedAt: number;
	phase: "connected" | "reconnecting" | "revocation_pending";
	epoch: number;
	deadline: number;
	socketState?: AuthenticatedSocket;
	terminal?: AttachedSocketTerminal;
	expiryTimer?: NodeJS.Timeout;
	outputSequence: number;
	unacknowledgedBytes: number;
	outputBytes: Map<number, number>;
}

interface ForceReplacement {
	claim: RemoteClaim;
	displaced: RemoteClaim | "local";
	timer: NodeJS.Timeout;
}

export interface LiveAttachHostOptions {
	session: AgentSession;
	terminal: SwitchableTerminal;
	hostMode: "interactive" | "rpc" | "rpc-ui";
	project: string;
	onOwnershipChanged?: (snapshot: AttachStatusSnapshot, reason: string) => void;
	reconnectGraceMs?: number;
	forceTimeoutMs?: number;
	outputBacklogBytes?: number;
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function positiveDimension(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value !== undefined && value > 0 ? Math.min(value, 1_000) : fallback;
}

export class LiveAttachHost {
	readonly #session: AgentSession;
	readonly #terminal: SwitchableTerminal;
	readonly #hostMode: "interactive" | "rpc" | "rpc-ui";
	readonly #project: string;
	readonly #hostId = crypto.randomUUID();
	readonly #token = crypto.randomBytes(32).toString("base64url");
	readonly #startedAt = Date.now();
	readonly #reconnectGraceMs: number;
	readonly #forceTimeoutMs: number;
	readonly #outputBacklogBytes: number;
	#onOwnershipChanged: ((snapshot: AttachStatusSnapshot, reason: string) => void) | undefined;
	readonly #sockets = new Set<AuthenticatedSocket>();
	#server: net.Server | undefined;
	#controller: "local" | RemoteClaim | null;
	#pending: RemoteClaim | null = null;
	#replacement: ForceReplacement | null = null;
	#epoch = 1;
	#localConnectedAt = Date.now();
	#localDisplaced = false;
	#unsubscribeSession: (() => void) | undefined;
	#cancelPostmortem: (() => void) | undefined;
	#closed = false;

	constructor(options: LiveAttachHostOptions) {
		this.#session = options.session;
		this.#terminal = options.terminal;
		this.#hostMode = options.hostMode;
		this.#project = options.project;
		this.#reconnectGraceMs = options.reconnectGraceMs ?? ATTACH_RECONNECT_GRACE_MS;
		this.#forceTimeoutMs = options.forceTimeoutMs ?? ATTACH_FORCE_TIMEOUT_MS;
		this.#outputBacklogBytes = options.outputBacklogBytes ?? ATTACH_OUTPUT_BACKLOG_BYTES;
		this.#controller = options.hostMode === "interactive" ? "local" : null;
		this.#onOwnershipChanged = options.onOwnershipChanged;
	}

	get mutationFenced(): boolean {
		return (
			this.#pending !== null ||
			this.#replacement !== null ||
			(this.#controller !== null && this.#controller !== "local")
		);
	}

	get ownershipSnapshot(): AttachStatusSnapshot {
		return this.#snapshot();
	}

	setOwnershipListener(listener: (snapshot: AttachStatusSnapshot, reason: string) => void): void {
		this.#onOwnershipChanged = listener;
	}

	async start(): Promise<void> {
		if (process.platform === "win32") {
			throw new Error(
				"live terminal attachment is not available on Windows until named-pipe peer authorization is verified",
			);
		}
		const endpoint = attachEndpoint(this.#hostId);
		await fs.mkdir(attachHostDir(this.#hostId), { recursive: true, mode: 0o700 });
		await fs.rm(endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(endpoint);
		await promise;
		await fs.chmod(endpoint, 0o600);
		await this.#publish();
		this.#unsubscribeSession = this.#session.subscribe(() => {
			if (!this.#session.isStreaming) this.#grantPending("safe_boundary");
		});
		this.#cancelPostmortem = postmortem.register(`live-attach:${this.#hostId}`, () => this.close());
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		this.#cancelPostmortem?.();
		this.#cancelPostmortem = undefined;
		if (this.#replacement) clearTimeout(this.#replacement.timer);
		for (const claim of [this.#remoteController(), this.#pending, this.#replacement?.claim]) {
			if (claim?.expiryTimer) clearTimeout(claim.expiryTimer);
		}
		for (const state of this.#sockets) state.socket.destroy();
		this.#sockets.clear();
		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
			this.#server = undefined;
		}
		await removeLiveSession(this.#hostId);
	}

	#accept(socket: net.Socket): void {
		const state: AuthenticatedSocket = { socket, buffer: "", lastSequence: 0 };
		this.#sockets.add(state);
		socket.setNoDelay(true);
		socket.on("data", data => this.#onData(state, data));
		socket.on("close", () => this.#onClose(state));
		socket.on("error", error => logger.debug("attach socket error", { error: error.message }));
	}

	#onData(state: AuthenticatedSocket, data: Buffer | string): void {
		state.buffer += data.toString("utf8");
		if (Buffer.byteLength(state.buffer, "utf8") > 2 * 1024 * 1024) {
			state.socket.destroy();
			return;
		}
		while (true) {
			const newline = state.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = state.buffer.slice(0, newline);
			state.buffer = state.buffer.slice(newline + 1);
			try {
				const frame = decodeAttachFrame(line);
				if (state.attachmentId === undefined) {
					if (frame.type !== "hello") throw new Error("hello frame required");
					this.#handleHello(state, frame);
				} else {
					this.#handleFrame(state, frame);
				}
			} catch (error) {
				this.#send(state, {
					type: "error",
					reason: "invalid_protocol",
					message: error instanceof Error ? error.message : String(error),
					retryable: false,
				});
				state.socket.destroy();
				return;
			}
		}
	}

	#handleHello(state: AuthenticatedSocket, frame: AttachHelloFrame): void {
		if (
			frame.protocolVersion !== ATTACH_PROTOCOL_VERSION ||
			!safeEqual(frame.token, this.#token) ||
			frame.sessionId !== this.#session.sessionId
		) {
			state.socket.destroy();
			return;
		}
		if (frame.action === "status") {
			this.#send(state, { type: "status", snapshot: this.#snapshot() });
			state.socket.end();
			return;
		}
		if (frame.action === "reconnect") {
			this.#reconnect(state, frame);
			return;
		}
		if (frame.action === "force") {
			this.#force(state, frame);
			return;
		}
		this.#ordinaryAttach(state, frame);
	}

	#ordinaryAttach(state: AuthenticatedSocket, frame: AttachHelloFrame): void {
		if (this.#controller !== null || this.#pending !== null || this.#replacement !== null) {
			this.#send(state, {
				type: "error",
				reason: this.#pending ? "handoff_pending" : "session_hijacked",
				message: "This live session already has a terminal controller. Retry with --force to take over.",
				retryable: true,
			});
			state.socket.end();
			return;
		}
		const claim = this.#createClaim(state, frame);
		this.#pending = claim;
		if (claim.terminal) this.#terminal.activateAttached(claim.terminal);
		this.#sendAccepted(claim, this.#session.isStreaming ? "control_pending" : "watching");
		this.#emitOwnership("attach_pending");
		this.#grantPending("safe_boundary");
	}

	#force(state: AuthenticatedSocket, frame: AttachHelloFrame): void {
		if (this.#replacement) {
			this.#send(state, {
				type: "error",
				reason: "handoff_pending",
				message: "Another force takeover is already pending.",
				retryable: true,
			});
			state.socket.end();
			return;
		}
		if (this.#controller === null && this.#pending === null) {
			this.#ordinaryAttach(state, frame);
			return;
		}
		if (this.#controller === "local") {
			if (frame.expectedEpoch !== undefined && frame.expectedEpoch !== this.#epoch) {
				this.#staleForce(state);
				return;
			}
			const claim = this.#createClaim(state, frame);
			this.#terminal.fenceLocal(
				"Another terminal requested control. Input is fenced; this frontend will park when takeover commits.",
			);
			this.#sendAccepted(claim, "control_pending");
			const timer = setTimeout(() => this.#commitForce("revocation_timeout"), this.#forceTimeoutMs);
			this.#replacement = { claim, displaced: "local", timer };
			this.#emitOwnership("force_revocation_pending");
			return;
		}
		const displaced = this.#remoteController() ?? this.#pending;
		if (!displaced || (frame.expectedEpoch !== undefined && frame.expectedEpoch !== displaced.epoch)) {
			this.#staleForce(state);
			return;
		}
		const replacement = this.#createClaim(state, frame);
		displaced.phase = "revocation_pending";
		this.#sendAccepted(replacement, "control_pending");
		if (displaced.socketState) {
			this.#send(displaced.socketState, {
				type: "revoked",
				message:
					"This terminal was displaced by an authorized force takeover. Accepted agent work continues; input is fenced.",
			});
		}
		const timer = setTimeout(() => this.#commitForce("revocation_timeout"), this.#forceTimeoutMs);
		this.#replacement = { claim: replacement, displaced, timer };
		this.#emitOwnership("force_revocation_pending");
	}

	#staleForce(state: AuthenticatedSocket): void {
		this.#send(state, {
			type: "error",
			reason: "controller_changed",
			message: "The terminal controller changed before takeover confirmation. Refresh and confirm again.",
			retryable: true,
		});
		state.socket.end();
	}

	#commitForce(reason: string): void {
		const replacement = this.#replacement;
		if (!replacement) return;
		clearTimeout(replacement.timer);
		this.#replacement = null;
		const displaced = replacement.displaced;
		if (displaced === "local") {
			this.#localDisplaced = true;
			this.#terminal.parkLocal(
				"Control moved to another terminal. This frontend is parked and will resume automatically after detach.",
			);
			this.#controller = null;
		} else {
			if (this.#controller === displaced) this.#controller = null;
			if (this.#pending === displaced) this.#pending = null;
			if (displaced.terminal) this.#terminal.clearAttached(displaced.terminal);
			displaced.socketState?.socket.destroy();
			if (displaced.expiryTimer) clearTimeout(displaced.expiryTimer);
		}
		this.#epoch += 1;
		this.#pending = replacement.claim;
		if (replacement.claim.terminal) this.#terminal.activateAttached(replacement.claim.terminal);
		this.#emitOwnership(reason);
		this.#grantPending("safe_boundary");
	}

	#cancelForce(reason: string, notifyReplacement: boolean): void {
		const replacement = this.#replacement;
		if (!replacement) return;
		clearTimeout(replacement.timer);
		this.#replacement = null;
		if (replacement.claim.terminal) this.#terminal.clearAttached(replacement.claim.terminal);
		if (notifyReplacement && replacement.claim.socketState) {
			this.#send(replacement.claim.socketState, {
				type: "detached",
				message: "Takeover cancelled. The live agent is still running.",
			});
			replacement.claim.socketState.socket.end();
		}
		const displaced = replacement.displaced;
		if (displaced === "local") {
			this.#terminal.unfenceLocal();
		} else if (displaced.socketState) {
			displaced.phase = "connected";
			if (displaced.terminal) this.#terminal.activateAttached(displaced.terminal);
		} else {
			displaced.phase = "reconnecting";
			displaced.deadline = Date.now() + this.#reconnectGraceMs;
			displaced.expiryTimer = setTimeout(() => this.#expireClaim(displaced), this.#reconnectGraceMs);
		}
		this.#emitOwnership(reason);
	}

	#reconnect(state: AuthenticatedSocket, frame: AttachHelloFrame): void {
		const claim = this.#remoteController();
		if (
			claim?.phase !== "reconnecting" ||
			frame.attachmentId !== claim.attachmentId ||
			frame.resumeToken === undefined ||
			!safeEqual(frame.resumeToken, claim.resumeToken) ||
			Date.now() >= claim.deadline
		) {
			this.#send(state, {
				type: "error",
				reason: "reconnect_expired",
				message: "The retained terminal claim is unavailable. Attach again.",
				retryable: true,
			});
			state.socket.end();
			return;
		}
		claim.socketState = state;
		state.attachmentId = claim.attachmentId;
		claim.phase = "connected";
		claim.deadline = Date.now() + this.#reconnectGraceMs;
		if (claim.expiryTimer) clearTimeout(claim.expiryTimer);
		claim.terminal = this.#createSocketTerminal(claim, frame);
		this.#terminal.activateAttached(claim.terminal);
		this.#sendAccepted(claim, "control");
		this.#emitOwnership("reconnected");
	}

	#createClaim(state: AuthenticatedSocket, frame: AttachHelloFrame): RemoteClaim {
		const attachmentId = crypto.randomUUID();
		const claim: RemoteClaim = {
			attachmentId,
			resumeToken: crypto.randomBytes(32).toString("base64url"),
			label: `Terminal ${attachmentId.slice(0, 6)}`,
			connectedAt: Date.now(),
			phase: "connected",
			epoch: this.#epoch + 1,
			deadline: Date.now() + this.#reconnectGraceMs,
			socketState: state,
			outputSequence: 0,
			unacknowledgedBytes: 0,
			outputBytes: new Map(),
		};
		state.attachmentId = attachmentId;
		claim.terminal = this.#createSocketTerminal(claim, frame);
		return claim;
	}

	#createSocketTerminal(claim: RemoteClaim, frame: AttachHelloFrame): AttachedSocketTerminal {
		return new AttachedSocketTerminal(positiveDimension(frame.columns, 80), positiveDimension(frame.rows, 24), data =>
			this.#sendOutput(claim, data),
		);
	}

	#grantPending(reason: string): void {
		const claim = this.#pending;
		if (!claim || this.#session.isStreaming || claim.phase !== "connected" || !claim.socketState || !claim.terminal)
			return;
		this.#pending = null;
		this.#epoch += 1;
		claim.epoch = this.#epoch;
		claim.deadline = Date.now() + this.#reconnectGraceMs;
		this.#controller = claim;
		this.#terminal.activateAttached(claim.terminal);
		this.#send(claim.socketState, { type: "control", epoch: claim.epoch });
		this.#emitOwnership(reason);
	}

	#handleFrame(state: AuthenticatedSocket, frame: AttachClientFrame): void {
		const claim = this.#claimForState(state);
		if (!claim) {
			state.socket.destroy();
			return;
		}
		if (frame.type === "revocation_rendered") {
			if (this.#replacement?.displaced === claim && frame.attachmentId === claim.attachmentId) {
				this.#commitForce("revocation_rendered");
			}
			return;
		}
		if (frame.type === "output_ack") {
			this.#ackOutput(claim, frame.sequence);
			return;
		}
		if ("sequence" in frame) {
			if (frame.sequence <= state.lastSequence) return;
			state.lastSequence = frame.sequence;
		}
		if (frame.type === "heartbeat") {
			claim.deadline = Date.now() + this.#reconnectGraceMs;
			this.#send(state, { type: "heartbeat", reconnectDeadlineMs: claim.deadline });
			return;
		}
		if (frame.type === "detach") {
			if (this.#replacement?.claim === claim) {
				this.#cancelForce("force_replacement_detached", true);
				return;
			}
			if (this.#replacement?.displaced === claim) {
				this.#send(state, { type: "detached", message: "Detached. The live agent is still running." });
				this.#commitForce("displaced_detached");
				return;
			}
			this.#releaseClaim(claim, "detached", true);
			return;
		}
		if (claim !== this.#controller || claim.phase !== "connected") return;
		if (frame.type === "input" && frame.epoch === claim.epoch) {
			claim.terminal?.input(Buffer.from(frame.data, "base64").toString("utf8"));
		} else if (frame.type === "resize" && frame.epoch === claim.epoch) {
			claim.terminal?.resize(positiveDimension(frame.columns, 80), positiveDimension(frame.rows, 24));
		}
	}

	#onClose(state: AuthenticatedSocket): void {
		this.#sockets.delete(state);
		const claim = this.#claimForState(state);
		if (!claim || claim.socketState !== state) return;
		claim.socketState = undefined;
		if (this.#replacement?.claim === claim) {
			this.#cancelForce("force_replacement_disconnected", false);
			return;
		}
		if (this.#replacement?.displaced === claim) {
			claim.phase = "reconnecting";
			claim.deadline = Date.now() + this.#reconnectGraceMs;
			if (claim.terminal) this.#terminal.clearAttached(claim.terminal);
			this.#emitOwnership("displaced_connection_lost");
			return;
		}
		claim.phase = "reconnecting";
		claim.deadline = Date.now() + this.#reconnectGraceMs;
		if (claim.terminal) this.#terminal.clearAttached(claim.terminal);
		claim.expiryTimer = setTimeout(() => this.#expireClaim(claim), this.#reconnectGraceMs);
		this.#emitOwnership("connection_lost");
	}

	#expireClaim(claim: RemoteClaim): void {
		if (claim.phase !== "reconnecting" || Date.now() < claim.deadline) return;
		this.#releaseClaim(claim, "reconnect_expired", false);
	}

	#releaseClaim(claim: RemoteClaim, reason: string, notify: boolean): void {
		if (claim.expiryTimer) clearTimeout(claim.expiryTimer);
		if (this.#controller === claim) this.#controller = null;
		if (this.#pending === claim) this.#pending = null;
		if (claim.terminal) this.#terminal.clearAttached(claim.terminal);
		this.#epoch += 1;
		if (notify && claim.socketState) {
			this.#send(claim.socketState, {
				type: "detached",
				message: "Detached. The live agent is still running.",
			});
			claim.socketState.socket.end();
		}
		if (this.#localDisplaced && this.#terminal.localAvailable) {
			this.#localDisplaced = false;
			this.#controller = "local";
			this.#localConnectedAt = Date.now();
			this.#terminal.resumeLocal("Attached control ended. Original terminal control resumed automatically.");
		}
		this.#emitOwnership(reason);
	}

	#sendOutput(claim: RemoteClaim, data: string): void {
		const state = claim.socketState;
		if (!state || state.socket.destroyed) return;
		const bytes = Buffer.from(data, "utf8");
		for (let offset = 0; offset < bytes.length; offset += ATTACH_OUTPUT_CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, Math.min(offset + ATTACH_OUTPUT_CHUNK_BYTES, bytes.length));
			const sequence = ++claim.outputSequence;
			claim.outputBytes.set(sequence, chunk.byteLength);
			claim.unacknowledgedBytes += chunk.byteLength;
			this.#send(state, { type: "output", sequence, data: chunk.toString("base64") });
			if (claim.unacknowledgedBytes > this.#outputBacklogBytes) {
				this.#releaseClaim(claim, "slow_consumer", false);
				state.socket.destroy();
				return;
			}
		}
	}

	#ackOutput(claim: RemoteClaim, sequence: number): void {
		for (const [pendingSequence, bytes] of claim.outputBytes) {
			if (pendingSequence > sequence) break;
			claim.outputBytes.delete(pendingSequence);
			claim.unacknowledgedBytes = Math.max(0, claim.unacknowledgedBytes - bytes);
		}
	}

	#claimForState(state: AuthenticatedSocket): RemoteClaim | undefined {
		const id = state.attachmentId;
		if (!id) return undefined;
		const replacementDisplaced = this.#replacement?.displaced === "local" ? undefined : this.#replacement?.displaced;
		for (const claim of [this.#remoteController(), this.#pending, this.#replacement?.claim, replacementDisplaced]) {
			if (claim?.attachmentId === id) return claim;
		}
		return undefined;
	}

	#remoteController(): RemoteClaim | null {
		return this.#controller !== null && this.#controller !== "local" ? this.#controller : null;
	}

	#sendAccepted(claim: RemoteClaim, state: "watching" | "control_pending" | "control"): void {
		if (!claim.socketState) return;
		this.#send(claim.socketState, {
			type: "accepted",
			attachmentId: claim.attachmentId,
			resumeToken: claim.resumeToken,
			state,
			epoch: state === "control" ? claim.epoch : undefined,
			reconnectDeadlineMs: claim.deadline,
		});
	}

	#send(state: AuthenticatedSocket, frame: AttachServerFrame): void {
		if (!state.socket.destroyed) state.socket.write(encodeAttachFrame(frame));
	}

	#snapshot(): AttachStatusSnapshot {
		const now = Date.now();
		let controller: AttachStatusSnapshot["controller"] = null;
		if (this.#controller === "local") {
			controller = { label: "Original terminal", state: "connected", ageMs: now - this.#localConnectedAt };
		} else if (this.#controller) {
			controller = {
				label: this.#controller.label,
				state: this.#controller.phase,
				ageMs: now - this.#controller.connectedAt,
			};
		} else if (this.#pending) {
			controller = {
				label: this.#pending.label,
				state: this.#pending.phase === "reconnecting" ? "reconnecting" : "connected",
				ageMs: now - this.#pending.connectedAt,
			};
		}
		return {
			sessionId: this.#session.sessionId,
			project: this.#project,
			hostMode: this.#hostMode,
			activity: this.#session.isStreaming ? "turn_running" : "idle",
			controlState:
				this.#pending || this.#replacement
					? "control_pending"
					: this.#controller === null
						? "available"
						: this.#controller !== "local" && this.#controller.phase === "reconnecting"
							? "reconnecting"
							: "controlled",
			controller,
			epoch: this.#epoch,
			updatedAt: now,
		};
	}

	#emitOwnership(reason: string): void {
		const snapshot = this.#snapshot();
		this.#onOwnershipChanged?.(snapshot, reason);
		void this.#publish();
	}

	async #publish(): Promise<void> {
		const metadata: LiveSessionMetadata = {
			schemaVersion: 1,
			hostId: this.#hostId,
			sessionId: this.#session.sessionId,
			project: this.#project,
			hostMode: this.#hostMode,
			pid: process.pid,
			endpoint: attachEndpoint(this.#hostId),
			startedAt: this.#startedAt,
			updatedAt: Date.now(),
		};
		try {
			await publishLiveSession(metadata, this.#token);
		} catch (error) {
			logger.warn("Failed to publish live attach session", { error: String(error) });
		}
	}
}
