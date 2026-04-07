/**
 * Content store: byte-budgeted LRU cache on top of the blob store for
 * externalized tool-result text.
 *
 * Problem solved:
 *   Long-running coding-agent sessions accumulate megabytes (or gigabytes) of
 *   tool-result text in `AgentSession.state.messages` — file reads, grep
 *   output, MCP responses, etc. Historically the full text was held live on
 *   the V8 heap until compaction fired, which is why idle `omp --resume`
 *   processes reached multi-GB RSS in practice.
 *
 * Approach:
 *   Tool-result messages whose text blocks exceed HOLLOW_THRESHOLD_BYTES are
 *   "hollowed": the full payload is written to the content-addressed
 *   BlobStore, the inline `text` field is replaced with a short preview
 *   (PREVIEW_BYTES), and a `coldRefs` sidecar records where to fetch the full
 *   text when the LLM path needs it. Rehydration runs lazily on
 *   `materializeToolResult()` and is backed by a small LRU so the working set
 *   stays hot across turns.
 *
 * Non-goals (v1):
 *   - Externalizing non-tool-result content (assistant, user, custom).
 *   - TUI-driven on-demand expansion past the preview.
 *   - Blob GC. Blobs are content-addressed and shared across sessions.
 */
import type { ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobStore, isBlobRef } from "./blob-store";

/** Minimum text block byte length to externalize to the content store. */
export const HOLLOW_THRESHOLD_BYTES = 16 * 1024;

/** Bytes kept inline as a preview after hollowing (covers typical TUI collapsed view). */
export const PREVIEW_BYTES = 4 * 1024;

/** Default in-memory LRU byte budget for rehydrated text blobs. */
export const DEFAULT_LRU_BUDGET_BYTES = 16 * 1024 * 1024;

const COLD_REF_PREFIX = "blob:sha256:";

/**
 * Byte-budgeted LRU cache + content-addressed blob persistence for text.
 *
 * Wraps a {@link BlobStore} with UTF-8 text helpers and a small in-memory LRU
 * so rehydration on the LLM hot path does not hit disk for recently touched
 * tool results. Eviction is by total bytes, not entry count, because blob
 * sizes vary by orders of magnitude.
 */
export class ContentStore {
	readonly #blobStore: BlobStore;
	readonly #budgetBytes: number;
	#cacheBytes = 0;
	// Map iteration order is LRU: we re-insert on access to promote entries.
	readonly #cache = new Map<string, string>();

	constructor(blobStore: BlobStore, options?: { budgetBytes?: number }) {
		this.#blobStore = blobStore;
		this.#budgetBytes = options?.budgetBytes ?? DEFAULT_LRU_BUDGET_BYTES;
	}

	/** Current cached byte total (exposed for tests/diagnostics). */
	get cacheBytes(): number {
		return this.#cacheBytes;
	}

	/** Write UTF-8 text to the underlying blob store and return a cold ref + byte length. */
	async putText(text: string): Promise<{ ref: string; byteLen: number }> {
		const buf = Buffer.from(text, "utf-8");
		const { ref } = await this.#blobStore.put(buf);
		this.#admit(ref, text, buf.byteLength);
		return { ref, byteLen: buf.byteLength };
	}

	/**
	 * Resolve a cold ref back to its UTF-8 text.
	 * Returns null if the blob is missing (callers should fall back to the inline preview).
	 */
	async getText(ref: string): Promise<string | null> {
		if (!isBlobRef(ref)) {
			logger.warn("ContentStore.getText called with non-blob ref", { ref });
			return null;
		}
		const hash = ref.slice(COLD_REF_PREFIX.length);

		const cached = this.#cache.get(ref);
		if (cached !== undefined) {
			// LRU promote: delete + re-insert so this entry becomes most-recent.
			this.#cache.delete(ref);
			this.#cache.set(ref, cached);
			return cached;
		}

		const buffer = await this.#blobStore.get(hash);
		if (buffer === null) return null;
		const text = buffer.toString("utf-8");
		this.#admit(ref, text, buffer.byteLength);
		return text;
	}

	#admit(ref: string, text: string, byteLen: number): void {
		if (byteLen > this.#budgetBytes) {
			// Single entry exceeds the whole budget: do not cache, just serve via disk next time.
			return;
		}
		const existing = this.#cache.get(ref);
		if (existing !== undefined) {
			this.#cacheBytes -= Buffer.byteLength(existing, "utf-8");
			this.#cache.delete(ref);
		}
		this.#cache.set(ref, text);
		this.#cacheBytes += byteLen;
		this.#evictUntilUnderBudget();
	}

	#evictUntilUnderBudget(): void {
		while (this.#cacheBytes > this.#budgetBytes) {
			const oldest = this.#cache.keys().next();
			if (oldest.done) return;
			const key = oldest.value;
			const value = this.#cache.get(key);
			if (value === undefined) {
				this.#cache.delete(key);
				continue;
			}
			this.#cacheBytes -= Buffer.byteLength(value, "utf-8");
			this.#cache.delete(key);
		}
	}
}

/** Utf-8 byte length helper. */
function utf8Len(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}

/** Compute a byte-aligned preview that does not split a multi-byte UTF-8 scalar. */
function computePreview(text: string, maxBytes: number): string {
	if (utf8Len(text) <= maxBytes) return text;
	const buf = Buffer.from(text, "utf-8");
	let end = Math.min(maxBytes, buf.byteLength);
	// Walk back past any UTF-8 continuation bytes (0b10xxxxxx) to a scalar boundary.
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}
	return buf.subarray(0, end).toString("utf-8");
}

/**
 * Hollow large text blocks on a tool-result message in place.
 *
 * For each `TextContent` block whose UTF-8 byte length exceeds `thresholdBytes`:
 *   1. Write the full text to the content store (content-addressed blob).
 *   2. Replace the inline `text` with a UTF-8-safe preview (`previewBytes`).
 *   3. Record an entry in `message.coldRefs` pointing at the blob.
 *
 * Images and small text blocks are untouched. Blocks that already have a
 * matching entry in `coldRefs` (idempotent re-hollow after load or snapshot)
 * are skipped.
 *
 * Mutates `message` in place. Returns the number of blocks externalized.
 */
export async function hollowToolResultInPlace(
	message: ToolResultMessage,
	store: ContentStore,
	options?: { thresholdBytes?: number; previewBytes?: number },
): Promise<number> {
	const threshold = options?.thresholdBytes ?? HOLLOW_THRESHOLD_BYTES;
	const previewBytes = options?.previewBytes ?? PREVIEW_BYTES;

	const existingRefs = new Set((message.coldRefs ?? []).map(r => r.blockIndex));
	const newRefs: Array<{ blockIndex: number; ref: string; byteLen: number }> = [];

	for (let i = 0; i < message.content.length; i++) {
		if (existingRefs.has(i)) continue;
		const block = message.content[i];
		if (block.type !== "text") continue;

		const byteLen = utf8Len(block.text);
		if (byteLen < threshold) continue;

		const { ref } = await store.putText(block.text);
		newRefs.push({ blockIndex: i, ref, byteLen });
		// Mutate in place: shrink the inline text to a preview.
		(block as TextContent).text = computePreview(block.text, previewBytes);
	}

	if (newRefs.length === 0) return 0;

	message.coldRefs = [...(message.coldRefs ?? []), ...newRefs];
	return newRefs.length;
}

/**
 * Produce a materialized clone of a tool-result message with all cold text
 * resolved back to its full payload.
 *
 * Returns the original message reference unchanged when nothing is cold.
 * If a blob is missing from disk, the corresponding block retains its
 * preview and a one-line warning is logged (so the LLM sees truncated data
 * instead of crashing mid-turn).
 */
export async function materializeToolResult(
	message: ToolResultMessage,
	store: ContentStore,
): Promise<ToolResultMessage> {
	const coldRefs = message.coldRefs;
	if (!coldRefs || coldRefs.length === 0) return message;

	const nextContent: (TextContent | ImageContent)[] = message.content.slice();
	let anyResolved = false;

	for (const entry of coldRefs) {
		const block = nextContent[entry.blockIndex];
		if (!block || block.type !== "text") continue;
		const full = await store.getText(entry.ref);
		if (full === null) {
			logger.warn("Cold tool-result blob missing; rehydration fell back to preview", {
				ref: entry.ref,
				byteLen: entry.byteLen,
				toolName: message.toolName,
			});
			continue;
		}
		nextContent[entry.blockIndex] = { type: "text", text: full };
		anyResolved = true;
	}

	if (!anyResolved) return message;

	// Strip coldRefs on the returned clone so downstream code (providers,
	// extensions) does not see a stale sidecar.
	const { coldRefs: _discard, ...rest } = message;
	return { ...rest, content: nextContent };
}

/**
 * Materialize any cold tool-result messages in a list. Non-tool-result
 * messages and already-warm tool results pass through by reference.
 */
export async function materializeMessages<M extends { role: string }>(
	messages: readonly M[],
	store: ContentStore,
): Promise<M[]> {
	// Fast path: no cold refs anywhere means we can return the input as-is.
	let anyCold = false;
	for (const m of messages) {
		if (m.role === "toolResult" && (m as unknown as ToolResultMessage).coldRefs?.length) {
			anyCold = true;
			break;
		}
	}
	if (!anyCold) return messages.slice();

	const out: M[] = new Array(messages.length);
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "toolResult") {
			const resolved = await materializeToolResult(m as unknown as ToolResultMessage, store);
			out[i] = resolved as unknown as M;
		} else {
			out[i] = m;
		}
	}
	return out;
}
