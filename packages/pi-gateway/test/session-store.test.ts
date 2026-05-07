/**
 * Session store tests.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { SQLiteSessionStore } from "../src/session-store";

describe("SQLiteSessionStore", () => {
	let store: SQLiteSessionStore;
	const dbPath = path.join(os.tmpdir(), `pi-gateway-test-${Date.now()}.db`);

	beforeAll(() => {
		store = new SQLiteSessionStore(dbPath);
	});

	afterAll(() => {
		store.close();
		Bun.file(dbPath).delete?.();
	});

	it("creates and retrieves a session", async () => {
		const session = await store.createSession({
			channelId: "dingtalk",
			userId: "user1",
			conversationId: "conv1",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active",
		});

		expect(session.id).toBeDefined();
		expect(session.channelId).toBe("dingtalk");

		const retrieved = await store.getSession("dingtalk", "conv1");
		expect(retrieved).not.toBeNull();
		expect(retrieved?.userId).toBe("user1");
	});

	it("returns null for non-existent session", async () => {
		const result = await store.getSession("none", "none");
		expect(result).toBeNull();
	});

	it("lists active sessions", async () => {
		const sessions = await store.getActiveSessions();
		expect(sessions.length).toBeGreaterThan(0);
	});
});
