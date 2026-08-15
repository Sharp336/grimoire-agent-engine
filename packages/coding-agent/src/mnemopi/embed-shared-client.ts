import type { MnemopiEmbedWorkerHandle } from "./embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

export type SharedMnemopiEmbedWorkerAcquire = () => Promise<MnemopiEmbedWorkerHandle>;

class SharedFallbackMnemopiEmbedWorker implements MnemopiEmbedWorkerHandle {
	readonly #spawnPrivate: () => MnemopiEmbedWorkerHandle;
	readonly #pending = new Map<string, MnemopiEmbedWorkerInbound>();
	readonly #messageListeners = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	readonly #errorListeners = new Set<(error: Error) => void>();
	readonly #retiring: Promise<void>[] = [];
	#active: MnemopiEmbedWorkerHandle;
	#unsubscribeMessage: () => void = () => {};
	#unsubscribeError: () => void = () => {};
	#usingPrivate = false;
	#terminated = false;

	constructor(shared: MnemopiEmbedWorkerHandle, spawnPrivate: () => MnemopiEmbedWorkerHandle) {
		this.#active = shared;
		this.#spawnPrivate = spawnPrivate;
		this.#attach(shared);
	}

	send(message: MnemopiEmbedWorkerInbound): void {
		if (this.#terminated) throw new Error("mnemopi embed worker terminated");
		this.#pending.set(message.id, message);
		try {
			this.#active.send(message);
		} catch (error) {
			this.#handleError(error instanceof Error ? error : new Error(String(error)), this.#active);
		}
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#messageListeners.add(handler);
		return () => this.#messageListeners.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorListeners.add(handler);
		return () => this.#errorListeners.delete(handler);
	}

	async terminate(): Promise<void> {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#unsubscribeMessage();
		this.#unsubscribeError();
		this.#pending.clear();
		await Promise.all([this.#active.terminate(), ...this.#retiring]);
		this.#messageListeners.clear();
		this.#errorListeners.clear();
	}

	#attach(worker: MnemopiEmbedWorkerHandle): void {
		this.#unsubscribeMessage = worker.onMessage(message => {
			if (message.type !== "log") this.#pending.delete(message.id);
			for (const listener of this.#messageListeners) listener(message);
		});
		this.#unsubscribeError = worker.onError(error => this.#handleError(error, worker));
	}

	#handleError(error: Error, worker: MnemopiEmbedWorkerHandle): void {
		if (this.#terminated || worker !== this.#active) return;
		if (this.#usingPrivate) {
			for (const listener of this.#errorListeners) listener(error);
			return;
		}
		this.#usingPrivate = true;
		this.#unsubscribeMessage();
		this.#unsubscribeError();
		this.#retiring.push(worker.terminate().catch(() => {}));
		try {
			const fallback = this.#spawnPrivate();
			this.#active = fallback;
			this.#attach(fallback);
			for (const message of this.#pending.values()) fallback.send(message);
		} catch (fallbackError) {
			const failure = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
			for (const listener of this.#errorListeners) listener(failure);
		}
	}
}

/** Prefer the machine-global broker, falling back privately at acquisition or after a broker transport failure. */
export async function connectSharedMnemopiEmbedWorker(
	spawnPrivate: () => MnemopiEmbedWorkerHandle,
	acquireShared: SharedMnemopiEmbedWorkerAcquire,
): Promise<MnemopiEmbedWorkerHandle> {
	try {
		return new SharedFallbackMnemopiEmbedWorker(await acquireShared(), spawnPrivate);
	} catch {
		return spawnPrivate();
	}
}
