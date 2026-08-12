import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeMessage, BridgeReceipt } from "@oh-my-pi/prime-bridge-protocol";
import { resolveBridgeConfig } from "../src/config";
import { CommandResultUncertainError } from "../src/prime/client";
import { MAX_ACTIVE_WAITERS, MAX_WAIT_TIMEOUT_MS, type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";
import { BridgeStore, type ClaimedInboxMessage } from "../src/store";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

function message(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-message",
		idempotencyKey: "idem-message",
		originHarness: "omp",
		originSessionId: "origin-session",
		targetHarness: "prime",
		targetId: "target-session",
		body: "hello",
		projectRoot: "/project",
		createdAt: "2026-08-11T00:00:00.000Z",
		...overrides,
	};
}

async function makeServer(
	options: { store?: BridgeStore; primeClient?: unknown } = {},
): Promise<{ server: PrimeBridgeServer; store: BridgeStore; databasePath: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-messages-"));
	temporaryDirectories.push(stateDir);
	const databasePath = path.join(stateDir, "bridge.sqlite");
	const store = options.store ?? BridgeStore.open(databasePath);
	const config = resolveBridgeConfig({
		stateDir,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		port: 0,
	});
	const server = await startPrimeBridgeServer({ config, store, primeClient: options.primeClient as never });
	runningServers.push(server);
	return { server, store, databasePath };
}

async function request(server: PrimeBridgeServer, method: string, pathname: string, body?: unknown): Promise<Response> {
	return fetch(`${server.url}${pathname}`, {
		method,
		headers: {
			authorization: `Bearer ${server.token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function stopResources(): Promise<void> {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
}

afterEach(stopResources);

describe("authenticated bridge message routes", () => {
	it("preserves the raw Prime receipt and sends a duplicate only once", async () => {
		let sendCount = 0;
		const primeClient = {
			sendMessage: async () => {
				sendCount += 1;
				return {
					status: "delivered",
					deliveryStatus: "queued",
					daemonReceiptId: "receipt-1",
					nested: { retained: true },
				};
			},
		};
		const { server, store } = await makeServer({ primeClient });
		const payload = message();

		const first = await request(server, "POST", "/v1/messages", payload);
		const duplicate = await request(server, "POST", "/v1/messages", payload);

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			deliveryStatus: "queued",
			status: "queued",
			daemonReceiptId: "receipt-1",
			nested: { retained: true },
			meshMessageId: payload.meshMessageId,
		});
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toEqual({
			deliveryStatus: "queued",
			status: "queued",
			daemonReceiptId: "receipt-1",
			nested: { retained: true },
			meshMessageId: payload.meshMessageId,
		});
		expect(sendCount).toBe(1);
		expect(store.getReceiptForIdempotencyKey(payload.idempotencyKey)).toMatchObject({ status: "queued" });
	});
	it("records command-result uncertainty as terminal without retrying after duplicate or restart", async () => {
		let attempts = 0;
		let acknowledgements = 0;
		const primeClient = {
			sendMessage: async () => {
				attempts += 1;
				throw new CommandResultUncertainError("prime-command-uncertain");
			},
			acknowledgeBridgeMessage: async () => {
				acknowledgements += 1;
			},
		};
		const { server, store } = await makeServer({ primeClient });
		const payload = message({
			meshMessageId: "mesh-command-result-uncertain",
			idempotencyKey: "idem-command-result-uncertain",
		});
		const uncertainty = "Prime daemon command result is uncertain: prime-command-uncertain";

		const first = await request(server, "POST", "/v1/messages", payload);
		expect(first.status).toBe(200);
		const receipt = (await first.json()) as BridgeReceipt;
		expect(receipt).toEqual({ meshMessageId: payload.meshMessageId, status: "failed", error: uncertainty });

		const duplicate = await request(server, "POST", "/v1/messages", payload);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toEqual(receipt);
		expect(attempts).toBe(1);
		expect(acknowledgements).toBe(1);
		expect(store.getReceiptForIdempotencyKey(payload.idempotencyKey)).toEqual(receipt);
		const audit = store.listAudit().filter(entry => entry.action === "message_failed");
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			preview: { meshMessageId: payload.meshMessageId, error: uncertainty },
		});

		await server.stop();
		const restarted = await makeServer({ store, primeClient });
		const afterRestart = await request(restarted.server, "POST", "/v1/messages", payload);
		expect(afterRestart.status).toBe(200);
		expect(await afterRestart.json()).toEqual(receipt);
		expect(attempts).toBe(1);
		await restarted.server.stop();
		store.close();
	});

	it("keeps an exact receipt when acknowledgement fails after durability", async () => {
		let acknowledgeCalls = 0;
		const primeClient = {
			sendMessage: async () => ({ status: "delivered", receiptId: "ack-failure-receipt" }),
			acknowledgeBridgeMessage: async () => {
				acknowledgeCalls += 1;
				throw new Error("ack unavailable");
			},
		};
		const { server, store } = await makeServer({ primeClient });
		const payload = message({ meshMessageId: "mesh-ack-failure", idempotencyKey: "idem-ack-failure" });

		const response = await request(server, "POST", "/v1/messages", payload);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "delivered",
			receiptId: "ack-failure-receipt",
			meshMessageId: payload.meshMessageId,
		});
		expect(acknowledgeCalls).toBe(1);
		expect(store.getLatestReceipt(payload.meshMessageId)).toMatchObject({ status: "delivered" });
	});

	it("rejects a changed payload for a reused idempotency key", async () => {
		const primeClient = {
			sendMessage: async () => {
				throw new Error("offline");
			},
		};
		const { server } = await makeServer({ primeClient });
		const payload = message({ idempotencyKey: "idem-conflict" });
		await request(server, "POST", "/v1/messages", payload);
		const conflict = await request(server, "POST", "/v1/messages", { ...payload, body: "changed" });
		expect(conflict.status).toBe(409);
	});

	it("records malformed Prime receipts as terminal failures without retrying after restart", async () => {
		let attempts = 0;
		let acknowledgements = 0;
		const primeClient = {
			sendMessage: async () => {
				attempts += 1;
				return { status: "unknown" };
			},
			acknowledgeBridgeMessage: async () => {
				acknowledgements += 1;
			},
		};
		const { server, store } = await makeServer({ primeClient });
		const payload = message({ idempotencyKey: "idem-malformed-receipt" });

		const response = await request(server, "POST", "/v1/messages", payload);
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(receipt).toEqual({
			meshMessageId: payload.meshMessageId,
			status: "failed",
			error: "Prime returned an unknown receipt status",
		});
		expect(store.claimPendingMessages({ now: Date.now() + 31_000 })).toHaveLength(0);
		expect(acknowledgements).toBe(1);

		const duplicate = await request(server, "POST", "/v1/messages", payload);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toEqual(receipt);
		expect(attempts).toBe(1);

		await server.stop();
		const restarted = await makeServer({ store, primeClient });
		const afterRestart = await request(restarted.server, "POST", "/v1/messages", payload);
		expect(afterRestart.status).toBe(200);
		expect(await afterRestart.json()).toEqual(receipt);
		expect(attempts).toBe(1);
		await restarted.server.stop();
		store.close();
	});

	it("records Prime-only unsupported statuses as terminal failures", async () => {
		const primeClient = { sendMessage: async () => ({ status: "injected" }) };
		const { server, store } = await makeServer({ primeClient });
		const payload = message({ idempotencyKey: "idem-unsupported-status" });

		const response = await request(server, "POST", "/v1/messages", payload);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			meshMessageId: payload.meshMessageId,
			status: "failed",
			error: "Prime returned an unknown receipt status",
		});
		expect(store.claimPendingMessages({ now: Date.now() + 31_000 })).toHaveLength(0);
	});

	it("does not fabricate a queued receipt for an exact pending duplicate", async () => {
		const primeClient = {
			sendMessage: async () => {
				throw new Error("offline");
			},
		};
		const { server } = await makeServer({ primeClient });
		const payload = message({ idempotencyKey: "idem-pending-duplicate" });

		expect((await request(server, "POST", "/v1/messages", payload)).status).toBe(500);
		const duplicate = await request(server, "POST", "/v1/messages", payload);
		expect(duplicate.status).toBe(503);
		expect(await duplicate.json()).toEqual({ error: "message remains pending delivery" });
	});

	it("passes the stable bridge message ID through initial and retry sends", async () => {
		const bridgeMessageIds: unknown[] = [];
		let attempts = 0;
		const primeClient = {
			sendMessage: async (...args: unknown[]) => {
				bridgeMessageIds.push(args[3]);
				attempts += 1;
				if (attempts === 1) throw new Error("offline");
				return { status: "delivered", receiptId: "retry-receipt" };
			},
			acknowledgeBridgeMessage: async () => undefined,
		};
		const { server } = await makeServer({ primeClient });
		const payload = message({
			idempotencyKey: "idem-bridge-message-id-retry",
			meshMessageId: "mesh-bridge-message-id-retry",
		});

		expect((await request(server, "POST", "/v1/messages", payload)).status).toBe(500);
		expect((await request(server, "POST", "/v1/messages", payload)).status).toBe(200);
		expect(bridgeMessageIds).toEqual([payload.meshMessageId, payload.meshMessageId]);
	});

	it("returns the winner result to simultaneous identical POSTs", async () => {
		let sendCount = 0;
		let releaseSend: (() => void) | undefined;
		const sendStarted = new Promise<void>(resolve => {
			releaseSend = resolve;
		});
		const primeClient = {
			sendMessage: async () => {
				sendCount += 1;
				await sendStarted;
				return { status: "delivered", receiptId: "simultaneous-receipt" };
			},
			acknowledgeBridgeMessage: async () => undefined,
		};
		const { server } = await makeServer({ primeClient });
		const payload = message({ meshMessageId: "mesh-simultaneous", idempotencyKey: "idem-simultaneous" });
		const first = request(server, "POST", "/v1/messages", payload);
		await Promise.resolve();
		const second = request(server, "POST", "/v1/messages", payload);
		await Promise.resolve();
		releaseSend?.();
		const responses = await Promise.all([first, second]);
		expect(responses.map(response => response.status)).toEqual([200, 200]);
		expect(await responses[0]?.json()).toEqual(await responses[1]?.json());
		expect(sendCount).toBe(1);
	});

	it("writes durable audit entries for retry failure and later success", async () => {
		let attempts = 0;
		const primeClient = {
			sendMessage: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("offline");
				return { status: "delivered", receiptId: "retry-audit-receipt" };
			},
			acknowledgeBridgeMessage: async () => undefined,
		};
		const { server, store } = await makeServer({ primeClient });
		const payload = message({ meshMessageId: "mesh-retry-audit", idempotencyKey: "idem-retry-audit" });
		expect((await request(server, "POST", "/v1/messages", payload)).status).toBe(500);
		expect((await request(server, "POST", "/v1/messages", payload)).status).toBe(200);
		const audit = store.listAudit().filter(entry => {
			if (entry.preview === null || typeof entry.preview !== "object" || !("meshMessageId" in entry.preview))
				return false;
			return entry.preview.meshMessageId === payload.meshMessageId;
		});
		expect(audit.map(entry => entry.action)).toEqual(["message_failed", "message_sent"]);
	});
	it("does not consume an inbox message after a wait request is aborted", async () => {
		const { server } = await makeServer();
		const controller = new AbortController();
		const waiting = fetch(`${server.url}/v1/wait`, {
			method: "POST",
			headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
			body: JSON.stringify({ targetId: "target-session", timeoutMs: 10_000 }),
			signal: controller.signal,
		});
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();
		await waiting.catch(() => undefined);

		const incoming = message({ targetHarness: "omp", idempotencyKey: "idem-abort" });
		expect((await request(server, "POST", "/v1/messages", incoming)).status).toBe(200);
		expect(await (await request(server, "GET", "/v1/inbox?peek=true&targetId=target-session")).json()).toEqual([
			incoming,
		]);
	});

	it("rejects an oversized POST body before parsing it", async () => {
		const { server } = await makeServer();
		const oversized = message({ body: "x".repeat(2 * 1024 * 1024) });
		const response = await request(server, "POST", "/v1/messages", oversized);
		expect(response.status).toBe(413);
	});

	it("drains pending outbox messages after a restart", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-pending-"));
		temporaryDirectories.push(stateDir);
		const store = BridgeStore.open(path.join(stateDir, "bridge.sqlite"));
		const payload = message({ idempotencyKey: "idem-restart", meshMessageId: "mesh-restart" });
		expect(store.enqueueMessage(payload)).toBe(true);
		let sendCount = 0;
		let bridgeMessageId: unknown;
		const { server } = await makeServer({
			store,
			primeClient: {
				sendMessage: async (...args: unknown[]) => {
					sendCount += 1;
					bridgeMessageId = args[3];
					return { status: "delivered", daemonReceiptId: "restart-receipt" };
				},
				acknowledgeBridgeMessage: async () => undefined,
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(sendCount).toBe(1);
		expect(bridgeMessageId).toBe(payload.meshMessageId);
		expect(store.getLatestReceipt(payload.meshMessageId)).toMatchObject({ status: "delivered" });
		await server.stop();
		store.close();
	});
	it("retries a live claim after restart when its lease expires", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-live-claim-"));
		temporaryDirectories.push(stateDir);
		const store = BridgeStore.open(path.join(stateDir, "bridge.sqlite"));
		const payload = message({ idempotencyKey: "idem-live-claim", meshMessageId: "mesh-live-claim" });
		store.enqueueMessage(payload);
		expect(store.claimPendingMessages({ leaseMs: 100 })[0]?.message).toEqual(payload);
		let resolveSend: (() => void) | undefined;
		const sendStarted = new Promise<void>(resolve => {
			resolveSend = resolve;
		});
		let sendCount = 0;
		const { server } = await makeServer({
			store,
			primeClient: {
				sendMessage: async () => {
					sendCount += 1;
					resolveSend?.();
					return { status: "delivered" };
				},
				acknowledgeBridgeMessage: async () => undefined,
			},
		});
		expect(sendCount).toBe(0);
		await sendStarted;
		expect(sendCount).toBe(1);
		await server.stop();
		store.close();
	});
	it("continues draining beyond one claim batch", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-batch-"));
		temporaryDirectories.push(stateDir);
		const store = BridgeStore.open(path.join(stateDir, "bridge.sqlite"));
		const payloads = Array.from({ length: 101 }, (_, index) =>
			message({
				meshMessageId: `mesh-batch-${index}`,
				idempotencyKey: `idem-batch-${index}`,
			}),
		);
		for (const payload of payloads) expect(store.enqueueMessage(payload)).toBe(true);
		let sendCount = 0;
		let resolveComplete: (() => void) | undefined;
		const complete = new Promise<void>(resolve => {
			resolveComplete = resolve;
		});
		const { server } = await makeServer({
			store,
			primeClient: {
				sendMessage: async () => {
					sendCount += 1;
					if (sendCount === 101) resolveComplete?.();
					return { status: "delivered" };
				},
				acknowledgeBridgeMessage: async () => undefined,
			},
		});
		await complete;
		expect(sendCount).toBe(101);
		await server.stop();
		store.close();
	});

	it("validates malformed JSON and required message fields", async () => {
		const { server } = await makeServer();
		const malformed = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
			body: "{",
		});
		const missing = await request(server, "POST", "/v1/messages", { body: "missing fields" });
		expect(malformed.status).toBe(400);
		expect(missing.status).toBe(400);
	});

	it.each(["originSessionId", "targetId"])("rejects malformed UTF-16 %s before persistence", async field => {
		const { server, store } = await makeServer();
		const payload = message({ [field]: "\uD800", targetHarness: "omp" });

		const response = await request(server, "POST", "/v1/messages", payload);

		expect(response.status).toBe(400);
		expect(store.getReceiptForIdempotencyKey(payload.idempotencyKey)).toBeNull();
		expect(store.listInbox({ peek: true })).toEqual([]);
	});

	it("rejects a conflicting mesh message ID with a different idempotency key", async () => {
		const { server } = await makeServer();
		const first = message({
			meshMessageId: "mesh-collision",
			idempotencyKey: "idem-collision-1",
			targetHarness: "omp",
		});
		const conflicting = { ...first, idempotencyKey: "idem-collision-2" };
		expect((await request(server, "POST", "/v1/messages", first)).status).toBe(200);
		const response = await request(server, "POST", "/v1/messages", conflicting);
		expect(response.status).toBe(409);
	});

	it("keeps OMP inbox durable and separates peek from consume", async () => {
		const { server, store, databasePath } = await makeServer();
		const payload = message({ targetHarness: "omp", targetId: "omp", idempotencyKey: "idem-omp" });
		const sent = await request(server, "POST", "/v1/messages", payload);
		expect(sent.status).toBe(200);
		expect(await sent.json()).toEqual({ meshMessageId: payload.meshMessageId, status: "injected" });
		expect(await (await request(server, "GET", "/v1/inbox?targetId=omp&peek=true")).json()).toEqual([payload]);
		await server.stop();
		const reopened = BridgeStore.open(databasePath);
		const restarted = await makeServer({ store: reopened });
		expect(await (await request(restarted.server, "GET", "/v1/inbox?targetId=omp&peek=false")).json()).toEqual([
			payload,
		]);
		expect(await (await request(restarted.server, "GET", "/v1/inbox?targetId=omp&peek=true")).json()).toEqual([]);
		store.close();
		restarted.store.close();
	});

	it("waits for existing and new messages, filters by sender, times out, and cancels on stop", async () => {
		const { server } = await makeServer();
		const existing = message({
			targetHarness: "omp",
			targetId: "omp-session",
			originSessionId: "sender-a",
			idempotencyKey: "idem-existing",
		});
		await request(server, "POST", "/v1/messages", existing);
		const existingClaim = (await (
			await request(server, "POST", "/v1/wait", {
				targetId: "omp-session",
				from: "sender-a",
				timeoutMs: 100,
			})
		).json()) as ClaimedInboxMessage;
		expect(existingClaim.message).toEqual(existing);
		expect(existingClaim.claimToken).toEqual(expect.any(String));
		const existingClaimToken = existingClaim.claimToken;
		expect(await (await request(server, "POST", "/v1/wait/ack", { claimToken: existingClaimToken })).json()).toEqual({
			ok: true,
		});

		const waiting = request(server, "POST", "/v1/wait", {
			targetId: "omp-session",
			from: "sender-b",
			timeoutMs: 1_000,
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		const incoming = message({
			meshMessageId: "mesh-new",
			targetHarness: "omp",
			targetId: "omp-session",
			originSessionId: "sender-b",
			idempotencyKey: "idem-new",
		});
		await request(server, "POST", "/v1/messages", incoming);
		const incomingClaim = (await (await waiting).json()) as ClaimedInboxMessage;
		expect(incomingClaim.message).toEqual(incoming);
		expect(incomingClaim.claimToken).toEqual(expect.any(String));
		const incomingClaimToken = incomingClaim.claimToken;
		expect(await (await request(server, "POST", "/v1/wait/ack", { claimToken: incomingClaimToken })).json()).toEqual({
			ok: true,
		});
		expect(
			await (
				await request(server, "POST", "/v1/wait", {
					targetId: "omp-session",
					timeoutMs: 5,
				})
			).json(),
		).toBeNull();

		const cancelled = request(server, "POST", "/v1/wait", { targetId: "omp-session", timeoutMs: 10_000 });
		await Bun.sleep(10);
		await server.stop();
		expect(await (await cancelled).json()).toBeNull();
	});
	it("keeps timeoutMs zero indefinite until a matching message arrives", async () => {
		const { server } = await makeServer();
		const waiting = request(server, "POST", "/v1/wait", { targetId: "zero-timeout", timeoutMs: 0 });
		await Bun.sleep(10);
		const incoming = message({
			meshMessageId: "mesh-zero-timeout",
			idempotencyKey: "idem-zero-timeout",
			targetHarness: "omp",
			targetId: "zero-timeout",
		});
		await request(server, "POST", "/v1/messages", incoming);
		const claim = (await (await waiting).json()) as ClaimedInboxMessage;
		expect(claim.message).toEqual(incoming);
		expect(claim.claimToken).toEqual(expect.any(String));
		const claimToken = claim.claimToken;
		expect(await (await request(server, "POST", "/v1/wait/ack", { claimToken })).json()).toEqual({
			ok: true,
		});
	});
	it("rejects waits above the timeout cap", async () => {
		const { server } = await makeServer();
		const response = await request(server, "POST", "/v1/wait", {
			targetId: "wait-cap",
			timeoutMs: MAX_WAIT_TIMEOUT_MS + 1,
		});
		expect(response.status).toBe(400);
	});

	it("rejects waiters above the active concurrency cap", async () => {
		const { server } = await makeServer();
		const requests = Array.from({ length: MAX_ACTIVE_WAITERS + 1 }, (_, index) =>
			request(server, "POST", "/v1/wait", { targetId: `waiter-${index}`, timeoutMs: MAX_WAIT_TIMEOUT_MS }),
		);
		const rejected = await Promise.any(
			requests.map(async requestPromise => {
				const response = await requestPromise;
				if (response.status === 429) return true;
				return new Promise<never>(() => undefined);
			}),
		);
		expect(rejected).toBe(true);
		await server.stop();
		await Promise.all(requests);
	});

	it("returns only redacted durable audit entries", async () => {
		const { server, store } = await makeServer();
		store.appendAudit({ action: "send_message", preview: { token: "secret", safe: "yes" } });
		const response = await request(server, "GET", "/v1/audit");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			{ action: "send_message", preview: { token: "[REDACTED]", safe: "yes" }, createdAt: expect.any(String) },
		]);
	});
	it("keeps peer discovery directional and maps the default Prime session envelope", async () => {
		const primeClient = {
			listSessions: async () => ({
				sessions: [
					{ activeSessionId: "prime-a", displayName: "Prime A", status: "ready" },
					{ sessionId: "prime:foo", name: "Prime B", state: "idle" },
				],
			}),
		};
		const { server } = await makeServer({ primeClient });
		const register = async (id: string): Promise<void> => {
			const response = await request(server, "POST", "/v1/peers", {
				targetHarness: "omp",
				id,
				displayName: id,
				status: "running",
			});
			expect(response.status).toBe(200);
		};
		await register("omp-a");
		await register("omp-b");

		expect(await (await request(server, "GET", "/v1/peers?targetHarness=omp")).json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "omp-a" }), expect.objectContaining({ id: "omp-b" })]),
		);
		expect(await (await request(server, "GET", "/v1/peers?targetHarness=prime")).json()).toEqual([
			expect.objectContaining({
				id: "prime:prime-a",
				activeSessionId: "prime-a",
				displayName: "Prime A",
				status: "ready",
			}),
			expect.objectContaining({
				id: "prime:prime:foo",
				activeSessionId: "prime:foo",
				displayName: "Prime B",
				status: "idle",
			}),
		]);
	});
});
