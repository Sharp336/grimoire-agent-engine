import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeMessage, BridgeReceipt, PrimeDaemonCursor } from "@oh-my-pi/prime-bridge-protocol";
import { BridgeStore } from "../src";

const tempDirectories: string[] = [];

async function makeDatabasePath(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-store-"));
	tempDirectories.push(directory);
	return path.join(directory, "bridge.sqlite");
}

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "omp",
		originSessionId: "session-1",
		targetHarness: "prime",
		targetId: "prime-1",
		body: "hello",
		projectRoot: "/repo",
		createdAt: "2026-08-11T00:00:00.000Z",
		...overrides,
	};
}

async function removeTempDirectories(): Promise<void> {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
}

afterEach(removeTempDirectories);

describe("BridgeStore", () => {
	it("persists independent session cursors across reopen", async () => {
		const databasePath = await makeDatabasePath();
		const firstCursor: PrimeDaemonCursor = { generation: "generation-1", sequence: 4, future: { retained: true } };
		const secondCursor: PrimeDaemonCursor = { generation: "generation-2", sequence: 9, future: { retained: false } };
		const first = BridgeStore.open(databasePath);
		const clientId = first.getOrCreateClientId();
		first.setCursor("session-1", firstCursor);
		first.setCursor("session-2", secondCursor);
		first.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.getOrCreateClientId()).toBe(clientId);
		expect(reopened.getCursor("session-1")).toEqual(firstCursor);
		expect(reopened.getCursor("session-2")).toEqual(secondCursor);
		reopened.close();
	});

	it("updates only the selected session cursor", async () => {
		const databasePath = await makeDatabasePath();
		const firstCursor: PrimeDaemonCursor = { generation: "generation-1", sequence: 4 };
		const secondCursor: PrimeDaemonCursor = { generation: "generation-2", sequence: 9 };
		const updatedCursor: PrimeDaemonCursor = { generation: "generation-3", sequence: 12 };
		const store = BridgeStore.open(databasePath);
		store.setCursor("session-1", firstCursor);
		store.setCursor("session-2", secondCursor);
		store.setCursor("session-1", updatedCursor);

		expect(store.getCursor("session-1")).toEqual(updatedCursor);
		expect(store.getCursor("session-2")).toEqual(secondCursor);
		store.close();
	});

	it("deduplicates enqueue by idempotency key while preserving exact message JSON", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const original = { ...message(), futureField: { retained: true } } as BridgeMessage & {
			futureField: { retained: boolean };
		};

		expect(store.enqueueMessage(original)).toBe(true);
		expect(store.enqueueMessage({ ...original, meshMessageId: "mesh-2" })).toBe(false);

		const database = new Database(databasePath, { readonly: true });
		const rows = database
			.prepare("SELECT message_json FROM outbox WHERE idempotency_key = ?")
			.all(original.idempotencyKey) as Array<{ message_json: string }>;
		database.close();
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]?.message_json ?? "null")).toEqual(original);
		store.close();
	});

	it("reclaims an expired message claim", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const pending = message();
		store.enqueueMessage(pending);

		const firstClaim = store.claimPendingMessages({ now: 1_000, leaseMs: 5_000 });
		expect(firstClaim).toHaveLength(1);
		expect(firstClaim[0]).toMatchObject({ message: pending, claimedUntilMs: 6_000 });
		expect(firstClaim[0]?.claimToken).toEqual(expect.any(String));
		expect(store.claimPendingMessages({ now: 2_000, leaseMs: 5_000 })).toEqual([]);
		const reclaimed = store.claimPendingMessages({ now: 6_000, leaseMs: 5_000 });
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]).toMatchObject({ message: pending, claimedUntilMs: 11_000 });
		expect(reclaimed[0]?.claimToken).toEqual(expect.any(String));
		expect(reclaimed[0]?.claimToken).not.toBe(firstClaim[0]?.claimToken);
		store.close();
	});

	it("claims inbox messages without consuming and recovers after lease expiry", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const incoming = message({ targetHarness: "omp", targetId: "session-claim" });
		expect(store.putInbox(incoming)).toBe(true);
		const first = store.claimInboxForTarget(incoming.targetId, undefined, { now: 1_000, leaseMs: 5_000 });
		expect(first).toMatchObject({ message: incoming, claimedUntilMs: 6_000 });
		expect(store.claimInboxForTarget(incoming.targetId, undefined, { now: 2_000, leaseMs: 5_000 })).toBeNull();
		const recovered = store.claimInboxForTarget(incoming.targetId, undefined, { now: 6_000, leaseMs: 5_000 });
		expect(recovered?.message).toEqual(incoming);
		expect(recovered?.claimToken).not.toBe(first?.claimToken);
		expect(store.listInbox({ targetId: incoming.targetId, peek: true })).toEqual([incoming]);
		store.close();
	});

	it("acknowledges the winner and releases only its opaque inbox claim", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const incoming = message({ targetHarness: "omp", targetId: "session-ack" });
		expect(store.putInbox(incoming)).toBe(true);
		const claim = store.claimInboxForTarget(incoming.targetId, undefined, { now: Date.now(), leaseMs: 5_000 });
		expect(claim).not.toBeNull();
		expect(store.releaseInboxClaim("stale-claim")).toBe(false);
		expect(store.ackInboxClaim(claim?.claimToken ?? "")).toBe(true);
		expect(store.listInbox({ targetId: incoming.targetId, peek: true })).toEqual([]);
		store.close();
	});

	it("rejects stale claim tokens while allowing the current claimant to complete", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const pending = message({ meshMessageId: "mesh-claims", idempotencyKey: "idem-claims" });
		store.enqueueMessage(pending);

		const firstClaim = store.claimPendingMessages({ now: 1_000, leaseMs: 5_000 })[0];
		const currentClaim = store.claimPendingMessages({ now: 6_000, leaseMs: 5_000 })[0];
		expect(firstClaim).toBeDefined();
		expect(currentClaim).toBeDefined();
		expect(
			store.recordReceipt(
				{ meshMessageId: pending.meshMessageId, status: "delivered" },
				firstClaim?.claimToken ?? "",
			),
		).toBe(false);
		expect(
			store.recordReceipt(
				{ meshMessageId: pending.meshMessageId, status: "delivered" },
				currentClaim?.claimToken ?? "",
			),
		).toBe(true);
		expect(store.claimPendingMessages({ now: 7_000, leaseMs: 5_000 })).toEqual([]);
		store.close();
	});

	it("releases only the current claim for retry", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const pending = message({ meshMessageId: "mesh-failure", idempotencyKey: "idem-failure" });
		store.enqueueMessage(pending);
		const claim = store.claimPendingMessages({ now: 1_000, leaseMs: 5_000 })[0];
		expect(claim).toBeDefined();
		expect(store.recordDeliveryFailure(pending.meshMessageId, "stale-token")).toBe(false);
		expect(store.recordDeliveryFailure(pending.meshMessageId, claim?.claimToken ?? "")).toBe(true);
		const retry = store.claimPendingMessages({ now: 2_000, leaseMs: 5_000 });
		expect(retry).toHaveLength(1);
		expect(retry[0]?.message).toEqual(pending);
		store.close();
	});

	it("rejects claim times that overflow safe integer bounds without consuming the row", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const pending = message({ meshMessageId: "mesh-overflow", idempotencyKey: "idem-overflow" });
		store.enqueueMessage(pending);

		expect(() =>
			store.claimPendingMessages({
				now: Number.MAX_SAFE_INTEGER - 1,
				leaseMs: 2,
			}),
		).toThrow(/safe integer|overflow/i);
		expect(store.claimPendingMessages({ now: 1_000, leaseMs: 5_000 })[0]?.message).toEqual(pending);
		store.close();
	});

	it("persists exact receipt and inbox JSON", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const inboxMessage = { ...message(), futureMessageField: ["retained"] } as BridgeMessage & {
			futureMessageField: string[];
		};
		const outboxMessage = { ...inboxMessage, meshMessageId: "mesh-outbox", idempotencyKey: "idem-outbox" };
		const receipt = {
			meshMessageId: outboxMessage.meshMessageId,
			status: "delivered",
			futureReceiptField: { retained: true },
		} as BridgeReceipt & { futureReceiptField: { retained: boolean } };

		expect(store.putInbox(inboxMessage)).toBe(true);
		expect(store.enqueueMessage(outboxMessage)).toBe(true);
		const claim = store.claimPendingMessages({ now: 1_000, leaseMs: 100 })[0];
		expect(claim?.message).toEqual(outboxMessage);
		store.recordReceipt(receipt, claim?.claimToken ?? "");
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.claimPendingMessages({ now: 10_000, leaseMs: 100 })).toEqual([]);
		const database = new Database(databasePath, { readonly: true });
		const inboxRow = database
			.prepare("SELECT message_json FROM inbox WHERE mesh_message_id = ?")
			.get(inboxMessage.meshMessageId) as { message_json: string } | undefined;
		const receiptRow = database
			.prepare("SELECT receipt_json FROM receipts WHERE mesh_message_id = ? AND status = ?")
			.get(receipt.meshMessageId, receipt.status) as { receipt_json: string } | undefined;
		database.close();
		expect(JSON.parse(inboxRow?.message_json ?? "null")).toEqual(inboxMessage);
		expect(JSON.parse(receiptRow?.receipt_json ?? "null")).toEqual(receipt);
		expect(reopened.dedupe(inboxMessage.idempotencyKey)).toBe(true);
		reopened.close();
	});

	it("redacts bearer values from audit previews", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		store.appendAudit({
			action: "send_message",
			preview: {
				authorization: "Bearer top-secret-token",
				token: "plain-token-secret",
				nested: "prefix Bearer another-secret suffix",
				message: "safe preview",
			},
		});

		const database = new Database(databasePath, { readonly: true });
		const row = database.prepare("SELECT preview_json FROM audit ORDER BY id DESC LIMIT 1").get() as {
			preview_json: string;
		};
		database.close();
		const preview = JSON.parse(row.preview_json) as {
			authorization: string;
			token: string;
			nested: string;
			message: string;
		};
		expect(row.preview_json).not.toContain("top-secret-token");
		expect(row.preview_json).not.toContain("plain-token-secret");
		expect(row.preview_json).not.toContain("another-secret");
		expect(preview.authorization).toBe("[REDACTED]");
		expect(preview.token).toBe("[REDACTED]");
		expect(preview.nested).not.toContain("top-secret-token");
		expect(preview.nested).not.toContain("another-secret");
		expect(preview.message).toBe("safe preview");
		store.close();
	});
	it("lists unconsumed inbox messages and atomically consumes them", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const first = message({ meshMessageId: "mesh-inbox-1", idempotencyKey: "idem-inbox-1" });
		const second = message({ meshMessageId: "mesh-inbox-2", idempotencyKey: "idem-inbox-2" });
		store.putInbox(first);
		store.putInbox(second);

		expect(store.listInbox({ peek: true })).toEqual([first, second]);
		expect(store.listInbox({ peek: false })).toEqual([first, second]);
		expect(store.listInbox({ peek: true })).toEqual([]);
		expect(store.dedupe(first.idempotencyKey)).toBe(true);
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.listInbox({ peek: true })).toEqual([]);
		reopened.close();
	});
	it("does not consume inbox rows with live claims", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const incoming = message({
			meshMessageId: "mesh-inbox-live-claim",
			idempotencyKey: "idem-inbox-live-claim",
			targetId: "session-live-claim",
		});
		expect(store.putInbox(incoming)).toBe(true);
		const claim = store.claimInboxForTarget(incoming.targetId, undefined, {
			now: Date.now(),
			leaseMs: 60_000,
		});
		expect(claim).not.toBeNull();

		expect(store.listInbox({ peek: true })).toEqual([incoming]);
		expect(store.listInbox({ peek: false })).toEqual([]);
		expect(store.listInbox({ peek: true })).toEqual([incoming]);
		store.close();
	});

	it("consumes expired inbox claims and clears their claim fields", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const incoming = message({
			meshMessageId: "mesh-inbox-expired-claim",
			idempotencyKey: "idem-inbox-expired-claim",
			targetId: "session-expired-claim",
		});
		expect(store.putInbox(incoming)).toBe(true);
		const claim = store.claimInboxForTarget(incoming.targetId, undefined, { now: 1_000, leaseMs: 5_000 });
		expect(claim).not.toBeNull();

		expect(store.listInbox({ peek: false })).toEqual([incoming]);
		const database = new Database(databasePath, { readonly: true });
		const row = database
			.prepare("SELECT consumed_at, claim_token, claimed_until_ms FROM inbox WHERE mesh_message_id = ?")
			.get(incoming.meshMessageId) as {
			consumed_at: string | null;
			claim_token: string | null;
			claimed_until_ms: number | null;
		};
		database.close();
		expect(row.consumed_at).toEqual(expect.any(String));
		expect(row.claim_token).toBeNull();
		expect(row.claimed_until_ms).toBeNull();
		store.close();
	});

	it("takes the first matching inbox message and preserves receipt lookup", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const first = message({
			meshMessageId: "mesh-take-1",
			idempotencyKey: "idem-take-1",
			originSessionId: "session-a",
		});
		const second = message({
			meshMessageId: "mesh-take-2",
			idempotencyKey: "idem-take-2",
			originSessionId: "session-b",
		});
		store.putInbox(first);
		store.putInbox(second);
		const receipt = {
			meshMessageId: first.meshMessageId,
			status: "queued",
			rawField: { retained: true },
		} as BridgeReceipt & {
			rawField: { retained: boolean };
		};
		store.recordReceipt(receipt);

		expect(store.takeFirstInbox("session-b")).toEqual(second);
		expect(store.takeFirstInbox()).toEqual(first);
		expect(store.takeFirstInbox()).toBeNull();
		expect(store.getLatestReceipt(first.meshMessageId)).toEqual(receipt);
		store.close();
	});

	it("finds receipts and audit entries by idempotency key without exposing secrets", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const pending = message({ meshMessageId: "mesh-receipt", idempotencyKey: "idem-receipt" });
		store.enqueueMessage(pending);
		const receipt = {
			meshMessageId: pending.meshMessageId,
			status: "delivered",
			extra: "preserved",
		} as BridgeReceipt & {
			extra: string;
		};
		store.recordReceipt(receipt);
		store.appendAudit({
			action: "send_message",
			preview: { token: "do-not-return", safe: "yes" },
			createdAt: "2026-08-11T00:00:00.000Z",
		});

		expect(store.getReceiptForIdempotencyKey(pending.idempotencyKey)).toEqual(receipt);
		expect(store.listAudit()).toEqual([
			{
				action: "send_message",
				preview: { token: "[REDACTED]", safe: "yes" },
				createdAt: "2026-08-11T00:00:00.000Z",
			},
		]);
		store.close();
	});

	it("persists the exact serialized command envelope across restart", async () => {
		const databasePath = await makeDatabasePath();
		const envelopeJson = '{"commandId":"cmd-1","method":"prompt","params":{"text":"hello"}}\n';
		const createdAt = "2026-08-11T00:00:00.000Z";
		const store = BridgeStore.open(databasePath);
		expect(store.persistCommand("cmd-1", envelopeJson, createdAt)).toEqual({
			commandId: "cmd-1",
			envelopeJson,
			responseJson: null,
			createdAt,
		});
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.listPendingCommands()).toEqual([
			{
				commandId: "cmd-1",
				envelopeJson,
				responseJson: null,
				createdAt,
			},
		]);
		reopened.close();
	});

	it("persists a received command response before acknowledgement", async () => {
		const databasePath = await makeDatabasePath();
		const envelopeJson = '{"commandId":"cmd-response","method":"prompt"}\n';
		const responseJson = '{"commandId":"cmd-response","ok":true}\n';
		const store = BridgeStore.open(databasePath);
		store.persistCommand("cmd-response", envelopeJson, "2026-08-11T00:01:00.000Z");
		expect(store.recordCommandResponse("cmd-response", responseJson)).toEqual({
			commandId: "cmd-response",
			envelopeJson,
			responseJson,
			createdAt: "2026-08-11T00:01:00.000Z",
		});
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.listPendingCommands()[0]?.responseJson).toBe(responseJson);
		reopened.close();
	});

	it("reuses a command id only for byte-identical envelopes", async () => {
		const databasePath = await makeDatabasePath();
		const envelopeJson = '{"commandId":"cmd-idempotent","params":{"value":1}}\n';
		const store = BridgeStore.open(databasePath);
		const first = store.persistCommand("cmd-idempotent", envelopeJson, "2026-08-11T00:02:00.000Z");
		const retry = store.persistCommand("cmd-idempotent", envelopeJson, "2026-08-11T00:03:00.000Z");
		expect(retry).toEqual(first);
		expect(() =>
			store.persistCommand("cmd-idempotent", '{"commandId":"cmd-idempotent","params":{"value":2}}\n'),
		).toThrow(/different envelope/i);
		expect(store.listPendingCommands()).toHaveLength(1);
		store.close();
	});

	it("recovers multiple outstanding commands in deterministic order", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		store.persistCommand("cmd-b", '{"commandId":"cmd-b"}\n', "2026-08-11T00:04:00.000Z");
		store.persistCommand("cmd-a", '{"commandId":"cmd-a"}\n', "2026-08-11T00:05:00.000Z");
		store.persistCommand("cmd-c", '{"commandId":"cmd-c"}\n', "2026-08-11T00:06:00.000Z");
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.listPendingCommands().map(command => command.commandId)).toEqual(["cmd-b", "cmd-a", "cmd-c"]);
		reopened.close();
	});

	it("removes a command only after explicit completion", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		store.persistCommand("cmd-complete", '{"commandId":"cmd-complete"}\n', "2026-08-11T00:07:00.000Z");
		expect(() => store.completeCommand("cmd-complete")).toThrow(/response/i);
		store.recordCommandResponse("cmd-complete", '{"commandId":"cmd-complete","ok":true}\n');
		expect(store.listPendingCommands()).toHaveLength(1);
		store.completeCommand("cmd-complete");
		expect(store.listPendingCommands()).toEqual([]);
		store.close();

		const reopened = BridgeStore.open(databasePath);
		expect(reopened.listPendingCommands()).toEqual([]);
		reopened.close();
	});
	it("isolates inbox consumption by target session and preserves unmatched senders", async () => {
		const databasePath = await makeDatabasePath();
		const store = BridgeStore.open(databasePath);
		const first = message({
			meshMessageId: "mesh-target-a-1",
			idempotencyKey: "idem-target-a-1",
			targetHarness: "omp",
			targetId: "omp-a",
			originSessionId: "sender-a",
		});
		const second = message({
			meshMessageId: "mesh-target-a-2",
			idempotencyKey: "idem-target-a-2",
			targetHarness: "omp",
			targetId: "omp-a",
			originSessionId: "sender-b",
		});
		const other = message({
			meshMessageId: "mesh-target-b-1",
			idempotencyKey: "idem-target-b-1",
			targetHarness: "omp",
			targetId: "omp-b",
			originSessionId: "sender-b",
		});
		store.putInbox(first);
		store.putInbox(second);
		store.putInbox(other);

		expect(store.takeFirstInboxForTarget("omp-a", "missing-sender")).toBeNull();
		expect(store.listInbox({ targetId: "omp-a", peek: true })).toEqual([first, second]);
		expect(store.takeFirstInboxForTarget("omp-a", "sender-b")).toEqual(second);
		expect(store.listInbox({ targetId: "omp-b", peek: true })).toEqual([other]);
		store.close();
	});
});
