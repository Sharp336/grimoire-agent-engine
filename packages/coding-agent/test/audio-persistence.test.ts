import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioContent } from "@oh-my-pi/pi-ai";
import { BlobStore, resolveImageData } from "../src/session/blob-store";
import type { CustomMessageEntry } from "../src/session/session-entries";
import { prepareEntryForPersistence } from "../src/session/session-persistence";

describe("audio blob persistence", () => {
	it("externalizes large audio to the blob store and restores it without truncation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-audio-blob-"));
		try {
			const blobStore = new BlobStore(dir);
			// 1 MiB of base64 — well over MAX_PERSIST_CHARS (500k), which would corrupt
			// a naive inline value, and over the blob-externalize threshold (1024).
			const original = "A".repeat(1024 * 1024);
			const entry = {
				type: "custom_message",
				id: "msg-1",
				customType: "test",
				content: [{ type: "audio", data: original, mimeType: "audio/wav" }],
				display: true,
			} as CustomMessageEntry;

			const prepared = prepareEntryForPersistence(entry, blobStore);
			if (prepared.type !== "custom_message") {
				throw new Error("expected custom_message entry");
			}
			const block = Array.isArray(prepared.content)
				? prepared.content.find((c): c is AudioContent => c.type === "audio")
				: undefined;
			expect(block).toBeDefined();
			// Must be externalized to a blob ref, not truncated to ~500k chars.
			expect(block!.data.startsWith("blob:sha256:")).toBe(true);
			expect(block!.data.length).toBeLessThan(original.length);

			// Round-trip: resolving the ref restores the full original base64.
			const restored = await resolveImageData(blobStore, block!.data);
			expect(restored).toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
