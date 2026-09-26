import { type StorageClient, StorageClientError } from "../session/storage-client";
import type {
	StorageDependency,
	StoragePayload,
	StorageRuntimeIndex,
	StorageRuntimeKey,
	StorageRuntimeKind,
	StorageRuntimeMutation,
	StorageRuntimeQueryResponse,
	StorageRuntimeRecord,
} from "../session/storage-protocol";
import { EngineTargetError } from "./contracts";

const recordKey = (kind: StorageRuntimeKind, id: string) => `${kind}\0${id}`;
const scopeId = (scope: string) => `runtime_${new Bun.CryptoHasher("sha256").update(scope).digest("hex")}`;
// A family runs one mutation at a time; the rest wait, oldest first, in its tail. These bound only that waiting
// memory, so a caller is refused just when a runaway scope or Engine has queued far beyond any real turn.
const PENDING_LIMITS = { required: 1024, buffered: 4096 } as const;
const PER_SCOPE_PENDING_LIMITS = { required: 64, buffered: 256 } as const;
// Family heads that may run at once; a head beyond them waits, oldest first, for a finishing head's slot.
const RUNNING_LIMITS = { required: 8, buffered: 32 } as const;
// Owner records are at most 256 KiB, so seven exact keys fit the 2 MiB client response budget.
const BATCH_KEYS = 7;
const BATCH_BYTES = 2 * 1024 * 1024;
// Least recently written families and counters leave the caches first; they read their row again.
const CACHED_ROWS = 1024;

/** Finite runtime catalog; transactions contain data and revision checks, never query expressions. */
export class RuntimeRecords {
	readonly #tails = new Map<string, Promise<void>>();
	#eventTail = Promise.resolve();
	readonly #pendingByFamily = new Map<string, { required: number; buffered: number }>();
	#pending = { required: 0, buffered: 0 };
	readonly #running = { required: 0, buffered: 0 };
	/** Family heads waiting for a running slot, oldest first. A finishing head hands its slot to the first. */
	readonly #runQueue = { required: [] as Array<() => void>, buffered: [] as Array<() => void> };
	/** Last applied runtime seq per family. A family writes through one tail, so its receipt is the next cut. */
	readonly #cuts = new Map<string, number>();
	/** Committed event counter rows. Only event-chain holders write them, so under the chain they are current. */
	readonly #counters = new Map<string, StorageRuntimeRecord>();
	constructor(readonly client: StorageClient) {}

	async get(kind: StorageRuntimeKind, id: string, control = false): Promise<StorageRuntimeRecord> {
		return (await this.getMany([{ kind, id }], control))[0];
	}
	/** Exact lookups, one owner round trip per batch; the owner answers every key, present or absent. */
	async getMany(keys: StorageRuntimeKey[], control = false): Promise<StorageRuntimeRecord[]> {
		const records: StorageRuntimeRecord[] = [];
		for (let start = 0; start < keys.length; start += BATCH_KEYS) {
			const batch = keys.slice(start, start + BATCH_KEYS);
			const page = await this.client.runtimeQuery(
				{ selector: { type: "records", keys: batch }, maxRecords: batch.length, maxBytes: BATCH_BYTES },
				control,
			);
			for (const { kind, id } of batch) {
				const record = page.records.find(row => row.kind === kind && row.id === id);
				if (!record) throw new StorageClientError("storage_error", "Exact runtime query omitted its key");
				records.push(record);
			}
		}
		return records;
	}
	counter(id: string): StorageRuntimeRecord | undefined {
		return this.#counters.get(id);
	}
	query(
		index: StorageRuntimeIndex,
		key: Array<string | number | null>,
		cursor?: string,
		maxRecords = 100,
		after?: Array<string | number | null>,
		control = false,
	): Promise<StorageRuntimeQueryResponse> {
		if (cursor && after) throw new TypeError("Runtime query cannot combine cursor and after");
		return this.client.runtimeQuery(
			{
				selector: { type: "index", index, key, ...(cursor ? { cursor } : {}), ...(after ? { after } : {}) },
				maxRecords,
				maxBytes: 1024 * 1024,
			},
			control,
		);
	}

	async drain(): Promise<void> {
		// Fixed set of admitted family tails. Callers fence new admission before shutdown.
		await Promise.all([...this.#tails.values()]);
	}
	async #reserveEvents(): Promise<() => void> {
		// ponytail: serialize the shared event counter; owner-assigned sequences if throughput requires it.
		const previous = this.#eventTail;
		const next = Promise.withResolvers<void>();
		this.#eventTail = next.promise;
		await previous;
		return () => next.resolve();
	}
	/**
	 * No deadline of its own: every running head is bounded by its storage requests' deadlines and a fence fails it
	 * at once, so the wait is too. A timer here would only turn a slow owner back into refused mutations.
	 */
	async #takeSlot(durability: "required" | "buffered"): Promise<void> {
		if (this.#running[durability] < RUNNING_LIMITS[durability]) {
			this.#running[durability]++;
			return;
		}
		const turn = Promise.withResolvers<void>();
		this.#runQueue[durability].push(turn.resolve);
		await turn.promise;
	}
	#handOverSlot(durability: "required" | "buffered"): void {
		const next = this.#runQueue[durability].shift();
		if (next) next();
		else this.#running[durability]--;
	}
	mutate<T>(
		scope: string,
		work: (tx: RuntimeTransaction) => Promise<T>,
		dependencies: StorageDependency[] = [],
		durability: "required" | "buffered" = "required",
	): Promise<T> {
		const familyId = scopeId(scope);
		const familyPending = this.#pendingByFamily.get(familyId) ?? { required: 0, buffered: 0 };
		if (
			this.#pending[durability] >= PENDING_LIMITS[durability] ||
			familyPending[durability] >= PER_SCOPE_PENDING_LIMITS[durability]
		)
			throw new StorageClientError("backpressure", "Runtime mutation admission exhausted");
		this.#pending[durability]++;
		familyPending[durability]++;
		this.#pendingByFamily.set(familyId, familyPending);
		let releaseEvents: (() => void) | undefined;
		const run = (this.#tails.get(familyId) ?? Promise.resolve())
			.then(() => this.#takeSlot(durability))
			.then(async () => {
				for (let attempt = 0; attempt < 4; attempt++) {
					// Every mutation depends on its read/check prefix. Keep those reads on the
					// reserved lane so observer traffic cannot reject a content write midway.
					let tx = new RuntimeTransaction(this, true);
					let result = await work(tx);
					if (tx.sequenced && !releaseEvents) {
						// The global event cursor must follow commit order, but reads need not hold it:
						// replay the work under the chain on the rows just read, so the chain covers only
						// numbering and the write. The owner still checks every revision. A conflict keeps
						// the reservation, so a busy neighbor cannot starve the retry.
						releaseEvents = await this.#reserveEvents();
						tx = new RuntimeTransaction(this, true, tx);
						result = await work(tx);
					}
					const runtime = tx.mutation();
					if (!runtime.puts.length && !runtime.deletes.length) return result;
					const cached = this.#cuts.get(familyId);
					const cut =
						cached ??
						(
							await this.client.readRange(
								{ familyId, generationId: "runtime", maxRecords: 1, maxBytes: 1024 },
								true,
							)
						).liveThroughSeq;
					try {
						const receipt = await this.client.write(
							{
								operationId: crypto.randomUUID(),
								familyId,
								generationId: "runtime",
								firstSeq: cut + 1,
								entries: [],
								runtime,
								dependencies,
								durability,
							},
							durability === "required",
						);
						this.#cuts.delete(familyId);
						this.#cuts.set(familyId, receipt.throughSeq);
						if (this.#cuts.size > CACHED_ROWS) this.#cuts.delete(this.#cuts.keys().next().value!);
						for (const id of tx.counters) {
							// The owner bumps a record revision by one per applied put.
							const check = runtime.checks.find(row => row.kind === "metadata" && row.id === id);
							const put = runtime.puts.find(row => row.kind === "metadata" && row.id === id);
							this.#counters.delete(id);
							if (check && put) this.#counters.set(id, { ...put, revision: (check.revision ?? 0) + 1 });
						}
						if (this.#counters.size > CACHED_ROWS) this.#counters.delete(this.#counters.keys().next().value!);
						return result;
					} catch (error) {
						// A rejected write leaves the cached cut and counters unproven; read them again.
						this.#cuts.delete(familyId);
						this.#counters.clear();
						const retry =
							error instanceof StorageClientError &&
							(error.code === "conflict" || (error.code === "sequence_gap" && cached !== undefined));
						if (!retry || attempt === 3) throw error;
					}
				}
				throw new StorageClientError("conflict", "Runtime mutation conflict budget exhausted");
			})
			.finally(() => {
				releaseEvents?.();
				this.#handOverSlot(durability);
			});
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#tails.set(familyId, tail);
		return run.finally(() => {
			this.#pending[durability]--;
			familyPending[durability]--;
			if (familyPending.required === 0 && familyPending.buffered === 0) this.#pendingByFamily.delete(familyId);
			if (this.#tails.get(familyId) === tail) this.#tails.delete(familyId);
		});
	}
}

/** Read versions are checked by the RocksDB owner in the same critical section as its batch. */
export class RuntimeTransaction {
	readonly #read = new Map<string, StorageRuntimeRecord>();
	readonly #puts = new Map<string, StorageRuntimeKey & { value: StoragePayload }>();
	readonly #deletes = new Map<string, StorageRuntimeKey>();
	readonly #pages = new Map<string, StorageRuntimeRecord[]>();
	readonly #counters = new Set<string>();
	readonly #seedRows?: ReadonlyMap<string, StorageRuntimeRecord>;
	readonly #seedPages?: ReadonlyMap<string, StorageRuntimeRecord[]>;
	/**
	 * @param seed an earlier run of the same work in the same family tail: its rows and index pages
	 * answer this replay without owner round trips, and the owner still checks every revision.
	 */
	constructor(
		readonly records: RuntimeRecords,
		readonly control = false,
		seed?: RuntimeTransaction,
	) {
		if (!seed) return;
		this.#seedRows = seed.#read;
		this.#seedPages = seed.#pages;
	}

	/** Event counters this work allocated from; `RuntimeRecords.mutate` commits it under the event chain. */
	get counters(): ReadonlySet<string> {
		return this.#counters;
	}
	get sequenced(): boolean {
		return this.#counters.size > 0;
	}
	/** Marks event counters. Under the chain their last committed rows are current and need no read. */
	sequence(...ids: string[]): void {
		for (const id of ids) {
			this.#counters.add(id);
			const key = recordKey("metadata", id);
			const known = this.records.counter(id);
			if (known && !this.#read.has(key)) this.#read.set(key, known);
		}
	}
	/** Loads unread keys in one owner round trip; a replay takes its seed's rows instead. */
	async prefetch(keys: StorageRuntimeKey[]): Promise<void> {
		const missing = new Map<string, StorageRuntimeKey>();
		for (const { kind, id } of keys) {
			const key = recordKey(kind, id);
			if (this.#read.has(key) || this.#puts.has(key) || this.#deletes.has(key)) continue;
			const seeded = this.#seedRows?.get(key);
			if (seeded) this.#read.set(key, seeded);
			else missing.set(key, { kind, id });
		}
		if (missing.size)
			for (const row of await this.records.getMany([...missing.values()], this.control))
				this.#read.set(recordKey(row.kind, row.id), row);
		this.#checkBudget();
	}
	async get<T extends object>(kind: StorageRuntimeKind, id: string): Promise<T | undefined> {
		const key = recordKey(kind, id);
		if (this.#deletes.has(key)) return undefined;
		const pending = this.#puts.get(key);
		if (pending) return pending.value as T;
		if (!this.#read.has(key)) await this.prefetch([{ kind, id }]);
		const row = this.#read.get(key)!;
		return row.value ? (structuredClone(row.value) as T) : undefined;
	}
	/** Stages a record that must not exist yet; the owner checks its absence without a prior read. */
	async create(kind: StorageRuntimeKind, id: string, value: object): Promise<void> {
		const key = recordKey(kind, id);
		if (!this.#read.has(key)) this.#read.set(key, { kind, id, revision: null, value: null });
		await this.put(kind, id, value);
	}
	async put(kind: StorageRuntimeKind, id: string, value: object): Promise<void> {
		await this.get(kind, id);
		if (this.#read.size > 100) throw new EngineTargetError("restore_budget", "Runtime atomic record budget exceeded");
		const key = recordKey(kind, id);
		this.#deletes.delete(key);
		const payload = JSON.parse(
			JSON.stringify(value, (_key, item: unknown) => {
				if (typeof item === "number" && !Number.isFinite(item))
					throw new TypeError("Runtime values must be finite JSON");
				return item;
			}),
		) as StoragePayload;
		this.#puts.set(key, { kind, id, value: payload });
	}
	async delete(kind: StorageRuntimeKind, id: string): Promise<void> {
		await this.get(kind, id);
		const key = recordKey(kind, id);
		this.#puts.delete(key);
		this.#deletes.set(key, { kind, id });
	}
	async query<T extends object>(index: StorageRuntimeIndex, key: Array<string | number | null>): Promise<T[]> {
		// A replay reuses its seed's page: the atomic indexes read here list rows of this family,
		// which only this family tail writes, and each returned row is still revision-checked.
		const pageKey = JSON.stringify([index, key]);
		let records = this.#seedPages?.get(pageKey);
		if (!records) {
			const page = await this.records.query(index, key, undefined, 100, undefined, this.control);
			if (page.nextCursor)
				throw new EngineTargetError("restore_budget", "Atomic runtime mutation exceeds its bounded index page");
			records = page.records;
		}
		this.#pages.set(pageKey, records);
		for (const row of records) {
			const id = recordKey(row.kind, row.id);
			if (!this.#read.has(id)) this.#read.set(id, row);
		}
		this.#checkBudget();
		return records.flatMap(row => {
			const id = recordKey(row.kind, row.id);
			if (this.#deletes.has(id)) return [];
			const value = this.#puts.get(id)?.value ?? row.value;
			return value ? [structuredClone(value) as T] : [];
		});
	}
	staged<T extends object>(kind: StorageRuntimeKind): Array<{ id: string; value: T | null }> {
		return [
			...[...this.#puts.values()]
				.filter(row => row.kind === kind)
				.map(row => ({ id: row.id, value: structuredClone(row.value) as T })),
			...[...this.#deletes.values()].filter(row => row.kind === kind).map(row => ({ id: row.id, value: null })),
		];
	}
	#checkBudget(): void {
		if (this.#read.size > 100) throw new EngineTargetError("restore_budget", "Runtime atomic record budget exceeded");
	}
	mutation(): StorageRuntimeMutation {
		return {
			checks: [...this.#read.values()].map(({ kind, id, revision }) => ({ kind, id, revision })),
			puts: [...this.#puts.values()],
			deletes: [...this.#deletes.values()],
		};
	}
}
