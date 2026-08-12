export interface AssembledSnapshot {
	activeSessionId: string;
	snapshotId: string;
	snapshot: Record<string, unknown> & { messages: unknown[] };
	lastEventSequence: number;
	lastEventCursor?: Record<string, unknown>;
}

interface SnapshotState {
	activeSessionId: string;
	snapshotId: string;
	snapshot: Record<string, unknown>;
	messageCount: number;
	messages: unknown[];
	nextIndex: number;
	bytes: number;
}

export const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

export function snapshotIdentity(activeSessionId: string, snapshotId: string): string {
	return JSON.stringify([activeSessionId, snapshotId]);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
	if (typeof value[key] !== "string" || value[key].length === 0)
		throw new Error(`${label}.${key} must be a non-empty string`);
	return value[key] as string;
}

function integerField(value: Record<string, unknown>, key: string, label: string, minimum = 0): number {
	if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < minimum)
		throw new Error(`${label}.${key} must be an integer >= ${minimum}`);
	return value[key] as number;
}

/** Validates and assembles independent Prime snapshot streams. */
export class SnapshotAssembler {
	#states = new Map<string, SnapshotState>();
	#totalBytes = 0;
	readonly maxChunks: number;
	readonly maxMessages: number;
	readonly maxBytes: number;

	constructor(options: { maxChunks?: number; maxMessages?: number; maxBytes?: number } = {}) {
		this.maxChunks = options.maxChunks ?? 10_000;
		this.maxMessages = options.maxMessages ?? 100_000;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
			throw new RangeError("snapshot byte limit must be a positive integer");
	}

	reset(activeSessionId?: string, snapshotId?: string): void {
		if (activeSessionId !== undefined && snapshotId !== undefined) {
			this.#delete(snapshotIdentity(activeSessionId, snapshotId));
			return;
		}
		this.#states.clear();
		this.#totalBytes = 0;
	}

	resetSession(activeSessionId: string): void {
		for (const [key, state] of this.#states) {
			if (state.activeSessionId === activeSessionId) this.#delete(key);
		}
	}

	add(event: Record<string, unknown>): AssembledSnapshot | undefined {
		if (event.type === "session_snapshot_begin") return this.#begin(event);
		if (event.type === "session_snapshot_chunk") return this.#chunk(event);
		if (event.type === "session_snapshot_end") return this.#end(event);
		if (event.type === "session_snapshot_failed") {
			const activeSessionId = stringField(event, "activeSessionId", "snapshot failed");
			const snapshotId = stringField(event, "snapshotId", "snapshot failed");
			this.#delete(snapshotIdentity(activeSessionId, snapshotId));
			throw new Error(typeof event.error === "string" ? event.error : "snapshot failed");
		}
		return undefined;
	}

	#begin(event: Record<string, unknown>): undefined {
		const activeSessionId = stringField(event, "activeSessionId", "snapshot begin");
		const snapshotId = stringField(event, "snapshotId", "snapshot begin");
		const key = snapshotIdentity(activeSessionId, snapshotId);
		if (this.#states.has(key)) throw new Error("duplicate snapshot begin");
		const snapshot = object(event.snapshot, "snapshot begin.snapshot");
		const messageCount = integerField(event, "messageCount", "snapshot begin");
		const targetChunkBytes = integerField(event, "targetChunkBytes", "snapshot begin", 1);
		const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
		if (
			targetChunkBytes > 64 * 1024 * 1024 ||
			messageCount > this.maxMessages ||
			snapshotBytes > this.maxBytes ||
			this.#totalBytes + snapshotBytes > this.maxBytes
		)
			throw new Error("snapshot exceeds limits");
		if (snapshot.activeSessionId !== activeSessionId)
			throw new Error("snapshot session identity does not match begin");
		const summary =
			snapshot.summary === undefined ? undefined : object(snapshot.summary, "snapshot begin.snapshot.summary");
		if (summary && summary.messageCount !== undefined && summary.messageCount !== messageCount)
			throw new Error("snapshot summary count does not match begin");
		this.#states.set(key, {
			activeSessionId,
			snapshotId,
			snapshot,
			messageCount,
			messages: [],
			nextIndex: 0,
			bytes: snapshotBytes,
		});
		this.#totalBytes += snapshotBytes;
		return undefined;
	}

	#chunk(event: Record<string, unknown>): undefined {
		const activeSessionId = stringField(event, "activeSessionId", "snapshot chunk");
		const snapshotId = stringField(event, "snapshotId", "snapshot chunk");
		const state = this.#states.get(snapshotIdentity(activeSessionId, snapshotId));
		if (!state) throw new Error("snapshot chunk received without begin");
		try {
			const index = integerField(event, "index", "snapshot chunk");
			if (index !== state.nextIndex)
				throw new Error(`snapshot chunk index ${index} is not contiguous (expected ${state.nextIndex})`);
			if (!Array.isArray(event.messages)) throw new Error("snapshot chunk.messages must be an array");
			if (state.messages.length + event.messages.length > this.maxMessages)
				throw new Error("snapshot messages exceed limit");
			const chunkBytes = new TextEncoder().encode(JSON.stringify(event.messages)).byteLength;
			if (state.bytes + chunkBytes > this.maxBytes || this.#totalBytes + chunkBytes > this.maxBytes)
				throw new Error("snapshot bytes exceed limit");
			state.messages.push(...event.messages);
			state.bytes += chunkBytes;
			this.#totalBytes += chunkBytes;
			state.nextIndex += 1;
			if (state.nextIndex > this.maxChunks) throw new Error("snapshot chunk count exceeds limit");
			return undefined;
		} catch (error) {
			this.#delete(snapshotIdentity(activeSessionId, snapshotId));
			throw error;
		}
	}

	#end(event: Record<string, unknown>): AssembledSnapshot {
		const activeSessionId = stringField(event, "activeSessionId", "snapshot end");
		const snapshotId = stringField(event, "snapshotId", "snapshot end");
		const key = snapshotIdentity(activeSessionId, snapshotId);
		const state = this.#states.get(key);
		if (!state) throw new Error("snapshot end received without begin");
		try {
			const chunkCount = integerField(event, "chunkCount", "snapshot end");
			const lastEventSequence = integerField(event, "lastEventSequence", "snapshot end");
			if (chunkCount !== state.nextIndex || state.messages.length !== state.messageCount)
				throw new Error("snapshot end counts are incomplete or contradictory");
			if (state.snapshot.lastEventSequence !== undefined && state.snapshot.lastEventSequence !== lastEventSequence)
				throw new Error("snapshot sequence does not match end");
			const assembledSnapshot = { ...state.snapshot, messages: state.messages };
			if (new TextEncoder().encode(JSON.stringify(assembledSnapshot)).byteLength > this.maxBytes)
				throw new Error("snapshot bytes exceed limit");
			const result: AssembledSnapshot = {
				activeSessionId,
				snapshotId,
				snapshot: assembledSnapshot,
				lastEventSequence,
			};
			if (event.lastEventCursor !== undefined) {
				const cursor = object(event.lastEventCursor, "snapshot end.lastEventCursor");
				if (
					typeof cursor.generation !== "string" ||
					typeof cursor.sequence !== "number" ||
					cursor.sequence !== lastEventSequence
				)
					throw new Error("snapshot cursor does not match end sequence");
				result.lastEventCursor = cursor;
			}
			this.#delete(key);
			return result;
		} catch (error) {
			this.#delete(key);
			throw error;
		}
	}

	#delete(key: string): void {
		const state = this.#states.get(key);
		if (state === undefined) return;
		this.#states.delete(key);
		this.#totalBytes -= state.bytes;
	}
}
