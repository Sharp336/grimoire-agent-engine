import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeMessage } from "@oh-my-pi/prime-bridge-protocol";
import { BridgeStore, MAX_COMPLETED_OUTBOX_ROWS } from "../src";

const temporaryDirectories: string[] = [];

function message(index: number): BridgeMessage {
	return {
		meshMessageId: `mesh-${index}`,
		idempotencyKey: `idem-${index}`,
		originHarness: "omp",
		originSessionId: "origin",
		targetHarness: "prime",
		targetId: "target",
		body: "body",
		projectRoot: "/project",
		createdAt: new Date(index).toISOString(),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("Prime bridge security hardening", () => {
	it("retains an idempotency tombstone after terminal rows are pruned", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-tombstone-"));
		temporaryDirectories.push(directory);
		const store = BridgeStore.open(path.join(directory, "bridge.sqlite"));
		const first = message(0);
		store.enqueueMessage(first);
		store.recordReceipt({ meshMessageId: first.meshMessageId, status: "delivered" });

		for (let index = 1; index <= MAX_COMPLETED_OUTBOX_ROWS + 1; index += 1) {
			const terminal = message(index);
			store.enqueueMessage(terminal);
			store.recordReceipt({ meshMessageId: terminal.meshMessageId, status: "delivered" });
		}

		expect(store.dedupe(first.idempotencyKey)).toBe(true);
		expect(store.enqueueMessage({ ...first, body: "replay" })).toBe(false);
		store.close();
	});

	it("caps inbox bytes without consuming messages beyond the ordered prefix", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-inbox-cap-"));
		temporaryDirectories.push(directory);
		const store = BridgeStore.open(path.join(directory, "bridge.sqlite"));
		const first = message(1);
		const second = message(2);
		store.putInbox(first);
		store.putInbox(second);

		const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
		expect(store.listInbox({ targetId: "target", peek: false, maxBytes: firstBytes + 2 })).toEqual([first]);
		expect(store.listInbox({ targetId: "target", peek: true })).toEqual([second]);
		store.close();
	});

	it("stores structured audit metadata while redacting secret-looking values", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-audit-"));
		temporaryDirectories.push(directory);
		const store = BridgeStore.open(path.join(directory, "bridge.sqlite"));
		store.appendAudit({
			action: "message_sent",
			direction: "outbound",
			tokenIdentifier: "sha256:abc123",
			originHarness: "omp",
			originSessionId: "session",
			preview: { authorization: "Bearer secret", safe: "yes" },
			createdAt: "2026-08-11T00:00:00.000Z",
		});

		expect(store.listAudit()).toEqual([
			{
				action: "message_sent",
				direction: "outbound",
				tokenIdentifier: "sha256:abc123",
				originHarness: "omp",
				originSessionId: "session",
				createdAt: "2026-08-11T00:00:00.000Z",
				preview: { authorization: "[REDACTED]", safe: "yes" },
			},
		]);
		store.close();
	});
});
