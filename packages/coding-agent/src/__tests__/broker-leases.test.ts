import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBroker } from "../secrets/broker/broker";
import { SidecarClient } from "../secrets/sidecar/client";
import { SidecarServer } from "../secrets/sidecar/server";
import type { SecretHandle, SecretValue, VaultProvider } from "../secrets/broker/types";

const LEASE_VALUE = "lease-fake-pw-98765432";

function stubProvider(value: string): VaultProvider {
	return {
		name: "stub",
		resolve: async (handle: SecretHandle): Promise<SecretValue> => ({ handle, value }),
		isAvailable: async () => true,
	};
}

function failingProvider(): VaultProvider {
	return {
		name: "stub",
		resolve: async (handle: SecretHandle): Promise<SecretValue> => {
			throw new Error("vault is locked");
		},
		isAvailable: async () => true,
	};
}

describe("Phase D Task D3: secret leases", () => {
	it("create → runWithLease works → revoke → runWithLease fails closed", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));

		const { leaseId, expiresAt } = await broker.createLease({ provider: "stub", itemId: "x" }, 60_000);
		expect(leaseId).toBeTruthy();
		expect(expiresAt).toBeGreaterThan(Date.now());

		const result = await broker.runWithLease({
			leaseId,
			command: "printenv",
			args: ["LEASE_PW"],
			envKey: "LEASE_PW",
		});
		expect(result.exitCode).toBe(0);

		await broker.revokeLease(leaseId);
		const after = await broker.runWithLease({ leaseId, command: "printenv", args: ["LEASE_PW"], envKey: "LEASE_PW" });
		expect(after.exitCode).toBe(-1);
		expect(after.stderr).toContain("lease");
	});

	it("expiry auto-revokes the lease", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));
		const { leaseId } = await broker.createLease({ provider: "stub", itemId: "x" }, 50);
		await new Promise(resolve => setTimeout(resolve, 120));
		const after = await broker.runWithLease({ leaseId, command: "printenv", args: ["X"], envKey: "X" });
		expect(after.exitCode).toBe(-1);
	});

	it("the lease value is scrubbed from runWithLease output while the lease is live", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));
		const { leaseId } = await broker.createLease({ provider: "stub", itemId: "x" }, 60_000);
		const result = await broker.runWithLease({
			leaseId,
			command: "printenv",
			args: ["LEASE_PW"],
			envKey: "LEASE_PW",
		});
		expect(result.stdout).not.toContain(LEASE_VALUE);
		expect(result.stdout).toContain("[REDACTED]");
	});

	it("listLeases returns metadata, never values", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));
		const { leaseId } = await broker.createLease({ provider: "stub", itemId: "x" }, 60_000);
		const leases = broker.listLeases();
		expect(leases).toHaveLength(1);
		expect(leases[0].leaseId).toBe(leaseId);
		expect(JSON.stringify(leases)).not.toContain(LEASE_VALUE);
	});

	it("clearCredentials revokes all leases", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));
		const { leaseId } = await broker.createLease({ provider: "stub", itemId: "x" }, 60_000);
		broker.clearCredentials();
		const after = await broker.runWithLease({ leaseId, command: "printenv", args: ["X"], envKey: "X" });
		expect(after.exitCode).toBe(-1);
		expect(broker.listLeases()).toHaveLength(0);
	});

	it("createLease fails closed on resolution failure (no lease created)", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(failingProvider());
		await expect(broker.createLease({ provider: "stub", itemId: "x" }, 1000)).rejects.toThrow();
		expect(broker.listLeases()).toHaveLength(0);
	});

	it("createLease fails closed on an unknown provider", async () => {
		const broker = new SecretBroker();
		await expect(broker.createLease({ provider: "nope", itemId: "x" }, 1000)).rejects.toThrow(/Unknown provider/);
		expect(broker.listLeases()).toHaveLength(0);
	});

	it("revokeLease is idempotent", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(stubProvider(LEASE_VALUE));
		const { leaseId } = await broker.createLease({ provider: "stub", itemId: "x" }, 60_000);
		await broker.revokeLease(leaseId);
		await broker.revokeLease(leaseId);
		expect(broker.listLeases()).toHaveLength(0);
	});

	it("sidecar mode: leases work through the daemon (create → run → revoke over the socket)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sidecar-lease-test-"));
		const sockPath = join(dir, "sidecar.sock");
		const serverBroker = new SecretBroker();
		serverBroker.registerProvider(stubProvider(LEASE_VALUE));
		const server = new SidecarServer({ sockPath, token: "lease-token", broker: serverBroker });
		await server.start();
		try {
			const clientBroker = new SecretBroker();
			const client = new SidecarClient(sockPath, "lease-token");
			clientBroker.attachSidecar(client);

			const { leaseId } = await clientBroker.createLease({ provider: "stub", itemId: "x" }, 60_000);
			expect(leaseId).toBeTruthy();

			const result = await clientBroker.runWithLease({
				leaseId,
				command: "printenv",
				args: ["LEASE_PW"],
				envKey: "LEASE_PW",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain(LEASE_VALUE);
			expect(result.stdout).toContain("[REDACTED]");

			await clientBroker.revokeLease(leaseId);
			const after = await clientBroker.runWithLease({
				leaseId,
				command: "printenv",
				args: ["X"],
				envKey: "X",
			});
			expect(after.exitCode).toBe(-1);
			await client.close();
		} finally {
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
