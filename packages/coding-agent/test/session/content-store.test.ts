import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	ContentStore,
	HOLLOW_THRESHOLD_BYTES,
	hollowToolResultInPlace,
	materializeMessages,
	materializeToolResult,
	PREVIEW_BYTES,
} from "@oh-my-pi/pi-coding-agent/session/content-store";

// Large enough to cross the threshold on every test without wasting heap.
const LARGE_TEXT = "A".repeat(HOLLOW_THRESHOLD_BYTES + 1024);

function makeToolResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: LARGE_TEXT }],
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

describe("ContentStore", () => {
	let tmpDir: string;
	let store: ContentStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-store-test-"));
		store = new ContentStore(new BlobStore(tmpDir));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("put/get round-trips utf-8 text exactly", async () => {
		const text = "résumé 💾 日本語\n\tlines";
		const { ref, byteLen } = await store.putText(text);
		expect(byteLen).toBe(Buffer.byteLength(text, "utf-8"));
		expect(ref.startsWith("blob:sha256:")).toBe(true);
		expect(await store.getText(ref)).toBe(text);
	});

	it("deduplicates by content hash", async () => {
		const a = await store.putText("same");
		const b = await store.putText("same");
		expect(a.ref).toBe(b.ref);
	});

	it("evicts the least-recently-used entry when over budget", async () => {
		// 10 KB budget so two 6 KB entries cannot coexist.
		const tight = new ContentStore(new BlobStore(tmpDir), { budgetBytes: 10 * 1024 });
		const { ref: refA } = await tight.putText("A".repeat(6 * 1024));
		const { ref: refB } = await tight.putText("B".repeat(6 * 1024));
		// LRU bookkeeping: A was admitted, then B. A must have been evicted.
		expect(tight.cacheBytes).toBeLessThanOrEqual(10 * 1024);
		// After eviction, disk still holds A — get should repopulate the cache.
		const restored = await tight.getText(refA);
		expect(restored).not.toBeNull();
		expect(restored?.[0]).toBe("A");
		// B should now be the eviction victim.
		const bAfter = await tight.getText(refB);
		expect(bAfter?.[0]).toBe("B");
	});

	it("returns null when a ref is missing on disk", async () => {
		const missing = await store.getText("blob:sha256:deadbeef");
		expect(missing).toBeNull();
	});
});

describe("hollowToolResultInPlace + materializeToolResult", () => {
	let tmpDir: string;
	let store: ContentStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-store-test-"));
		store = new ContentStore(new BlobStore(tmpDir));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("hollow replaces large text with a preview and records coldRefs", async () => {
		const msg = makeToolResult();
		const externalized = await hollowToolResultInPlace(msg, store);
		expect(externalized).toBe(1);
		expect(msg.coldRefs).toHaveLength(1);
		expect(msg.coldRefs?.[0].blockIndex).toBe(0);
		expect(msg.coldRefs?.[0].byteLen).toBe(Buffer.byteLength(LARGE_TEXT, "utf-8"));

		// Inline text is now a preview (at or below the preview budget).
		const inline = (msg.content[0] as { text: string }).text;
		expect(Buffer.byteLength(inline, "utf-8")).toBeLessThanOrEqual(PREVIEW_BYTES);
		expect(inline.length).toBeGreaterThan(0);
	});

	it("materialize restores full text and clears coldRefs on the clone", async () => {
		const msg = makeToolResult();
		await hollowToolResultInPlace(msg, store);

		const warm = await materializeToolResult(msg, store);
		expect(warm).not.toBe(msg); // new object, original stays hollow
		expect(warm.coldRefs).toBeUndefined();
		expect(warm.content).toHaveLength(1);
		expect(warm.content[0].type).toBe("text");
		expect((warm.content[0] as { text: string }).text).toBe(LARGE_TEXT);

		// Original message stays hollow (caller's memory stays low).
		expect(msg.coldRefs).toBeDefined();
		expect((msg.content[0] as { text: string }).text.length).toBeLessThan(LARGE_TEXT.length);
	});

	it("leaves small text blocks untouched", async () => {
		const msg = makeToolResult({
			content: [{ type: "text", text: "tiny output" }],
		});
		const externalized = await hollowToolResultInPlace(msg, store);
		expect(externalized).toBe(0);
		expect(msg.coldRefs).toBeUndefined();
		expect((msg.content[0] as { text: string }).text).toBe("tiny output");
	});

	it("is idempotent: re-hollowing a cold message is a no-op", async () => {
		const msg = makeToolResult();
		await hollowToolResultInPlace(msg, store);
		const coldBefore = JSON.stringify(msg.coldRefs);
		const externalized = await hollowToolResultInPlace(msg, store);
		expect(externalized).toBe(0);
		expect(JSON.stringify(msg.coldRefs)).toBe(coldBefore);
	});

	it("only hollows blocks that exceed the threshold, preserving sibling blocks", async () => {
		const msg = makeToolResult({
			content: [
				{ type: "text", text: "small" },
				{ type: "text", text: LARGE_TEXT },
				{ type: "text", text: "also small" },
			],
		});
		const externalized = await hollowToolResultInPlace(msg, store);
		expect(externalized).toBe(1);
		expect(msg.coldRefs).toHaveLength(1);
		expect(msg.coldRefs?.[0].blockIndex).toBe(1);
		expect((msg.content[0] as { text: string }).text).toBe("small");
		expect((msg.content[2] as { text: string }).text).toBe("also small");

		const warm = await materializeToolResult(msg, store);
		expect((warm.content[0] as { text: string }).text).toBe("small");
		expect((warm.content[1] as { text: string }).text).toBe(LARGE_TEXT);
		expect((warm.content[2] as { text: string }).text).toBe("also small");
	});

	it("falls back to preview when blob is missing on disk", async () => {
		const msg = makeToolResult();
		await hollowToolResultInPlace(msg, store);

		// Nuke the blob to simulate corruption.
		const files = await fs.readdir(tmpDir);
		await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f))));
		// Also evict from the in-memory cache so getText falls through to disk.
		store = new ContentStore(new BlobStore(tmpDir));

		const warm = await materializeToolResult(msg, store);
		// Rehydration failed: returned message must still be usable, preview survives.
		const text = (warm.content[0] as { text: string }).text;
		expect(text.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThan(LARGE_TEXT.length);
	});
});

describe("materializeMessages", () => {
	let tmpDir: string;
	let store: ContentStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-store-test-"));
		store = new ContentStore(new BlobStore(tmpDir));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns a shallow copy when no messages are cold", async () => {
		const messages = [
			{ role: "user" as const, content: "hi", timestamp: 1 },
			makeToolResult({ content: [{ type: "text", text: "tiny" }] }),
		];
		const out = await materializeMessages(messages, store);
		expect(out).not.toBe(messages);
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
	});

	it("materializes only cold tool results and passes other messages by reference", async () => {
		const user = { role: "user" as const, content: "hi", timestamp: 1 };
		const cold = makeToolResult();
		await hollowToolResultInPlace(cold, store);
		const small = makeToolResult({
			toolCallId: "call-2",
			content: [{ type: "text", text: "tiny" }],
		});

		const out = await materializeMessages([user, cold, small], store);
		expect(out).toHaveLength(3);
		expect(out[0]).toBe(user);
		expect(out[2]).toBe(small);
		// Cold message got materialized into a new object with full text.
		expect(out[1]).not.toBe(cold);
		const warmContent = (out[1] as ToolResultMessage).content[0] as { text: string };
		expect(warmContent.text).toBe(LARGE_TEXT);
		// Original remains hollow — memory stays low on caller's side.
		expect(cold.coldRefs).toBeDefined();
	});
});
