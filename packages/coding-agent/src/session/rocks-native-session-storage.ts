import {
	type NativeSessionCheckpoint,
	type NativeSessionPosition,
	type NativeSessionRead,
	type NativeSessionStorage,
	type NativeSessionTicket,
	NativeSessionWriteRejectedError,
} from "./native-session-storage";
import type { SessionEntry } from "./session-entries";
import { type StorageClient, StorageClientError } from "./storage-client";
import type { StorageEntry, StoragePayload, StorageReadSuccessResponse, StorageWrite } from "./storage-protocol";

export function parseNativeSessionLocator(locator: string): { familyId: string; generationId: string } {
	const match = /^native:([^/]+)\/([^/]+)$/.exec(locator);
	if (!match) throw new Error("Invalid native session locator");
	const familyId = decodeURIComponent(match[1]);
	const generationId = decodeURIComponent(match[2]);
	if (!familyId || !generationId) throw new Error("Invalid native session locator scope");
	return { familyId, generationId };
}

function nativeEntry(entry: SessionEntry): StorageEntry {
	return {
		entryId: entry.id,
		parentId: entry.parentId,
		kind: entry.type,
		payload: JSON.parse(JSON.stringify(entry)) as StoragePayload,
	};
}

function decodeEntry(entry: StorageEntry): SessionEntry {
	const value = entry.payload;
	if (
		value.id !== entry.entryId ||
		value.parentId !== entry.parentId ||
		value.type !== entry.kind ||
		typeof value.timestamp !== "string"
	) {
		throw new Error("Native entry identity does not match its storage envelope");
	}
	return value as unknown as SessionEntry;
}

function checkpointFrom(page: StorageReadSuccessResponse): NativeSessionCheckpoint {
	const value = page.state?.native as NativeSessionCheckpoint | undefined;
	if (
		value?.schema !== "omp.native.context.v1" ||
		!value.header ||
		typeof value.header.id !== "string" ||
		typeof value.header.cwd !== "string" ||
		!value.prefix?.settings ||
		!Array.isArray(value.prefix.entryTypes) ||
		!Array.isArray(value.prefix.settings.injectedTtsrRules) ||
		!value.prefix.settings.models ||
		!value.prefix.credentialPins ||
		(value.leafId !== null && typeof value.leafId !== "string") ||
		(value.contextStartId !== null && typeof value.contextStartId !== "string") ||
		page.head?.leafId !== value.leafId ||
		page.head?.contextAnchors?.startEntryId !== value.contextStartId
	) {
		throw new Error("Missing or incompatible native session checkpoint");
	}
	return value;
}

/** Structured native consumer of the one shared bounded Engine client. */
export class RocksNativeSessionStorage implements NativeSessionStorage {
	readonly locator: string;
	#client: StorageClient;
	#familyId: string;
	#generationId: string;
	#throughSeq = 0;
	#failure?: Error;
	#pendingWrites = 0;
	#pendingBytes = 0;
	#writeTail: Promise<void> = Promise.resolve();
	#maxPendingWrites: number;
	#maxPendingBytes: number;
	#conditionalWrite = false;
	#maxRecords: number;
	#maxBytes: number;

	constructor(
		client: StorageClient,
		familyId: string,
		generationId: string,
		limits: { maxRecords?: number; maxBytes?: number; maxPendingWrites?: number; maxPendingBytes?: number } = {},
	) {
		const { maxRecords = 128, maxBytes = 1_048_576, maxPendingWrites = 32, maxPendingBytes = 8_388_608 } = limits;
		if (
			!familyId ||
			!generationId ||
			[maxRecords, maxBytes, maxPendingWrites, maxPendingBytes].some(
				value => !Number.isSafeInteger(value) || value < 1,
			)
		)
			throw new Error("Invalid native storage scope or read bounds");
		this.#client = client;
		this.#familyId = familyId;
		this.#generationId = generationId;
		this.#maxRecords = maxRecords;
		this.#maxBytes = maxBytes;
		this.#maxPendingWrites = maxPendingWrites;
		this.#maxPendingBytes = maxPendingBytes;
		this.locator = `native:${encodeURIComponent(familyId)}/${encodeURIComponent(generationId)}`;
	}

	#position(throughSeq = this.#throughSeq): NativeSessionPosition {
		return {
			familyId: this.#familyId,
			generationId: this.#generationId,
			throughSeq,
			incarnation: this.#client.incarnation,
		};
	}

	append(
		entries: readonly SessionEntry[],
		checkpoint: NativeSessionCheckpoint,
		durability: "buffered" | "required",
	): NativeSessionTicket {
		return this.#submit(entries, checkpoint, durability);
	}

	initializeFork(source: NativeSessionPosition, checkpoint: NativeSessionCheckpoint): NativeSessionTicket {
		if (
			this.#throughSeq !== 0 ||
			source.familyId !== this.#familyId ||
			source.generationId === this.#generationId ||
			source.incarnation !== this.#client.incarnation
		)
			throw new Error("Native fork requires a fresh generation in the same family and incarnation");
		return this.#submit([], checkpoint, "required", undefined, source);
	}

	rewrite(
		entries: readonly SessionEntry[],
		deletedIds: readonly string[],
		checkpoint: NativeSessionCheckpoint,
		appended: readonly SessionEntry[] = [],
	): NativeSessionTicket {
		return this.#submit(appended, checkpoint, "required", [
			...entries.map(entry => ({ entryId: entry.id, entry: nativeEntry(entry) })),
			...deletedIds.map(entryId => ({ entryId, entry: null })),
		]);
	}

	#submit(
		entries: readonly SessionEntry[],
		checkpoint: NativeSessionCheckpoint,
		durability: "buffered" | "required",
		nativeEdits?: StorageWrite["nativeEdits"],
		forkSource?: NativeSessionPosition,
	): NativeSessionTicket {
		if (this.#failure) throw this.#failure;
		if (this.#conditionalWrite || (nativeEdits && this.#pendingWrites > 0))
			throw new NativeSessionWriteRejectedError("Native conditional edit requires an idle scope");
		if (this.#pendingWrites >= this.#maxPendingWrites)
			throw new NativeSessionWriteRejectedError("Native pending write admission budget exhausted");
		const firstSeq = this.#throughSeq + 1;
		const throughSeq = this.#throughSeq + Math.max(1, entries.length);
		const serialized = JSON.stringify({
			operationId: Bun.randomUUIDv7(),
			familyId: this.#familyId,
			generationId: this.#generationId,
			firstSeq,
			entries: entries.map(nativeEntry),
			head: {
				leafId: checkpoint.leafId,
				contextAnchors: { startEntryId: checkpoint.contextStartId },
				...(forkSource
					? {
							lineage: {
								parentGenerationId: forkSource.generationId,
								forkCutSeq: forkSource.throughSeq,
								forkLeafId: checkpoint.leafId,
							},
						}
					: {}),
			},
			state: { native: JSON.parse(JSON.stringify(checkpoint)) },
			durability,
			dependencies: forkSource
				? [
						{
							familyId: forkSource.familyId,
							generationId: forkSource.generationId,
							throughSeq: forkSource.throughSeq,
						},
					]
				: [],
			...(nativeEdits ? { nativeEdits, expectedThroughSeq: this.#throughSeq } : {}),
		} satisfies Omit<StorageWrite, "requestId" | "payloadHash" | "incarnation">);
		// Bound both wire bytes and the retained snapshot, before reserving a sequence.
		const bytes = Math.max(Buffer.byteLength(serialized), serialized.length * 2);
		if (this.#pendingBytes + bytes > this.#maxPendingBytes)
			throw new NativeSessionWriteRejectedError("Native pending byte admission budget exhausted");
		const submit = () => this.#client.write(JSON.parse(serialized));
		// Buffered writes resolve at application, not WAL durability. The next prefix
		// cannot overtake it; a failed prefix also rejects all already admitted successors.
		const write = this.#pendingWrites === 0 ? submit() : this.#writeTail.then(submit);
		const completion = write
			.then(receipt => {
				if (receipt.throughSeq !== throughSeq) throw new Error("Native storage receipt has the wrong prefix");
			})
			.catch(error => {
				this.#failure =
					error instanceof StorageClientError && ["conflict", "backpressure"].includes(error.code)
						? new NativeSessionWriteRejectedError(error.message)
						: error instanceof Error
							? error
							: new Error(String(error));
				throw this.#failure;
			})
			.finally(() => {
				this.#pendingWrites--;
				this.#pendingBytes -= bytes;
				if (nativeEdits) this.#conditionalWrite = false;
			});
		this.#pendingWrites++;
		this.#pendingBytes += bytes;
		this.#writeTail = completion;
		if (nativeEdits) this.#conditionalWrite = true;
		this.#throughSeq = throughSeq;
		return { position: this.#position(), completion };
	}

	async barrier(position: NativeSessionPosition): Promise<void> {
		if (this.#failure) throw this.#failure;
		if (
			position.familyId !== this.#familyId ||
			position.generationId !== this.#generationId ||
			position.incarnation !== this.#client.incarnation
		) {
			throw new Error("Native checkpoint belongs to a different storage scope or incarnation");
		}
		await this.#client.barrier({ ...position, dependencies: [] });
	}

	readContext(): Promise<NativeSessionRead> {
		return this.#read(false);
	}
	readArchive(): Promise<NativeSessionRead> {
		return this.#read(true);
	}

	async readChildren(parentId: string, position: NativeSessionPosition): Promise<SessionEntry[]> {
		if (
			position.familyId !== this.#familyId ||
			position.generationId !== this.#generationId ||
			position.incarnation !== this.#client.incarnation
		)
			throw new Error("Native children cut belongs to a different scope or incarnation");
		const children: SessionEntry[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.#client.readChildren({
				familyId: this.#familyId,
				generationId: this.#generationId,
				parentId,
				cutSeq: position.throughSeq,
				cursor,
				maxRecords: this.#maxRecords,
				maxBytes: this.#maxBytes,
			});
			this.#validatePage(page, position.throughSeq);
			for (const entry of page.events) {
				const child = decodeEntry(entry);
				if (child.parentId !== parentId) throw new Error("Native children page returned a different parent");
				// One content child selects the native preserve-subtree branch; no need to read its siblings.
				if (child.type !== "service_tier_change") return [child];
				children.push(child);
				if (children.length > 98) throw new Error("Native discard exceeds the atomic edit bound");
			}
			if (page.nextCursor && page.nextCursor === cursor) throw new Error("Native children cursor did not advance");
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return children;
	}

	#validatePage(page: StorageReadSuccessResponse, cutSeq?: number): void {
		const bytes = page.events.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0);
		if (
			page.familyId !== this.#familyId ||
			page.generationId !== this.#generationId ||
			!Number.isSafeInteger(page.throughSeq) ||
			page.throughSeq < 0 ||
			page.events.length > this.#maxRecords ||
			bytes > this.#maxBytes ||
			(cutSeq !== undefined && cutSeq !== page.throughSeq)
		)
			throw new Error("Native read exceeded bounds, changed scope or changed frozen cut");
	}

	async #read(archive: boolean): Promise<NativeSessionRead> {
		const entries: SessionEntry[] = [];
		let cursor: string | undefined;
		let cutSeq: number | undefined;
		let checkpoint: NativeSessionCheckpoint | undefined;
		const seen = new Set<string>();
		do {
			const request = {
				familyId: this.#familyId,
				generationId: this.#generationId,
				cursor,
				cutSeq,
				maxRecords: this.#maxRecords,
				maxBytes: this.#maxBytes,
			};
			const page = await (archive ? this.#client.readRange(request) : this.#client.readContext(request));
			this.#validatePage(page, cutSeq);
			const pageCheckpoint = checkpointFrom(page);
			if (checkpoint && JSON.stringify(pageCheckpoint) !== JSON.stringify(checkpoint))
				throw new Error("Native checkpoint changed inside a frozen read");
			checkpoint ??= pageCheckpoint;
			cutSeq = page.throughSeq;
			for (const entry of page.events) {
				if (seen.has(entry.entryId)) throw new Error("Native read repeated an entry");
				seen.add(entry.entryId);
				entries.push(decodeEntry(entry));
			}
			if (page.nextCursor && page.nextCursor === cursor) throw new Error("Native read cursor did not advance");
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		if (!checkpoint || cutSeq === undefined) throw new Error("Native read did not return a checkpoint");
		if (!archive) {
			if ((entries[0]?.id ?? null) !== checkpoint.leafId)
				throw new Error("Native context does not start at its frozen leaf");
			for (let index = 1; index < entries.length; index++) {
				if (entries[index - 1].parentId !== entries[index].id)
					throw new Error("Native context has a broken parent chain");
			}
			const oldest = entries.at(-1);
			if (checkpoint.contextStartId ? oldest?.id !== checkpoint.contextStartId : oldest?.parentId != null)
				throw new Error("Native context did not reach its checkpoint anchor");
			entries.reverse();
		}
		this.#throughSeq = Math.max(this.#throughSeq, cutSeq);
		return { checkpoint, entries, throughSeq: cutSeq, position: this.#position(cutSeq), complete: archive };
	}
}
