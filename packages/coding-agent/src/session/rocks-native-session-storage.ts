import { getBlobsDir } from "@oh-my-pi/pi-utils";
import { type BlobPublication, BlobStore, parseBlobRef } from "./blob-store";
import {
	type NativeSessionCheckpoint,
	type NativeSessionPosition,
	type NativeSessionRead,
	type NativeSessionStorage,
	type NativeSessionTicket,
	NativeSessionWriteRejectedError,
} from "./native-session-storage";
import { resolveSessionContextState } from "./session-context";
import type { SessionEntry } from "./session-entries";
import { collectPersistedBlobHashes } from "./session-loader";
import { MAX_PERSIST_CHARS, prepareNativeEntryPayload } from "./session-persistence";
import { type StorageClient, StorageClientError } from "./storage-client";
import type { StorageEntry, StoragePayload, StorageReadSuccessResponse, StorageWrite } from "./storage-protocol";

const NATIVE_ENTRY_BLOB_SCHEMA = "omp.native.entry.blob.v1" as const;
const NATIVE_INLINE_ENTRY_PAYLOAD_BYTES = 192 * 1024;
const NATIVE_ENTRY_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const NATIVE_WRITE_INPUT_MAX_BYTES = 1024 * 1024 - 4096;
/** Below this string cap further trimming no longer shrinks an entry meaningfully. */
const NATIVE_MIN_STRING_CHARS = 1024;

type NativeWriteInput = Omit<StorageWrite, "requestId" | "payloadHash" | "incarnation">;
/** One entry serialized once: `entry` carries a `{}` payload placeholder until the write is assembled. */
type NativeRecord = { entry: StorageEntry; json: string; bytes: number };
type NativeEntryBlobMarker = StoragePayload & {
	schema: typeof NATIVE_ENTRY_BLOB_SCHEMA;
	ref: string;
	bytes: number;
};

function markerFor(hash: string, bytes: number): NativeEntryBlobMarker {
	return { schema: NATIVE_ENTRY_BLOB_SCHEMA, ref: `blob:sha256:${hash}`, bytes };
}

function nativeEntryBlobMarker(payload: StoragePayload): NativeEntryBlobMarker | undefined {
	if (payload.schema !== NATIVE_ENTRY_BLOB_SCHEMA) return undefined;
	if (
		typeof payload.ref !== "string" ||
		typeof payload.bytes !== "number" ||
		!Number.isSafeInteger(payload.bytes) ||
		payload.bytes < 1 ||
		payload.bytes > NATIVE_ENTRY_BLOB_MAX_BYTES
	)
		throw new Error("Invalid native entry blob marker");
	return payload as NativeEntryBlobMarker;
}

/**
 * Detach one entry into its native record: images become blob references, over-long strings are
 * trimmed, and if the JSON still exceeds one entry blob the longest strings are trimmed further.
 */
function nativeRecord(entry: SessionEntry, bodies: Map<string, Buffer>): NativeRecord {
	let payload = prepareNativeEntryPayload(entry, bodies);
	let json = JSON.stringify(payload);
	let bytes = Buffer.byteLength(json);
	// Images are references already, so each halved cap trims only the longest remaining strings.
	for (
		let maxChars = MAX_PERSIST_CHARS >> 1;
		bytes > NATIVE_ENTRY_BLOB_MAX_BYTES && maxChars >= NATIVE_MIN_STRING_CHARS;
		maxChars >>= 1
	) {
		payload = prepareNativeEntryPayload(payload, bodies, maxChars);
		json = JSON.stringify(payload);
		bytes = Buffer.byteLength(json);
	}
	if (bytes > NATIVE_ENTRY_BLOB_MAX_BYTES)
		throw new NativeSessionWriteRejectedError("Native entry payload exceeds the 8 MiB blob budget");
	return { entry: { entryId: entry.id, parentId: entry.parentId, kind: entry.type, payload: {} }, json, bytes };
}

/**
 * Assemble the write around records whose payloads are serialized exactly once. The envelope is
 * serialized once with `{}` placeholders, which detaches the checkpoint and measures every wire byte;
 * records above 192 KiB, then the largest ones until the request fits, move into entry blobs.
 */
function prepareNativeWrite(
	envelope: NativeWriteInput,
	records: readonly NativeRecord[],
	bodies: Map<string, Buffer>,
): { write: NativeWriteInput; bytes: number } {
	const serialized = JSON.stringify(envelope);
	const write = JSON.parse(serialized) as NativeWriteInput;
	const targets = [...write.entries, ...(write.nativeEdits ?? []).flatMap(edit => (edit.entry ? [edit.entry] : []))];
	const payloads: Array<StoragePayload | undefined> = new Array(records.length);
	let bytes = Buffer.byteLength(serialized) - 2 * records.length;
	const externalize = (index: number) => {
		const data = Buffer.from(records[index].json, "utf8");
		const hash = new Bun.SHA256().update(data).digest("hex");
		bodies.set(hash, data);
		payloads[index] = markerFor(hash, data.byteLength);
		bytes += Buffer.byteLength(JSON.stringify(payloads[index]));
	};
	for (const [index, record] of records.entries()) {
		if (record.bytes > NATIVE_INLINE_ENTRY_PAYLOAD_BYTES) externalize(index);
		else bytes += record.bytes;
	}
	for (const index of [...records.keys()].sort((left, right) => records[right].bytes - records[left].bytes)) {
		if (bytes <= NATIVE_WRITE_INPUT_MAX_BYTES) break;
		if (payloads[index]) continue;
		bytes -= records[index].bytes;
		externalize(index);
	}
	if (bytes > NATIVE_WRITE_INPUT_MAX_BYTES)
		throw new NativeSessionWriteRejectedError("Native write exceeds the storage request byte budget");
	for (const [index, target] of targets.entries())
		target.payload = payloads[index] ?? (JSON.parse(records[index].json) as StoragePayload);
	return { write, bytes };
}

/** Every blob one native entry payload names (C2-A): its entry-blob body, or its image and upload references. */
export function nativePayloadBlobHashes(payload: StoragePayload): string[] {
	const marker = nativeEntryBlobMarker(payload);
	if (!marker) return collectPersistedBlobHashes([payload]);
	const hash = parseBlobRef(marker.ref);
	if (!hash) throw new Error("Native entry blob marker has an invalid reference");
	return [hash];
}

export function parseNativeSessionLocator(locator: string): { familyId: string; generationId: string } {
	const match = /^native:([^/]+)\/([^/]+)$/.exec(locator);
	if (!match) throw new Error("Invalid native session locator");
	const familyId = decodeURIComponent(match[1]);
	const generationId = decodeURIComponent(match[2]);
	if (!familyId || !generationId) throw new Error("Invalid native session locator scope");
	return { familyId, generationId };
}

async function decodeEntry(entry: StorageEntry, blobs: BlobStore): Promise<SessionEntry> {
	const marker = nativeEntryBlobMarker(entry.payload);
	let value: StoragePayload = entry.payload;
	if (marker) {
		const hash = parseBlobRef(marker.ref);
		if (!hash) throw new Error("Native entry blob marker has an invalid reference");
		const data = Buffer.allocUnsafe(marker.bytes);
		let offset = 0;
		let present: boolean;
		try {
			present = await blobs.readVerified(hash, marker.bytes, chunk => {
				offset += chunk.copy(data, offset);
			});
		} catch (error) {
			throw new Error(`Native entry blob ${hash} size or hash does not match its marker`, { cause: error });
		}
		if (!present) throw new Error(`Native entry blob ${hash} is missing`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString("utf8"));
		} catch (error) {
			throw new Error(`Native entry blob ${hash} does not contain valid JSON`, { cause: error });
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error(`Native entry blob ${hash} does not contain an entry payload`);
		value = parsed as StoragePayload;
	}
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
	#blobs: BlobStore;

	constructor(
		client: StorageClient,
		familyId: string,
		generationId: string,
		limits: { maxRecords?: number; maxBytes?: number; maxPendingWrites?: number; maxPendingBytes?: number } = {},
		blobs: BlobStore = new BlobStore(getBlobsDir()),
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
		this.#blobs = blobs;
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
		return this.#submit(appended, checkpoint, "required", { entries, deletedIds });
	}

	#submit(
		entries: readonly SessionEntry[],
		checkpoint: NativeSessionCheckpoint,
		durability: "buffered" | "required",
		edits?: { entries: readonly SessionEntry[]; deletedIds: readonly string[] },
		forkSource?: NativeSessionPosition,
	): NativeSessionTicket {
		if (this.#failure) throw this.#failure;
		if (this.#conditionalWrite || (edits && this.#pendingWrites > 0))
			throw new NativeSessionWriteRejectedError("Native conditional edit requires an idle scope");
		if (this.#pendingWrites >= this.#maxPendingWrites)
			throw new NativeSessionWriteRejectedError("Native pending write admission budget exhausted");
		const firstSeq = this.#throughSeq + 1;
		const throughSeq = this.#throughSeq + Math.max(1, entries.length);
		const bodies = new Map<string, Buffer>();
		const records = [...entries, ...(edits?.entries ?? [])].map(entry => nativeRecord(entry, bodies));
		const prepared = prepareNativeWrite(
			{
				operationId: Bun.randomUUIDv7(),
				familyId: this.#familyId,
				generationId: this.#generationId,
				firstSeq,
				entries: records.slice(0, entries.length).map(record => record.entry),
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
				state: { native: checkpoint },
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
				...(edits
					? {
							nativeEdits: [
								...records.slice(entries.length).map(record => ({
									entryId: record.entry.entryId,
									entry: record.entry,
								})),
								...edits.deletedIds.map(entryId => ({ entryId, entry: null })),
							],
							expectedThroughSeq: this.#throughSeq,
						}
					: {}),
			},
			records,
			bodies,
		);
		// Bound the retained snapshot (UTF-16 upper bound of its wire bytes) before reserving a sequence.
		// Blob bodies stay outside the budget: they copy in-memory entry data, are bounded by the
		// pending-write count, and counting them would reject valid image entries larger than the budget.
		const bytes = prepared.bytes * 2;
		if (this.#pendingBytes + bytes > this.#maxPendingBytes)
			throw new NativeSessionWriteRejectedError("Native pending byte admission budget exhausted");
		const submit = async () => {
			// Each body stays pinned by its intent until the record that owns it is applied (C3).
			const publications: BlobPublication[] = [];
			try {
				for (const data of bodies.values()) publications.push(await this.#blobs.publish(data));
				const receipt = await this.#client.write(prepared.write);
				await Promise.all(publications.map(publication => publication.release()));
				return receipt;
			} catch (error) {
				// Also right when the outcome is unknown: the owner keeps any body an applied record owns.
				await Promise.all(publications.map(publication => publication.abandon()));
				throw error;
			}
		};
		// Buffered writes resolve at application, not WAL durability. The next prefix
		// cannot overtake it; a failed prefix also rejects all already admitted successors.
		const write = this.#pendingWrites === 0 ? submit() : this.#writeTail.then(submit);
		const completion = write
			.then(receipt => {
				if (receipt.throughSeq !== throughSeq) throw new Error("Native storage receipt has the wrong prefix");
			})
			.catch(error => {
				// The owner rejects this stale conditional prefix before admission. Other
				// sequence gaps can occur at apply/barrier time and are not this rollback proof.
				const rejectedPrefix =
					edits !== undefined &&
					error instanceof StorageClientError &&
					error.code === "sequence_gap" &&
					error.message === "write does not follow accepted prefix";
				this.#failure =
					error instanceof StorageClientError &&
					(["conflict", "backpressure"].includes(error.code) || rejectedPrefix)
						? new NativeSessionWriteRejectedError(error.message)
						: error instanceof Error
							? error
							: new Error(String(error));
				throw this.#failure;
			})
			.finally(() => {
				this.#pendingWrites--;
				this.#pendingBytes -= bytes;
				if (edits) this.#conditionalWrite = false;
			});
		this.#pendingWrites++;
		this.#pendingBytes += bytes;
		this.#writeTail = completion;
		if (edits) this.#conditionalWrite = true;
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

	readContext(selection?: { entryId: string; expectedLeafEntryId: string }): Promise<NativeSessionRead> {
		return selection ? this.#readSelectedContext(selection) : this.#read(false);
	}

	async #readSelectedContext(selection: { entryId: string; expectedLeafEntryId: string }): Promise<NativeSessionRead> {
		const scope = { familyId: this.#familyId, generationId: this.#generationId };
		const one = { maxRecords: 1, maxBytes: this.#maxBytes };
		const initial = await this.#client.readContext({ ...scope, ...one });
		const current = checkpointFrom(initial);
		if (current.leafId !== selection.expectedLeafEntryId) throw new Error("Native history source leaf changed");
		const cutSeq = initial.throughSeq;
		// Validate selected ancestry with the owner's indexed membership check, without reading the suffix.
		await this.#client.readContext({
			...scope,
			...one,
			cutSeq,
			leafId: current.leafId!,
			startEntryId: selection.entryId,
		});
		let generationId = this.#generationId;
		let generationCut = cutSeq;
		let historical: NativeSessionCheckpoint | undefined;
		let found = false;
		for (let depth = 0; depth < 64; depth++) {
			// A fork's first write retains its immutable lineage even after later heads change.
			const first = await this.#client.readContext({ ...scope, ...one, generationId, cutSeq: 1 });
			const lineage = first.head?.lineage;
			if (lineage?.forkLeafId) {
				try {
					await this.#client.readContext({
						...scope,
						...one,
						generationId,
						cutSeq: generationCut,
						leafId: lineage.forkLeafId,
						startEntryId: selection.entryId,
					});
					generationId = lineage.parentGenerationId;
					generationCut = lineage.forkCutSeq;
					continue;
				} catch (error) {
					if (
						!(error instanceof StorageClientError) ||
						!error.message.includes("context start not on selected ancestry")
					)
						throw error;
				}
			}
			const selected = await this.#client.readContext({
				...scope,
				...one,
				generationId,
				cutSeq: generationCut,
				leafId: selection.entryId,
			});
			const entry = selected.events[0];
			if (entry?.entryId !== selection.entryId) throw new Error("Native history entry is unavailable");
			// Read the prefix preceding this entry, never the current (possibly later compacted) summary.
			const before = await this.#client.readContext({ ...scope, ...one, generationId, cutSeq: entry.seq - 1 });
			historical = before.state?.native as NativeSessionCheckpoint | undefined;
			found = true;
			break;
		}
		if (!found) throw new Error("Native history lineage exceeds its read bound");
		const startEntryId = historical?.contextStartId ?? undefined;
		const entries: SessionEntry[] = [];
		let cursor: string | undefined;
		let bytes = 0;
		do {
			const page = await this.#client.readContext({
				...scope,
				cutSeq,
				leafId: selection.entryId,
				startEntryId,
				cursor,
				maxRecords: this.#maxRecords,
				maxBytes: this.#maxBytes,
			});
			this.#validatePage(page, cutSeq);
			bytes += Buffer.byteLength(JSON.stringify(page));
			// Blob markers are small; reserve their decoded payload before materializing any entry.
			for (const entry of page.events) bytes += nativeEntryBlobMarker(entry.payload)?.bytes ?? 0;
			if (entries.length + page.events.length > 4096 || bytes > 64 * 1024 * 1024)
				throw new Error("Native history working context exceeds its read bound");
			for (const entry of page.events) entries.push(await decodeEntry(entry, this.#blobs));
			if (page.nextCursor && page.nextCursor === cursor) throw new Error("Native history cursor did not advance");
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		entries.reverse();
		if (entries.at(-1)?.id !== selection.entryId) throw new Error("Native history selected entry is missing");
		const checkpoint = structuredClone(historical ?? current);
		checkpoint.header = structuredClone(current.header);
		checkpoint.leafId = selection.entryId;
		checkpoint.contextStartId = entries[0]?.id ?? null;
		// Before the first checkpoint the complete path supplies all context; no future prefix is used.
		if (!historical)
			checkpoint.prefix = {
				settings: resolveSessionContextState([]),
				credentialPins: {},
				hasAssistant: false,
				entryTypes: [],
			};
		return {
			checkpoint,
			entries,
			throughSeq: cutSeq,
			position: this.#position(cutSeq),
			complete: !entries[0]?.parentId,
		};
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
				const child = await decodeEntry(entry, this.#blobs);
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
		let confirmed = false;
		const seen = new Set<string>();
		for (;;) {
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
			// A writer that stopped without a barrier can leave applied writes past the durable default cut.
			// The next write must follow that applied prefix, so make it durable once and read again from it.
			if (cutSeq === undefined && !confirmed && page.liveThroughSeq > page.throughSeq) {
				confirmed = true;
				await this.#client.barrier({
					familyId: this.#familyId,
					generationId: this.#generationId,
					throughSeq: page.liveThroughSeq,
					dependencies: [],
				});
				continue;
			}
			const pageCheckpoint = checkpointFrom(page);
			if (checkpoint && JSON.stringify(pageCheckpoint) !== JSON.stringify(checkpoint))
				throw new Error("Native checkpoint changed inside a frozen read");
			checkpoint ??= pageCheckpoint;
			cutSeq = page.throughSeq;
			for (const entry of page.events) {
				if (seen.has(entry.entryId)) throw new Error("Native read repeated an entry");
				seen.add(entry.entryId);
				entries.push(await decodeEntry(entry, this.#blobs));
			}
			if (page.nextCursor && page.nextCursor === cursor) throw new Error("Native read cursor did not advance");
			cursor = page.nextCursor ?? undefined;
			if (!cursor) break;
		}
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
		}
		entries.reverse();
		this.#throughSeq = Math.max(this.#throughSeq, cutSeq);
		return { checkpoint, entries, throughSeq: cutSeq, position: this.#position(cutSeq), complete: archive };
	}
}
