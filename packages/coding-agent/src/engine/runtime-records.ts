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

const recordKey = (kind: StorageRuntimeKind, id: string) => `${kind}\0${id}`;
const scopeId = (scope: string) => `runtime_${new Bun.CryptoHasher("sha256").update(scope).digest("hex")}`;

/** Finite runtime catalog; transactions contain data and revision checks, never query expressions. */
export class RuntimeRecords {
	readonly #tails = new Map<string, Promise<void>>();
	#pending = 0;
	constructor(readonly client: StorageClient) {}

	async get(kind: StorageRuntimeKind, id: string): Promise<StorageRuntimeRecord> {
		const page = await this.client.runtimeQuery({
			selector: { type: "records", keys: [{ kind, id }] },
			maxRecords: 1,
			maxBytes: 1024 * 1024,
		});
		const record = page.records.find(row => row.kind === kind && row.id === id);
		if (!record) throw new StorageClientError("storage_error", "Exact runtime query omitted its key");
		return record;
	}
	query(
		index: StorageRuntimeIndex,
		key: Array<string | number | null>,
		cursor?: string,
		maxRecords = 100,
		after?: Array<string | number | null>,
	): Promise<StorageRuntimeQueryResponse> {
		if (cursor && after) throw new TypeError("Runtime query cannot combine cursor and after");
		return this.client.runtimeQuery({
			selector: { type: "index", index, key, ...(cursor ? { cursor } : {}), ...(after ? { after } : {}) },
			maxRecords,
			maxBytes: 1024 * 1024,
		});
	}

	async drain(): Promise<void> {
		// Fixed set of admitted family tails. Callers fence new admission before shutdown.
		await Promise.all([...this.#tails.values()]);
	}
	mutate<T>(
		scope: string,
		work: (tx: RuntimeTransaction) => Promise<T>,
		dependencies: StorageDependency[] = [],
		durability: "required" | "buffered" = "required",
	): Promise<T> {
		if (this.#pending >= 32) throw new StorageClientError("backpressure", "Runtime mutation admission exhausted");
		this.#pending++;
		const familyId = scopeId(scope);
		const run = (this.#tails.get(familyId) ?? Promise.resolve()).then(async () => {
			for (let attempt = 0; attempt < 4; attempt++) {
				const tx = new RuntimeTransaction(this);
				const result = await work(tx);
				const runtime = tx.mutation();
				if (!runtime.puts.length && !runtime.deletes.length) return result;
				const cut = await this.client.readRange({
					familyId,
					generationId: "runtime",
					maxRecords: 1,
					maxBytes: 1024,
				});
				try {
					await this.client.write({
						operationId: crypto.randomUUID(),
						familyId,
						generationId: "runtime",
						firstSeq: cut.liveThroughSeq + 1,
						entries: [],
						runtime,
						dependencies,
						durability,
					});
					return result;
				} catch (error) {
					if (!(error instanceof StorageClientError) || error.code !== "conflict" || attempt === 3) throw error;
				}
			}
			throw new StorageClientError("conflict", "Runtime mutation conflict budget exhausted");
		});
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#tails.set(familyId, tail);
		return run.finally(() => {
			this.#pending--;
			if (this.#tails.get(familyId) === tail) this.#tails.delete(familyId);
		});
	}
}

/** Read versions are checked by the RocksDB owner in the same critical section as its batch. */
export class RuntimeTransaction {
	readonly #read = new Map<string, StorageRuntimeRecord>();
	readonly #puts = new Map<string, StorageRuntimeKey & { value: StoragePayload }>();
	readonly #deletes = new Map<string, StorageRuntimeKey>();
	constructor(readonly records: RuntimeRecords) {}

	async get<T extends object>(kind: StorageRuntimeKind, id: string): Promise<T | undefined> {
		const key = recordKey(kind, id);
		if (this.#deletes.has(key)) return undefined;
		const pending = this.#puts.get(key);
		if (pending) return pending.value as T;
		let row = this.#read.get(key);
		if (!row) {
			row = await this.records.get(kind, id);
			this.#read.set(key, row);
			this.#checkBudget();
		}
		return row.value ? (structuredClone(row.value) as T) : undefined;
	}
	async put(kind: StorageRuntimeKind, id: string, value: object): Promise<void> {
		await this.get(kind, id);
		if (this.#read.size > 100) throw new StorageClientError("backpressure", "Runtime atomic record budget exceeded");
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
		const page = await this.records.query(index, key);
		if (page.nextCursor)
			throw new StorageClientError("backpressure", "Atomic runtime mutation exceeds its bounded index page");
		for (const row of page.records) {
			const id = recordKey(row.kind, row.id);
			if (!this.#read.has(id)) this.#read.set(id, row);
		}
		this.#checkBudget();
		return page.records.flatMap(row => {
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
		if (this.#read.size > 100) throw new StorageClientError("backpressure", "Runtime atomic record budget exceeded");
	}
	mutation(): StorageRuntimeMutation {
		return {
			checks: [...this.#read.values()].map(({ kind, id, revision }) => ({ kind, id, revision })),
			puts: [...this.#puts.values()],
			deletes: [...this.#deletes.values()],
		};
	}
}
