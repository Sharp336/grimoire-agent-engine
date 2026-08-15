import { logger } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";
import { connectSharedMnemopiEmbedWorker } from "./embed-shared-client";
import { acquireGlobalMnemopiEmbedWorker } from "./embed-shared-daemon";

/**
 * Client-side handle for the mnemopi embedding transport. Production uses a
 * machine-global broker that owns one Bun child per model/cache key; broker
 * failure falls back to a private child owned by this process. Both paths keep
 * `onnxruntime-node`'s NAPI constructor + finalizer outside the main agent
 * address space, whose Windows shutdown path otherwise segfaults Bun (issue
 * #3031; the mnemopi sibling of the tiny-model fix from #1606 / #1607).
 */
export type MnemopiEmbedWorkerHandle = WorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>;

type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

/**
 * Hidden subcommand on the main CLI that boots the mnemopi embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/**
 * Spawn the mnemopi embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnMnemopiEmbedWorker}.
 * The child inherits the parent env verbatim — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and our `loadFastembed()` reads the same `OMP_*`
 * runtime-install knobs the parent uses.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "mnemopi embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	// Embed keeps its own guarded `proc.send` (neutralizes only the synchronous
	// throw, not the async EPIPE rejection) rather than the shared `safeSend`
	// the other workers use — behaviour preserved verbatim.
	return createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
		try {
			proc.send(message);
		} catch (error) {
			logger.debug("mnemopi-embed: send to subprocess failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

export function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

type MnemopiEmbedWorkerFactory = () => MnemopiEmbedWorkerHandle | Promise<MnemopiEmbedWorkerHandle>;

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch through the selected transport and yields
 * the resulting vectors in one asynchronous batch. Fastembed's iterator is
 * already collected on the child side, so serializing each native batch over
 * the broker or private IPC path would not improve throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

/**
 * Upper bound on a steady-state embed IPC round-trip. Initialization is
 * intentionally exempt: bundled installs may spend several minutes installing
 * fastembed and bootstrapping the model, and killing that worker can strand the
 * runtime install lock. Once initialization succeeds, a longer embed stall
 * means a hung native runtime (issue #4792) that would otherwise pin whatever
 * awaits the embed — a turn's memory recall or the headless shutdown
 * consolidation — indefinitely, leaving the process alive with an unreaped
 * `__omp_worker_mnemopi_embed` child (issue #7352). On expiry the embed fails
 * and the worker is SIGKILL-reaped so the next request respawns a fresh one.
 */
const EMBED_REQUEST_TIMEOUT_MS = 120_000;

/** Race marker for {@link MnemopiEmbedClient.#awaitRequest}. */
const REQUEST_TIMED_OUT = Symbol("mnemopi.embed.timedOut");

export class MnemopiEmbedClient {
	#worker: MnemopiEmbedWorkerHandle | null = null;
	#workerPromise: Promise<MnemopiEmbedWorkerHandle> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#workerGeneration = 0;
	#spawnWorker: MnemopiEmbedWorkerFactory;
	#requestTimeoutMs: number;

	constructor(
		spawnWorker: MnemopiEmbedWorkerFactory = spawnMnemopiEmbedWorker,
		requestTimeoutMs: number = EMBED_REQUEST_TIMEOUT_MS,
	) {
		this.#spawnWorker = spawnWorker;
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	/**
	 * Load the named fastembed model through the selected transport. Resolves to
	 * a thin wrapper whose `embed()` uses the same broker connection or private
	 * worker, or `null` when model initialization fails. One client reuses its
	 * transport; the broker independently keys native children by resolved
	 * (model, cacheDir).
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		try {
			const generation = this.#workerGeneration;
			const worker = await this.#ensureWorker();
			if (generation !== this.#workerGeneration || worker !== this.#worker) {
				throw new Error("mnemopi embed worker terminated during startup");
			}
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("mnemopi-embed: init failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	async terminate(): Promise<void> {
		this.#workerGeneration += 1;
		const worker = this.#worker;
		this.#worker = null;
		this.#workerPromise = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("mnemopi embed worker terminated"));
		}
		this.#pending.clear();
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	async #embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const generation = this.#workerGeneration;
		const worker = await this.#ensureWorker();
		if (generation !== this.#workerGeneration || worker !== this.#worker) {
			throw new Error("mnemopi embed worker terminated during startup");
		}
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#pending.set(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await this.#awaitRequest(promise);
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#pending.delete(id);
		}
	}

	/**
	 * Await one steady-state embed reply, bounded by
	 * {@link EMBED_REQUEST_TIMEOUT_MS}. The timeout timer is `unref`'d so a
	 * pending request never keeps the parent event loop alive on its own (the
	 * awaiting caller does). On expiry the wedged worker is SIGKILL-reaped via
	 * {@link terminate} — faulting any other in-flight request and letting the
	 * next call respawn a fresh child — before the request rejects, so a hung
	 * native runtime cannot pin a turn's recall or shutdown consolidation
	 * forever (issue #7352).
	 */
	async #awaitRequest<T>(promise: Promise<T>): Promise<T> {
		const { promise: timedOut, resolve: fire } = Promise.withResolvers<typeof REQUEST_TIMED_OUT>();
		const timer = setTimeout(() => fire(REQUEST_TIMED_OUT), this.#requestTimeoutMs);
		timer.unref();
		try {
			const winner = await Promise.race([promise, timedOut]);
			if (winner === REQUEST_TIMED_OUT) {
				void this.terminate();
				throw new Error("mnemopi embed worker request timed out");
			}
			return winner;
		} finally {
			clearTimeout(timer);
		}
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	async #ensureWorker(): Promise<MnemopiEmbedWorkerHandle> {
		if (this.#worker) return this.#worker;
		if (this.#workerPromise) return this.#workerPromise;
		const generation = this.#workerGeneration;
		const pending = Promise.resolve(this.#spawnWorker()).then(async worker => {
			if (generation !== this.#workerGeneration) {
				await worker.terminate().catch(() => {});
				throw new Error("mnemopi embed worker terminated during startup");
			}
			this.#worker = worker;
			this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
			this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
			return worker;
		});
		this.#workerPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.#workerPromise === pending) this.#workerPromise = null;
		}
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (pending.kind === "init") {
			if (message.type === "ready") pending.resolve(true);
			else {
				if (message.type === "error")
					logger.debug("mnemopi-embed: worker returned error", { error: message.error });
				else logger.debug("mnemopi-embed: unexpected response to init", { response: message.type });
				pending.resolve(false);
			}
			return;
		}
		if (message.type === "vectors") pending.resolve(message.vectors);
		else if (message.type === "error") {
			logger.debug("mnemopi-embed: worker returned error", { error: message.error });
			pending.resolve(new Error(message.error));
		} else pending.resolve(new Error(`mnemopi embed worker returned unexpected ${message.type} response`));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mnemopi-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const mnemopiEmbedClient = new MnemopiEmbedClient(() =>
	connectSharedMnemopiEmbedWorker(spawnMnemopiEmbedWorker, acquireGlobalMnemopiEmbedWorker),
);

export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMnemopiEmbedSubprocess()), "mnemopi embed worker", timeoutMs);
}
