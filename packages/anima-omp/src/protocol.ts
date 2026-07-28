const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const REQUIRED_METHODS = [
	"invoke.start",
	"invoke.observe",
	"invoke.wait_turn",
	"invoke.cancel",
	"invoke.release",
] as const;

export interface ControlErrorBody {
	code: string;
	message: string;
	retryable: boolean;
	details?: unknown;
}

export interface ControlEvent {
	type: "event";
	invocation_id: string;
	event: {
		kind: string;
		at: string;
		detail?: string;
		recoverable?: boolean;
	};
}

export interface ProtocolHello {
	protocol: "anima-control";
	version: number;
	anima_version: string;
	methods: string[];
	capabilities: Record<string, boolean>;
	limits: {
		max_line_bytes: number;
		max_in_flight: number;
	};
}

export interface ControlRequestOptions {
	id?: string;
	timeoutMs?: number;
}

export interface AnimaControl {
	hello(): Promise<ProtocolHello>;
	request<T>(method: string, params: unknown, options?: ControlRequestOptions): Promise<T>;
	onEvent?(listener: (event: ControlEvent) => void): () => void;
	close(): Promise<void>;
}

export class ControlProtocolError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly retryable = false,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "ControlProtocolError";
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer?: Timer;
}

interface ResponseEnvelope {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: ControlErrorBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.ok === "boolean" &&
		(value.ok || isRecord(value.error))
	);
}

function isControlEvent(value: unknown): value is ControlEvent {
	return (
		isRecord(value) &&
		value.type === "event" &&
		typeof value.invocation_id === "string" &&
		isRecord(value.event) &&
		typeof value.event.kind === "string" &&
		typeof value.event.at === "string"
	);
}

export class StdioControlClient implements AnimaControl {
	readonly #command: string[];
	readonly #pending = new Map<string, PendingRequest>();
	readonly #listeners = new Set<(event: ControlEvent) => void>();
	#process?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#helloPromise?: Promise<ProtocolHello>;
	#maxLineBytes = DEFAULT_MAX_LINE_BYTES;
	#closed = false;
	#requestSequence = 0;

	constructor(command: string[] = [process.env.ANIMA_BIN || "an", "control", "stdio"]) {
		this.#command = command;
	}

	onEvent(listener: (event: ControlEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	hello(): Promise<ProtocolHello> {
		this.#helloPromise ??= this.#startAndHello();
		return this.#helloPromise;
	}

	async request<T>(method: string, params: unknown, options: ControlRequestOptions = {}): Promise<T> {
		if (method !== "protocol.hello") await this.hello();
		return this.#requestUnchecked<T>(method, params, options);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const process = this.#process;
		this.#process = undefined;
		this.#rejectPending(new ControlProtocolError("transport_closed", "Anima control transport closed", true));
		if (!process) return;
		try {
			process.stdin.end();
		} catch {
			// Process may already have exited.
		}
		await process.exited;
	}

	async #startAndHello(): Promise<ProtocolHello> {
		this.#ensureStarted();
		const hello = await this.#requestUnchecked<ProtocolHello>("protocol.hello", {}, { id: "hello" });
		if (hello.protocol !== "anima-control" || hello.version !== 1) {
			throw new ControlProtocolError(
				"unsupported_protocol",
				`Unsupported Anima control protocol ${JSON.stringify(hello.protocol)} version ${String(hello.version)}`,
			);
		}
		const missing = REQUIRED_METHODS.filter(method => !hello.methods.includes(method));
		if (missing.length > 0) {
			throw new ControlProtocolError(
				"missing_method",
				`Anima control is missing required methods: ${missing.join(", ")}`,
			);
		}
		if (!hello.capabilities.turn_authority) {
			throw new ControlProtocolError("missing_capability", "Anima control does not advertise turn authority");
		}
		if (hello.limits.max_line_bytes > 0) this.#maxLineBytes = hello.limits.max_line_bytes;
		return hello;
	}

	#ensureStarted(): Bun.Subprocess<"pipe", "pipe", "pipe"> {
		if (this.#closed) throw new ControlProtocolError("transport_closed", "Anima control transport is closed");
		if (this.#process) return this.#process;
		const child = Bun.spawn(this.#command, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		this.#process = child;
		void this.#readStdout(child);
		void this.#readStderr(child);
		void child.exited.then(exitCode => {
			if (this.#process !== child) return;
			this.#process = undefined;
			this.#rejectPending(
				new ControlProtocolError(
					"transport_exited",
					`Anima control process exited with code ${String(exitCode)}`,
					true,
				),
			);
		});
		return child;
	}

	#requestUnchecked<T>(method: string, params: unknown, options: ControlRequestOptions): Promise<T> {
		const process = this.#ensureStarted();
		const id = options.id ?? `omp-${Date.now().toString(36)}-${(++this.#requestSequence).toString(36)}`;
		if (this.#pending.has(id)) {
			throw new ControlProtocolError(
				"duplicate_request",
				`A control request with id ${JSON.stringify(id)} is pending`,
			);
		}
		const line = `${JSON.stringify({ id, method, params })}\n`;
		if (Buffer.byteLength(line) > this.#maxLineBytes) {
			throw new ControlProtocolError(
				"line_too_large",
				`Control request exceeds ${String(this.#maxLineBytes)} bytes`,
			);
		}
		const deferred = Promise.withResolvers<T>();
		const pending: PendingRequest = {
			resolve: value => deferred.resolve(value as T),
			reject: deferred.reject,
		};
		if (options.timeoutMs && options.timeoutMs > 0) {
			pending.timer = setTimeout(() => {
				if (!this.#pending.delete(id)) return;
				deferred.reject(new ControlProtocolError("request_timeout", `${method} timed out`, true));
			}, options.timeoutMs);
		}
		this.#pending.set(id, pending);
		try {
			process.stdin.write(line);
			process.stdin.flush();
		} catch (error) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			deferred.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return deferred.promise;
	}

	async #readStdout(process: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			for await (const chunk of process.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				if (Buffer.byteLength(buffered) > this.#maxLineBytes && !buffered.includes("\n")) {
					throw new ControlProtocolError("line_too_large", "Anima control emitted an oversized line");
				}
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					if (line.length > 0) this.#handleLine(line);
					newline = buffered.indexOf("\n");
				}
			}
		} catch (error) {
			this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #readStderr(process: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of process.stderr) {
			const text = decoder.decode(chunk, { stream: true }).trim();
			if (text) console.error(`[anima-control] ${text}`);
		}
	}

	#handleLine(line: string): void {
		if (Buffer.byteLength(line) > this.#maxLineBytes) {
			throw new ControlProtocolError("line_too_large", "Anima control emitted an oversized line");
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new ControlProtocolError("invalid_response", "Anima control emitted malformed JSON");
		}
		if (isControlEvent(value)) {
			for (const listener of this.#listeners) listener(value);
			return;
		}
		if (!isResponseEnvelope(value)) {
			throw new ControlProtocolError("invalid_response", "Anima control emitted an invalid response envelope");
		}
		const pending = this.#pending.get(value.id);
		if (!pending) return;
		this.#pending.delete(value.id);
		clearTimeout(pending.timer);
		if (value.ok) {
			pending.resolve(value.result);
			return;
		}
		const error = value.error;
		pending.reject(
			new ControlProtocolError(
				error?.code ?? "control_error",
				error?.message ?? "Anima control request failed",
				error?.retryable ?? false,
				error?.details,
			),
		);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

let sharedClient: StdioControlClient | undefined;

export function getSharedControlClient(): StdioControlClient {
	sharedClient ??= new StdioControlClient();
	return sharedClient;
}
