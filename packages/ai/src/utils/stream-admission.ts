import { AsyncLocalStorage } from "node:async_hooks";

export interface StreamAdmissionLimits {
	maxEvents: number;
	maxQueuedBytes: number;
	maxEventBytes: number;
	maxIngressBytes: number;
	maxChunkBytes: number;
	maxLocalWork: number;
	maxProviderEvents: number;
}

export const DEFAULT_STREAM_ADMISSION_LIMITS: Readonly<StreamAdmissionLimits> = Object.freeze({
	maxEvents: 1024,
	maxQueuedBytes: 4 * 1024 * 1024,
	maxEventBytes: 1024 * 1024,
	maxIngressBytes: 16 * 1024 * 1024,
	maxChunkBytes: 1024 * 1024,
	maxLocalWork: 32,
	maxProviderEvents: 32768,
});

export class StreamAdmissionError extends Error {
	constructor(readonly limit: keyof StreamAdmissionLimits) {
		super(`Stream admission capacity exceeded: ${limit}`);
		this.name = "StreamAdmissionError";
	}
}

const currentAdmission = new AsyncLocalStorage<StreamAdmission>();

/** One native execution scope; no storage durability or pause-state ownership. */
export class StreamAdmission {
	readonly limits: Readonly<StreamAdmissionLimits>;
	readonly #controller = new AbortController();
	#events = 0;
	#bytes = 0;
	#ingressBytes = 0;
	#localWork = 0;
	#providerEvents = 0;
	#peakEvents = 0;
	#peakBytes = 0;
	#peakLocalWork = 0;
	#listeners = new Set<(error: StreamAdmissionError) => void>();
	#error: StreamAdmissionError | undefined;

	constructor(limits: Partial<StreamAdmissionLimits> = {}) {
		this.limits = Object.freeze({ ...DEFAULT_STREAM_ADMISSION_LIMITS, ...limits });
		for (const [key, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid stream admission ${key}`);
		}
		if (this.limits.maxEventBytes > this.limits.maxQueuedBytes) {
			throw new RangeError("maxEventBytes must not exceed maxQueuedBytes");
		}
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get metrics() {
		return {
			events: this.#events,
			bytes: this.#bytes,
			ingressBytes: this.#ingressBytes,
			localWork: this.#localWork,
			providerEvents: this.#providerEvents,
			peakEvents: this.#peakEvents,
			peakBytes: this.#peakBytes,
			peakLocalWork: this.#peakLocalWork,
			aborted: this.#error?.limit,
		};
	}

	check(): void {
		if (this.#error) throw this.#error;
	}

	#overflow(limit: keyof StreamAdmissionLimits): never {
		this.#error ??= new StreamAdmissionError(limit);
		// Failure lives out of band: no queued event or serialized message is
		// needed to notify consumers after their data capacity is exhausted.
		for (const listener of this.#listeners) {
			try {
				listener(this.#error);
			} catch {
				/* A cleanup hook cannot suppress the capacity failure. */
			}
		}
		this.#listeners.clear();
		this.#controller.abort(this.#error);
		throw this.#error;
	}

	onAbort(listener: (error: StreamAdmissionError) => void): () => void {
		this.check();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	reserve(event: unknown): () => void {
		this.check();
		if (this.#events >= this.limits.maxEvents) this.#overflow("maxEvents");
		const bytes = this.#eventBytes(event);
		if (this.#bytes + bytes > this.limits.maxQueuedBytes) this.#overflow("maxQueuedBytes");
		this.#events++;
		this.#bytes += bytes;
		this.#peakEvents = Math.max(this.#peakEvents, this.#events);
		this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#events--;
			this.#bytes -= bytes;
		};
	}

	#eventBytes(event: unknown): number {
		let bytes = 0;
		const seen = new Set<object>();
		const visit = (value: unknown, depth: number): void => {
			if (depth > 64) this.#overflow("maxEventBytes");
			bytes += typeof value === "string" ? value.length * 4 + 16 : 64;
			if (bytes > this.limits.maxEventBytes) this.#overflow("maxEventBytes");
			if (typeof value !== "object" || value === null || seen.has(value)) return;
			seen.add(value);
			for (const key of Object.keys(value)) {
				// Mutable provider partials are shared working state, bounded by
				// ingress separately. Never serialize a growing partial per token.
				if (key === "partial") continue;
				visit(key, depth + 1);
				visit((value as Record<string, unknown>)[key], depth + 1);
			}
		};
		visit(event, 0);
		return bytes;
	}

	admitIngress(bytes: number): void {
		this.check();
		if (bytes > this.limits.maxChunkBytes) this.#overflow("maxChunkBytes");
		if (this.#ingressBytes + bytes > this.limits.maxIngressBytes) this.#overflow("maxIngressBytes");
		this.#ingressBytes += bytes;
	}

	admitProviderEvent(): void {
		this.check();
		if (this.#providerEvents >= this.limits.maxProviderEvents) this.#overflow("maxProviderEvents");
		this.#providerEvents++;
	}

	reserveLocalWork(): () => void {
		this.check();
		if (this.#localWork >= this.limits.maxLocalWork) this.#overflow("maxLocalWork");
		this.#localWork++;
		this.#peakLocalWork = Math.max(this.#peakLocalWork, this.#localWork);
		return () => {
			this.#localWork--;
		};
	}
}

export function getStreamAdmission(): StreamAdmission | undefined {
	return currentAdmission.getStore();
}

export function runWithStreamAdmission<T>(admission: StreamAdmission, work: () => T): T {
	admission.check();
	return currentAdmission.run(admission, work);
}

/** Reserve retained callback data before adding work to a serial promise chain. */
export function enqueueStreamWork<T>(
	admission: StreamAdmission | undefined,
	tail: Promise<unknown>,
	payload: unknown,
	work: () => Promise<T>,
): Promise<T> {
	const release = admission?.reserve(payload);
	return tail
		.then(() => {
			admission?.check();
			return work();
		})
		.finally(() => release?.());
}

/** Demand-driven, one chunk in flight; enforce the limit before SSE decoding. */
export function boundedProviderBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const admission = getStreamAdmission();
	if (!admission) return body;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					admission.check();
					const next = await reader.read();
					if (next.done) {
						reader.releaseLock();
						controller.close();
						return;
					}
					admission.admitIngress(next.value.byteLength);
					controller.enqueue(next.value);
				} catch (error) {
					await reader.cancel(error).catch(() => {});
					reader.releaseLock();
					controller.error(error);
				}
			},
			async cancel(reason) {
				await reader.cancel(reason);
				reader.releaseLock();
			},
		},
		{ highWaterMark: 0 },
	);
}
