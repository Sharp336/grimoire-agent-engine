import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeMessage } from "@oh-my-pi/prime-bridge-protocol";
import {
	BridgeStore,
	MAX_AUDIT_QUERY_LIMIT,
	MAX_AUDIT_ROWS,
	MAX_COMPLETED_OUTBOX_ROWS,
	MAX_CONSUMED_INBOX_ROWS,
	MAX_ORPHAN_RECEIPT_ROWS,
} from "../src";
import { main } from "../src/cli";
import type { PrimeBridgeConfig } from "../src/config";
import { PrimeDaemonClient } from "../src/prime/client";
import type { PrimeBridgeServer } from "../src/server";

const temporaryDirectories: string[] = [];

async function makeStateDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-runtime-"));
	temporaryDirectories.push(directory);
	return directory;
}

function configFor(stateDir: string): PrimeBridgeConfig {
	return {
		stateDir,
		databasePath: path.join(stateDir, "bridge.sqlite"),
		tokenFile: path.join(stateDir, "token"),
		primeConfigFile: path.join(stateDir, "prime-config.json"),
		host: "127.0.0.1",
		port: 0,
		allowedOrigins: [],
	};
}

function message(index: number, overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: `mesh-${index}`,
		idempotencyKey: `idem-${index}`,
		originHarness: "omp",
		originSessionId: "session-1",
		targetHarness: "prime",
		targetId: "prime-1",
		body: "hello",
		projectRoot: "/repo",
		createdAt: new Date(index).toISOString(),
		...overrides,
	};
}

async function cleanup(): Promise<void> {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
}

afterEach(cleanup);
describe("runtime hardening", () => {
	it("awaits bridge shutdown before closing CLI-owned resources", async () => {
		const stateDir = await makeStateDir();
		const events: string[] = [];
		const originalStoreClose = BridgeStore.prototype.close;
		const originalClientClose = PrimeDaemonClient.prototype.close;
		BridgeStore.prototype.close = function close(): void {
			events.push("store-close");
			originalStoreClose.call(this);
		};
		PrimeDaemonClient.prototype.close = function close(): void {
			expect(events).toEqual(["bridge-stop-start", "bridge-stop-end"]);
			events.push("client-close");
			originalClientClose.call(this);
		};
		try {
			const bridge: PrimeBridgeServer = {
				url: "http://127.0.0.1:4321",
				token: "test-token",
				config: configFor(stateDir),
				tokenFile: path.join(stateDir, "token"),
				stop: async () => {
					events.push("bridge-stop-start");
					await Promise.resolve();
					events.push("bridge-stop-end");
				},
			};
			const running = await main([], {
				config: configFor(stateDir),
				startServer: async () => bridge,
			});

			const stopping = running.stop();
			expect(stopping).toBeInstanceOf(Promise);
			await stopping;
			expect(events).toEqual(["bridge-stop-start", "bridge-stop-end", "client-close", "store-close"]);
		} finally {
			BridgeStore.prototype.close = originalStoreClose;
			PrimeDaemonClient.prototype.close = originalClientClose;
		}
	});

	it("repairs a pre-existing state directory to owner-only permissions", async () => {
		const stateDir = await makeStateDir();
		await fs.chmod(stateDir, 0o755);
		const running = await main([], {
			config: configFor(stateDir),
			store: { close: () => undefined } as unknown as BridgeStore,
			primeClient: { close: () => undefined } as never,
			startServer: async () =>
				({
					url: "http://127.0.0.1:4321",
					stop: async () => undefined,
				}) as PrimeBridgeServer,
		});

		expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
		await running.stop();
	});

	it("repairs database, WAL, and SHM files to owner-only permissions", async () => {
		const stateDir = await makeStateDir();
		const databasePath = path.join(stateDir, "bridge.sqlite");
		const first = BridgeStore.open(databasePath);
		first.getOrCreateClientId();
		const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
		for (const filePath of databaseFiles) {
			try {
				await fs.chmod(filePath, 0o644);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
					throw error;
			}
		}
		first.close();

		const reopened = BridgeStore.open(databasePath);
		for (const filePath of databaseFiles) {
			try {
				expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
					throw error;
			}
		}
		reopened.close();
	});

	it("prunes terminal outbox rows without deleting pending or claimed work", async () => {
		const stateDir = await makeStateDir();
		const databasePath = path.join(stateDir, "bridge.sqlite");
		const store = BridgeStore.open(databasePath);
		const claimed = message(1);
		const pending = message(2);
		store.enqueueMessage(claimed);
		expect(store.claimPendingMessages({ limit: 1, now: 1, leaseMs: 60_000 })).toEqual([
			expect.objectContaining({ message: claimed }),
		]);

		for (let index = 3; index <= MAX_COMPLETED_OUTBOX_ROWS + 3; index += 1) {
			const terminal = message(index);
			store.enqueueMessage(terminal);
			const [claim] = store.claimPendingMessages({ limit: 1, now: index, leaseMs: 60_000 });
			expect(claim?.message).toEqual(terminal);
			if (claim === undefined) throw new Error("expected terminal message claim");
			store.recordReceipt({ meshMessageId: terminal.meshMessageId, status: "delivered" }, claim.claimToken);
		}
		store.enqueueMessage(pending);

		const database = new Database(databasePath, { readonly: true });
		const rows = database.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as Array<{
			status: string;
			count: number;
		}>;
		const completed = database
			.prepare("SELECT mesh_message_id FROM outbox WHERE status = 'complete' ORDER BY id ASC")
			.all() as Array<{
			mesh_message_id: string;
		}>;
		database.close();
		expect(rows.find(row => row.status === "pending")?.count).toBe(1);
		expect(rows.find(row => row.status === "claimed")?.count).toBe(1);
		expect(completed.map(row => row.mesh_message_id)).toEqual(
			Array.from({ length: MAX_COMPLETED_OUTBOX_ROWS }, (_, offset) => `mesh-${offset + 4}`),
		);
		store.close();
	});

	it("bounds audit reads and preserves small-result behavior", async () => {
		const stateDir = await makeStateDir();
		const store = BridgeStore.open(path.join(stateDir, "bridge.sqlite"));
		store.appendAudit({ action: "first", preview: { value: 1 } });
		store.appendAudit({ action: "second", preview: { value: 2 } });
		store.appendAudit({ action: "third", preview: { value: 3 } });
		expect(store.listAudit()).toHaveLength(3);
		expect(store.listAudit({ limit: 2 })).toHaveLength(2);

		for (let index = 0; index <= MAX_AUDIT_QUERY_LIMIT + 1; index += 1) {
			store.appendAudit({ action: `audit-${index}`, preview: { index } });
		}
		expect(store.listAudit({ limit: 2 }).map(entry => entry.action)).toEqual([
			`audit-${MAX_AUDIT_QUERY_LIMIT}`,
			`audit-${MAX_AUDIT_QUERY_LIMIT + 1}`,
		]);
		expect(store.listAudit({ limit: Number.MAX_SAFE_INTEGER }).length).toBeLessThanOrEqual(MAX_AUDIT_QUERY_LIMIT);
		store.close();
	});

	it("keeps retention limits explicit", () => {
		expect(MAX_AUDIT_ROWS).toBeGreaterThan(0);
		expect(MAX_CONSUMED_INBOX_ROWS).toBeGreaterThan(0);
		expect(MAX_COMPLETED_OUTBOX_ROWS).toBeGreaterThan(0);
		expect(MAX_ORPHAN_RECEIPT_ROWS).toBeGreaterThan(0);
	});
});
