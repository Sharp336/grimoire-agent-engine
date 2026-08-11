import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { pageRpcMessages, pageRpcTranscript, type RpcMessageSnapshot } from "../src/modes/rpc/rpc-messages";

function message(index: number, bytes = 32 * 1024): AgentMessage {
	return { role: "user", content: `${index}:${"x".repeat(bytes)}`, timestamp: index };
}

const snapshot: RpcMessageSnapshot = {
	sessionId: "session-1",
	leafId: "leaf-1",
	messageCount: 60,
};

describe("RPC message pagination", () => {
	it("reconstructs a large history from v1-safe pages without loss or overlap", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index));
		const reconstructed: AgentMessage[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			const page = pageRpcMessages(messages, snapshot, { cursor, limit: 256 });
			const encoded = encodeRpcFrame({
				id: `page-${pageCount}`,
				type: "response",
				command: "get_messages_page",
				success: true,
				data: page,
			});
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			expect(JSON.parse(encoded).success).toBe(true);
			reconstructed.push(...page.messages);
			cursor = page.nextCursor;
			pageCount++;
		} while (cursor);

		expect(pageCount).toBeGreaterThan(1);
		expect(reconstructed).toEqual(messages);
	});

	it("rejects a cursor after the session snapshot changes", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const first = pageRpcMessages(messages, snapshot, { limit: 5 });
		expect(first.nextCursor).toBeDefined();

		expect(() =>
			pageRpcMessages(messages, { ...snapshot, leafId: "leaf-2" }, { cursor: first.nextCursor, limit: 5 }),
		).toThrow("RPC message cursor is stale");
	});

	it("returns one individually oversized message so negotiated v2 can carry it losslessly", () => {
		const messages = [message(0, 2 * 1024 * 1024), message(1, 128)];
		const first = pageRpcMessages(
			messages,
			{ sessionId: "session-2", leafId: "leaf-2", messageCount: messages.length },
			{ limit: 10 },
		);

		expect(first.messages).toEqual([messages[0]]);
		expect(first.nextCursor).toBeDefined();
	});
});

describe("RPC display transcript pagination", () => {
	it("returns newest chronological pages with aligned cache markers", () => {
		const messages = Array.from({ length: 10 }, (_, index) => message(index, 8));
		const cacheMissExplainedAt = messages.map((_, index) => index % 2 === 0);
		const transcriptSnapshot = { sessionId: "session-t", leafId: "leaf-t", messageCount: messages.length };

		const newest = pageRpcTranscript(messages, cacheMissExplainedAt, transcriptSnapshot, {
			limit: 3,
			collapseCompactedHistory: true,
		});
		expect(newest.messages).toEqual(messages.slice(7));
		expect(newest.cacheMissExplainedAt).toEqual(cacheMissExplainedAt.slice(7));
		expect(newest.startIndex).toBe(7);
		expect(newest.totalMessages).toBe(10);
		expect(newest.olderCursor).toBeDefined();

		const older = pageRpcTranscript(messages, cacheMissExplainedAt, transcriptSnapshot, {
			cursor: newest.olderCursor,
			limit: 3,
		});
		expect(older.messages).toEqual(messages.slice(4, 7));
		expect(older.cacheMissExplainedAt).toEqual(cacheMissExplainedAt.slice(4, 7));
		expect(older.startIndex).toBe(4);
	});

	it("omits the older cursor when the page reaches index zero", () => {
		const messages = [message(0, 8), message(1, 8)];
		const page = pageRpcTranscript(
			messages,
			[false, true],
			{ sessionId: "session-t", leafId: null, messageCount: 2 },
			{ limit: 2 },
		);
		expect(page.startIndex).toBe(0);
		expect(page.olderCursor).toBeUndefined();
	});

	it("keeps pages within the encoded byte budget unless one message is individually oversized", () => {
		const messages = [message(0, 400 * 1024), message(1, 400 * 1024), message(2, 16)];
		const page = pageRpcTranscript(
			messages,
			[false, false, false],
			{ sessionId: "session-t", leafId: null, messageCount: 3 },
			{ limit: 3 },
		);
		expect(page.messages).toEqual(messages.slice(1));

		const oversized = [message(0, 2 * 1024 * 1024)];
		expect(
			pageRpcTranscript(oversized, [false], { sessionId: "session-t", leafId: null, messageCount: 1 }, { limit: 3 })
				.messages,
		).toEqual(oversized);
	});

	it("rejects malformed, changed-snapshot, and collapse-mismatched cursors", () => {
		const messages = Array.from({ length: 4 }, (_, index) => message(index, 8));
		const flags = [false, false, true, false];
		const transcriptSnapshot = { sessionId: "session-t", leafId: "leaf-t", messageCount: 4 };
		const newest = pageRpcTranscript(messages, flags, transcriptSnapshot, {
			limit: 2,
			collapseCompactedHistory: true,
		});

		expect(() =>
			pageRpcTranscript(messages, flags, { ...transcriptSnapshot, leafId: "other" }, { cursor: newest.olderCursor }),
		).toThrow("RPC message cursor is stale");
		expect(() =>
			pageRpcTranscript(messages, flags, transcriptSnapshot, {
				cursor: newest.olderCursor,
				collapseCompactedHistory: false,
			}),
		).toThrow("RPC message cursor is stale");
		expect(() => pageRpcTranscript(messages, flags, transcriptSnapshot, { cursor: "not+a+cursor" })).toThrow(
			"RPC message cursor is stale",
		);
	});
});
