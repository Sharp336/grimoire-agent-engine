import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	ClientSideConnection,
	type ContentBlock,
	type InitializeResponse,
	type McpServer,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionNotification,
	type Stream,
} from "@oh-my-pi/pi-utils/acp";

export interface CursorAcpOptions {
	cwd: string;
	sessionId?: string;
	model?: string;
	mode?: "agent" | "ask" | "plan";
	mcpServers?: McpServer[];
	/** Commit the binding before a prompt can be dispatched. Never store Cursor credentials. */
	onSession: (sessionId: string) => Promise<void>;
	onUpdate: (notification: SessionNotification, replay: boolean) => void;
	/** The owner must apply its permission/effect gate; absence is not permission. */
	onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
	requestTimeoutMs?: number;
	cancelTimeoutMs?: number;
}

/** Official Cursor ACP session. This owns no API credentials and never retries a prompt. */
export class CursorAcpSession {
	#connection: ClientSideConnection;
	#options: CursorAcpOptions;
	#terminate: () => void;
	#sessionId?: string;
	#ready = false;
	#busy = false;
	#replay = false;
	#disposed = false;
	#cancelled = false;
	#closed = Promise.withResolvers<never>();
	#cancelTimer?: NodeJS.Timeout;
	#callbackFailure?: unknown;
	capabilities?: InitializeResponse;

	constructor(stream: Stream, terminate: () => void, options: CursorAcpOptions) {
		this.#options = options;
		this.#terminate = terminate;
		this.#sessionId = options.sessionId;
		void this.#closed.promise.catch(() => {});
		this.#connection = new ClientSideConnection(
			() => ({
				sessionUpdate: notification => {
					if (this.#disposed) return;
					if (this.#sessionId && notification.sessionId !== this.#sessionId) {
						this.#fail(new Error("Cursor sent an update for a different session"));
						return;
					}
					try {
						options.onUpdate(notification, this.#replay);
					} catch (error) {
						this.#fail(error);
					}
				},
				requestPermission: async request => {
					if (
						!this.#ready ||
						!this.#busy ||
						this.#cancelled ||
						this.#replay ||
						this.#disposed ||
						request.sessionId !== this.#sessionId
					) {
						return { outcome: { outcome: "cancelled" } };
					}
					const result = await options.onPermission(request);
					if (this.#disposed || this.#cancelled) return { outcome: { outcome: "cancelled" } };
					const outcome = result.outcome;
					if (
						outcome.outcome === "selected" &&
						!request.options.some(option => option.optionId === outcome.optionId)
					) {
						throw RequestError.invalidParams(undefined, "Permission choice was not offered by Cursor");
					}
					return result;
				},
				// Never leave blocking Cursor extensions unanswered or fabricate a user's answer.
				extMethod: method => {
					throw RequestError.methodNotFound(method);
				},
			}),
			stream,
		);
	}

	/** Command must come from verified owner-local CLI discovery, not a hosted artifact. */
	static spawn(command: readonly [string, ...string[]], options: CursorAcpOptions): CursorAcpSession {
		const child = spawn(command[0], command.slice(1), {
			cwd: options.cwd,
			windowsHide: true,
			stdio: "pipe",
		});
		// Drain diagnostics without copying login URLs, account data or stderr into history.
		child.stderr.resume();
		child.stdin.on("error", () => child.stdout.destroy(new Error("Cursor CLI input closed")));
		child.on("error", () => child.stdout.destroy(new Error("Cursor CLI could not be started")));
		return new CursorAcpSession(
			ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
			() => {
				child.stdin.destroy();
				child.stdout.destroy();
				child.kill();
			},
			options,
		);
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	async initialize(): Promise<void> {
		if (this.#ready || this.#busy || this.#disposed) throw new Error("Cursor session cannot be initialized");
		this.#busy = true;
		try {
			this.capabilities = await this.#bounded(
				this.#connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: { name: "artel-engine", version: "1" },
					clientCapabilities: {},
				}),
			);
			if (this.capabilities.protocolVersion !== PROTOCOL_VERSION) {
				throw new Error("Cursor ACP protocol version is unsupported");
			}
			const setup = { cwd: this.#options.cwd, mcpServers: this.#options.mcpServers ?? [] };
			let configOptions: SessionConfigOption[] | null | undefined;
			if (this.#sessionId) {
				if (this.capabilities.agentCapabilities?.loadSession !== true) {
					throw new Error("Cursor cannot restore this session; refusing to create a replacement chat");
				}
				this.#replay = true;
				const result = await this.#bounded(this.#connection.loadSession({ ...setup, sessionId: this.#sessionId }));
				configOptions = result.configOptions;
				this.#replay = false;
			} else {
				const result = await this.#bounded(this.#connection.newSession(setup));
				if (!result.sessionId?.trim()) throw new Error("Cursor returned an empty session identity");
				this.#sessionId = result.sessionId;
				configOptions = result.configOptions;
			}
			await this.#options.onSession(this.#sessionId);
			if (this.#options.model) {
				const model = configOptions?.find(option => option.category === "model" || option.id === "model");
				if (model?.type !== "select" || !model.options.some(option => option.value === this.#options.model)) {
					throw new Error("Requested model is not selectable in this Cursor ACP session");
				}
				if (model.currentValue !== this.#options.model) {
					const applied = await this.#bounded(
						this.#connection.setSessionConfigOption({
							sessionId: this.#sessionId,
							configId: model.id,
							value: this.#options.model,
						}),
					);
					if (
						!applied.configOptions.some(
							option => option.id === model.id && option.currentValue === this.#options.model,
						)
					) {
						throw new Error("Cursor did not apply the requested model");
					}
				}
			}
			if (this.#options.mode) {
				await this.#bounded(
					this.#connection.setSessionMode({ sessionId: this.#sessionId, modeId: this.#options.mode }),
				);
			}
			if (this.#callbackFailure) throw this.#callbackFailure;
			this.#ready = true;
		} catch (error) {
			this.dispose();
			throw error;
		} finally {
			this.#busy = false;
			this.#replay = false;
		}
	}

	async prompt(prompt: ContentBlock[], signal?: AbortSignal): Promise<PromptResponse> {
		signal?.throwIfAborted();
		if (!this.#ready || !this.#sessionId || this.#disposed) throw new Error("Cursor session is not ready");
		if (this.#busy) throw new Error("Cursor is already working; queue this message for the next turn");
		this.#busy = true;
		this.#cancelled = false;
		const cancel = () => void this.cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const result = await this.#bounded(this.#connection.prompt({ sessionId: this.#sessionId, prompt }));
			if (this.#callbackFailure) throw this.#callbackFailure;
			if (signal?.aborted) return { stopReason: "cancelled", usage: result.usage };
			return result;
		} catch (error) {
			this.dispose();
			throw this.#callbackFailure ?? error;
		} finally {
			clearTimeout(this.#cancelTimer);
			this.#cancelTimer = undefined;
			signal?.removeEventListener("abort", cancel);
			this.#busy = false;
		}
	}

	async cancel(): Promise<void> {
		if (!this.#busy || !this.#sessionId || this.#disposed || this.#cancelTimer) return;
		this.#cancelled = true;
		this.#cancelTimer = setTimeout(() => this.dispose(), this.#options.cancelTimeoutMs ?? 5_000);
		try {
			await this.#connection.cancel({ sessionId: this.#sessionId });
		} catch {
			this.dispose();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#closed.reject(new Error("Cursor ACP session closed"));
		clearTimeout(this.#cancelTimer);
		this.#terminate();
	}

	#fail(error: unknown): void {
		this.#callbackFailure = error;
		this.dispose();
	}

	async #bounded<T>(operation: Promise<T>): Promise<T> {
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			timeout.reject(new Error("Cursor ACP request timed out; no automatic prompt retry was made"));
			this.dispose();
		}, this.#options.requestTimeoutMs ?? 120_000);
		try {
			return await Promise.race([operation, timeout.promise, this.#closed.promise]);
		} finally {
			clearTimeout(timer);
		}
	}
}
