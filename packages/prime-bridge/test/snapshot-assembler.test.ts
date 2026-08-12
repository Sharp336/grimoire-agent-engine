import { describe, expect, it } from "bun:test";
import { SnapshotAssembler } from "../src/prime/snapshot-assembler";

describe("SnapshotAssembler", () => {
	it("rejects aggregate snapshot bytes beyond the configured limit", () => {
		const assembler = new SnapshotAssembler({ maxBytes: 64, maxChunks: 4, maxMessages: 4 });
		assembler.add({
			type: "session_snapshot_begin",
			activeSessionId: "session",
			snapshotId: "snapshot",
			messageCount: 1,
			targetChunkBytes: 1,
			snapshot: { activeSessionId: "session" },
		});

		expect(() =>
			assembler.add({
				type: "session_snapshot_chunk",
				activeSessionId: "session",
				snapshotId: "snapshot",
				index: 0,
				messages: [{ content: "x".repeat(128) }],
			}),
		).toThrow("snapshot bytes");
	});

	it("bounds aggregate bytes across streams and releases completed or reset state", () => {
		const assembler = new SnapshotAssembler({ maxBytes: 50 });
		const begin = (activeSessionId: string) => ({
			type: "session_snapshot_begin",
			activeSessionId,
			snapshotId: "snapshot",
			messageCount: 0,
			targetChunkBytes: 1,
			snapshot: { activeSessionId },
		});

		assembler.add(begin("a"));
		assembler.add(begin("b"));
		expect(() => assembler.add(begin("c"))).toThrow("snapshot exceeds limits");

		assembler.add({
			type: "session_snapshot_end",
			activeSessionId: "a",
			snapshotId: "snapshot",
			chunkCount: 0,
			lastEventSequence: 1,
		});
		expect(() => assembler.add(begin("c"))).not.toThrow();

		assembler.resetSession("b");
		expect(() => assembler.add(begin("d"))).not.toThrow();
		expect(() =>
			assembler.add({
				type: "session_snapshot_failed",
				activeSessionId: "c",
				snapshotId: "snapshot",
				error: "failed",
			}),
		).toThrow("failed");
		expect(() => assembler.add(begin("e"))).not.toThrow();
	});

	it("releases retained bytes when a snapshot chunk fails", () => {
		const assembler = new SnapshotAssembler({ maxBytes: 50 });
		const begin = (activeSessionId: string) => ({
			type: "session_snapshot_begin",
			activeSessionId,
			snapshotId: "snapshot",
			messageCount: 1,
			targetChunkBytes: 1,
			snapshot: { activeSessionId },
		});
		assembler.add(begin("a"));
		expect(() =>
			assembler.add({
				type: "session_snapshot_chunk",
				activeSessionId: "a",
				snapshotId: "snapshot",
				index: 0,
				messages: [{ content: "x".repeat(64) }],
			}),
		).toThrow("snapshot bytes");
		expect(() => {
			assembler.add(begin("b"));
			assembler.reset();
			assembler.add(begin("c"));
		}).not.toThrow();
	});

	it("assembles a normal snapshot across multiple 512 KiB chunks", () => {
		const assembler = new SnapshotAssembler();
		const message = { content: "x".repeat(300 * 1024) };
		assembler.add({
			type: "session_snapshot_begin",
			activeSessionId: "session",
			snapshotId: "snapshot",
			messageCount: 2,
			targetChunkBytes: 512 * 1024,
			snapshot: { activeSessionId: "session" },
		});
		assembler.add({
			type: "session_snapshot_chunk",
			activeSessionId: "session",
			snapshotId: "snapshot",
			index: 0,
			messages: [message],
		});
		assembler.add({
			type: "session_snapshot_chunk",
			activeSessionId: "session",
			snapshotId: "snapshot",
			index: 1,
			messages: [message],
		});

		const result = assembler.add({
			type: "session_snapshot_end",
			activeSessionId: "session",
			snapshotId: "snapshot",
			chunkCount: 2,
			lastEventSequence: 7,
		});
		expect(result?.snapshot.messages).toHaveLength(2);
	});

	it("keeps snapshot streams distinct when IDs contain NUL", () => {
		const assembler = new SnapshotAssembler();
		assembler.add({
			type: "session_snapshot_begin",
			activeSessionId: "a",
			snapshotId: "b\u0000c",
			messageCount: 0,
			targetChunkBytes: 512 * 1024,
			snapshot: { activeSessionId: "a" },
		});
		expect(() =>
			assembler.add({
				type: "session_snapshot_begin",
				activeSessionId: "a\u0000b",
				snapshotId: "c",
				messageCount: 0,
				targetChunkBytes: 512 * 1024,
				snapshot: { activeSessionId: "a\u0000b" },
			}),
		).not.toThrow();
	});

	it("defaults the aggregate snapshot limit to 256 MiB", () => {
		expect(new SnapshotAssembler().maxBytes).toBe(256 * 1024 * 1024);
	});
});
