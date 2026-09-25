import {
	assertStorageProtocolHash,
	STORAGE_PROTOCOL_SCHEMA,
	STORAGE_PROTOCOL_VERSION,
	type StorageBarrier,
	type StorageBarrierSuccessResponse,
	type StorageErrorCode,
	type StorageProtocolResponse,
	type StorageRead,
	type StorageReadSuccessResponse,
	type StorageReceipt,
	type StorageRuntimeQuery,
	type StorageRuntimeQueryResponse,
	type StorageWrite,
} from "./storage-protocol";

export interface StorageBinding {
	url: string;
	token: string;
	incarnation: number;
	protocolHash: string;
}

export interface StorageClientLimits {
	writeRequests: number;
	writeBytes: number;
	readRequests: number;
	controlRequests: number;
	requestBytes: number;
	responseBytes: number;
	deadlineMs: number;
}

const defaults: StorageClientLimits = {
	writeRequests: 32,
	writeBytes: 8 * 1024 * 1024,
	readRequests: 8,
	controlRequests: 8,
	requestBytes: 1024 * 1024,
	responseBytes: 2 * 1024 * 1024,
	deadlineMs: 10_000,
};

export class StorageClientError extends Error {
	constructor(
		readonly code: StorageErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StorageClientError";
	}
}

/** JCS orders even numeric-looking object keys lexically; JSON.stringify alone does not. */
export function storageCanonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value === "string") {
		if (!value.isWellFormed()) throw new TypeError("Storage JSON contains an unpaired surrogate");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(storageCanonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${storageCanonicalJson(key)}:${storageCanonicalJson(Reflect.get(value, key))}`)
			.join(",")}}`;
	}
	throw new TypeError("Storage values must be finite JSON data");
}

export function readStorageBinding(value = process.env.GRIMOIRE_STORAGE_BINDING): StorageBinding | undefined {
	if (value === undefined) return undefined;
	const binding: unknown = JSON.parse(value);
	if (!binding || typeof binding !== "object") throw new Error("Invalid ClientHost storage binding");
	const b = binding as StorageBinding;
	const url = new URL(b.url);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		typeof b.token !== "string" ||
		b.token.length < 16 ||
		!Number.isSafeInteger(b.incarnation) ||
		b.incarnation < 1
	)
		throw new Error("Invalid ClientHost storage binding");
	assertStorageProtocolHash(b.protocolHash);
	return { url: url.origin, token: b.token, incarnation: b.incarnation, protocolHash: b.protocolHash };
}

type WriteInput = Omit<StorageWrite, "requestId" | "payloadHash" | "incarnation">;
type Lane = "write" | "read" | "control";

/** One bounded HTTP client per Engine. Admission is synchronous; there is no hidden pending queue. */
export class StorageClient {
	readonly #binding: StorageBinding;
	readonly #limits: StorageClientLimits;
	readonly #active = { write: 0, read: 0, control: 0 };
	readonly #listeners = new Set<(error: StorageClientError) => void>();
	#writeBytes = 0;
	#failure?: StorageClientError;

	constructor(binding: StorageBinding, limits: Partial<StorageClientLimits> = {}) {
		this.#binding = readStorageBinding(JSON.stringify(binding))!;
		this.#limits = { ...defaults, ...limits };
		for (const value of Object.values(this.#limits)) {
			if (!Number.isSafeInteger(value) || value < 1) throw new Error("Storage limits must be positive integers");
		}
	}

	get incarnation(): number {
		return this.#binding.incarnation;
	}
	get failure(): StorageClientError | undefined {
		return this.#failure;
	}
	get pending(): Readonly<{ write: number; read: number; control: number; writeBytes: number }> {
		return { ...this.#active, writeBytes: this.#writeBytes };
	}
	onFailure(listener: (error: StorageClientError) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	write(input: WriteInput, control = false): Promise<StorageReceipt> {
		const payload = { ...input, incarnation: this.incarnation };
		// The canonical payload is the only serialization: it is hashed and spliced into the request body.
		const canonical = storageCanonicalJson(payload);
		const payloadHash = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}` as const;
		const write: StorageWrite = { ...payload, payloadHash, requestId: crypto.randomUUID() };
		const body = `{"schema":${JSON.stringify(STORAGE_PROTOCOL_SCHEMA)},"version":${JSON.stringify(STORAGE_PROTOCOL_VERSION)},"operation":"write","write":${canonical.slice(0, -1)},"payloadHash":${JSON.stringify(payloadHash)},"requestId":${JSON.stringify(write.requestId)}}}`;
		const release = this.#reserve(control ? "control" : "write", Buffer.byteLength(body));
		return this.#write(write, body).finally(release);
	}

	barrier(input: Omit<StorageBarrier, "requestId" | "incarnation">): Promise<StorageBarrierSuccessResponse> {
		return this.#request("control", "/v1/barrier", "barrier", "barrier", input).then(response => {
			// An owner that answers but cannot confirm the prefix leaves accepted writes with unknown durability.
			if (!("durableThroughSeq" in response) || response.durableThroughSeq < input.throughSeq)
				throw this.#fence("outcome_unknown", "Storage barrier did not confirm its requested prefix");
			return response as StorageBarrierSuccessResponse;
		});
	}

	readRange(
		input: Omit<StorageRead, "requestId" | "incarnation">,
		control = false,
	): Promise<StorageReadSuccessResponse> {
		return this.#read("range", input, control);
	}
	readContext(input: Omit<StorageRead, "requestId" | "incarnation">): Promise<StorageReadSuccessResponse> {
		return this.#read("context", input);
	}
	readChildren(input: Omit<StorageRead, "requestId" | "incarnation">): Promise<StorageReadSuccessResponse> {
		return this.#read("children", input);
	}
	runtimeQuery(
		input: Omit<StorageRuntimeQuery, "requestId" | "incarnation">,
		control = false,
	): Promise<StorageRuntimeQueryResponse> {
		return this.#request(control ? "control" : "read", "/v1/runtime/query", "runtime_query", "query", input).then(
			response => {
				if (
					!("records" in response) ||
					!Array.isArray(response.records) ||
					response.records.length > input.maxRecords
				)
					throw new StorageClientError("schema_error", "Invalid bounded runtime query response");
				return response as StorageRuntimeQueryResponse;
			},
		);
	}

	#read(
		kind: "range" | "context" | "children",
		input: Omit<StorageRead, "requestId" | "incarnation">,
		control = false,
	): Promise<StorageReadSuccessResponse> {
		return this.#request(control ? "control" : "read", `/v1/read/${kind}`, `read_${kind}`, "read", input).then(
			response => {
				if (!("events" in response) || !Array.isArray(response.events) || response.events.length > input.maxRecords)
					throw new StorageClientError("schema_error", "Invalid bounded storage read response");
				return response as StorageReadSuccessResponse;
			},
		);
	}

	/** Reads and barriers change nothing, so an unusable response is an ordinary retryable failure, never a fence. */
	#request(
		lane: Lane,
		route: string,
		operation: string,
		key: string,
		input: object,
	): Promise<StorageProtocolResponse> {
		const requestId = crypto.randomUUID();
		const body = this.#body(operation, key, { ...input, requestId, incarnation: this.incarnation });
		const release = this.#reserve(lane, Buffer.byteLength(body));
		return this.#http(route, body, requestId, Date.now() + this.#limits.deadlineMs)
			.catch(error => {
				if (error instanceof StorageClientError && error.code === "outcome_unknown")
					throw new StorageClientError("retryable", error.message);
				throw error;
			})
			.finally(release);
	}

	async #write(write: StorageWrite, body: string): Promise<StorageReceipt> {
		const deadline = Date.now() + this.#limits.deadlineMs;
		let pollMs = 10;
		let response: StorageProtocolResponse | undefined;
		try {
			response = await this.#http(
				"/v1/write",
				body,
				write.requestId,
				Date.now() + Math.floor(this.#limits.deadlineMs / 2),
			);
		} catch (error) {
			if (!(error instanceof StorageClientError) || error.code !== "outcome_unknown") throw error;
		}
		while (true) {
			if (response && "receipt" in response) {
				const receipt = response.receipt;
				if (
					receipt.operationId !== write.operationId ||
					receipt.payloadHash !== write.payloadHash ||
					receipt.familyId !== write.familyId ||
					receipt.generationId !== write.generationId
				)
					throw this.#fence("storage_error", "Storage returned a different operation receipt");
				if (
					receipt.outcome !== "pending" &&
					receipt.outcome !== "outcome_unknown" &&
					receipt.outcome !== "success"
				) {
					const code = receipt.error?.code ?? "storage_error";
					if (code === "stale_incarnation") throw this.#fence(code, receipt.error?.message ?? receipt.outcome);
					throw new StorageClientError(code, receipt.error?.message ?? receipt.outcome);
				}
				if (
					receipt.appliedState === "applied" &&
					(write.durability === "buffered" || receipt.durabilityState === "durable")
				)
					return receipt;
			}
			if (Date.now() >= deadline)
				throw this.#fence("outcome_unknown", "Storage write outcome is unknown; operation identity retained");
			await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
			pollMs = Math.min(pollMs * 2, 250);
			const requestId = crypto.randomUUID();
			const receiptBody = this.#body("receipt", "receipt", {
				requestId,
				familyId: write.familyId,
				generationId: write.generationId,
				operationId: write.operationId,
				incarnation: this.incarnation,
			});
			try {
				response = await this.#http("/v1/receipt", receiptBody, requestId, deadline);
			} catch (error) {
				// A failed receipt lookup proves nothing about the write; only a fence ends the wait early.
				if (this.#failure) throw this.#failure;
				if (!(error instanceof StorageClientError)) throw error;
				response = undefined;
			}
		}
	}

	#body(operation: string, key: string, value: object): string {
		return JSON.stringify({
			schema: STORAGE_PROTOCOL_SCHEMA,
			version: STORAGE_PROTOCOL_VERSION,
			operation,
			[key]: value,
		});
	}
	#reserve(lane: Lane, bytes: number): () => void {
		if (this.#failure) throw this.#failure;
		if (
			bytes > this.#limits.requestBytes ||
			this.#active[lane] >= this.#limits[`${lane}Requests`] ||
			(lane === "write" && this.#writeBytes + bytes > this.#limits.writeBytes)
		)
			throw new StorageClientError("backpressure", "Storage client admission budget exhausted");
		this.#active[lane]++;
		if (lane === "write") this.#writeBytes += bytes;
		return () => {
			this.#active[lane]--;
			if (lane === "write") this.#writeBytes -= bytes;
		};
	}

	/** Only a stale binding fences here. Every unusable response is `outcome_unknown`: a write then
	 * reconciles through its receipt, while a read reports an ordinary retryable failure. */
	async #http(route: string, body: string, requestId: string, deadline: number): Promise<StorageProtocolResponse> {
		if (this.#failure) throw this.#failure;
		try {
			const response = await fetch(`${this.#binding.url}${route}`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.#binding.token}`, "content-type": "application/json" },
				body,
				signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
				redirect: "error",
			});
			if (response.status === 429) {
				await response.body?.cancel();
				throw new StorageClientError("backpressure", "Storage owner admission budget exhausted");
			}
			if (response.status === 401) {
				await response.body?.cancel();
				throw this.#fence("stale_incarnation", "Storage owner rejected its binding");
			}
			const reader = response.body?.getReader();
			if (!reader) throw new StorageClientError("outcome_unknown", "Storage returned no response body");
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > this.#limits.responseBytes) {
						await reader.cancel();
						throw new StorageClientError("outcome_unknown", "Storage response exceeded its byte budget");
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
			if (!bytes) throw new StorageClientError("outcome_unknown", "Storage returned an empty response");
			const result = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as StorageProtocolResponse;
			if (result.schema !== "artel.storage.protocol.response.v1" || result.version !== STORAGE_PROTOCOL_VERSION)
				throw new StorageClientError("outcome_unknown", "Storage response protocol mismatch");
			if (result.incarnation !== this.incarnation)
				throw this.#fence("stale_incarnation", "Storage owner incarnation changed");
			if ("requestId" in result && result.requestId !== requestId && result.requestId !== null)
				throw new StorageClientError("outcome_unknown", "Storage response identity mismatch");
			if (result.error) {
				if (result.error.code === "stale_incarnation") throw this.#fence(result.error.code, result.error.message);
				throw new StorageClientError(result.error.code, result.error.message);
			}
			if (!response.ok) throw new StorageClientError("outcome_unknown", "Storage HTTP outcome is unknown");
			return result;
		} catch (error) {
			if (error instanceof StorageClientError) throw error;
			throw new StorageClientError("outcome_unknown", "Storage connection failed or timed out");
		}
	}

	#fence(code: StorageErrorCode, message: string): StorageClientError {
		if (!this.#failure) {
			this.#failure = new StorageClientError(code, message);
			for (const listener of this.#listeners) listener(this.#failure);
		}
		return this.#failure;
	}
}
