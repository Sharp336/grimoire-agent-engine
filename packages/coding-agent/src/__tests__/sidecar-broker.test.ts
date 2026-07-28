import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBroker } from "../secrets/broker/broker";
import { SidecarClient } from "../secrets/sidecar/client";
import { SidecarServer } from "../secrets/sidecar/server";

/**
 * Sidecar broker integration tests.
 *
 * These run the sidecar server IN-PROCESS on a temp unix socket (fast, no
 * child spawn), exercising the same wire protocol the spawned child uses.
 */

describe("sidecar broker", () => {
	let dir: string;
	let sockPath: string;
	let server: SidecarServer | undefined;
	let broker: SecretBroker;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sidecar-test-"));
		sockPath = join(dir, "sidecar.sock");
		broker = new SecretBroker();
	});

	afterEach(async () => {
		await server?.stop();
		server = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("ping → pong over the unix socket", async () => {
		server = new SidecarServer({ sockPath, token: "test-token", broker });
		await server.start();
		const client = new SidecarClient(sockPath, "test-token");
		expect(await client.ping()).toBe(true);
		await client.close();
	});

	it("run_with_secret: scrubbed result comes back over the socket", async () => {
		// Register a stub provider that returns a known value without touching bw.
		broker.registerProvider({
			name: "stub",
			resolve: async (handle) => ({ handle, value: "s3cr3t-value-9876" }),
			isAvailable: async () => true,
		});
		server = new SidecarServer({ sockPath, token: "test-token", broker });
		await server.start();

		const client = new SidecarClient(sockPath);
		const res = await client.request({
			op: "run_with_secret",
			handle: { provider: "stub", itemId: "x" },
			command: "printenv",
			args: ["MY_SECRET"],
			envKey: "MY_SECRET",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		const result = res.result as { exitCode: number; stdout: string; stderr: string };
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("s3cr3t-value-9876");
		expect(result.stdout).toContain("[REDACTED]");
		await client.close();
	});

	it("set_credential + get_credential_present round-trip over the socket", async () => {
		server = new SidecarServer({ sockPath, token: "test-token", broker });
		await server.start();
		const client = new SidecarClient(sockPath, "test-token");
		await client.request({ op: "set_credential", key: "BW_SESSION", value: "sess-abc" });
		const present = await client.request({ op: "get_credential_present", key: "BW_SESSION" });
		expect(present.ok).toBe(true);
		if (!present.ok) throw new Error("expected ok");
		expect(present.result).toBe(true);
		await client.close();
	});

	it("resolve_for_redaction: correct token gets the value", async () => {
		broker.registerProvider({
			name: "stub",
			resolve: async (handle) => ({ handle, value: "redact-me-123" }),
			isAvailable: async () => true,
		});
		server = new SidecarServer({ sockPath, token: "test-token", broker });
		await server.start();
		const client = new SidecarClient(sockPath, "test-token");
		const res = await client.request({ op: "resolve_for_redaction", handle: { provider: "stub", itemId: "x" } });
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		expect((res.result as { value: string }).value).toBe("redact-me-123");
		await client.close();
	});

	it("resolve_for_redaction: WRONG/missing token is rejected (fail-closed gate)", async () => {
		// allowedPid set to a pid that is NOT our pid (and guaranteed not to be
		// our pid — pid 1 is init on Linux; the client connects as our pid).
		server = new SidecarServer({ sockPath, token: "other-token", broker });
		await server.start();
		const client = new SidecarClient(sockPath, "test-token");
		const res = await client.request({ op: "resolve_for_redaction", handle: { provider: "stub", itemId: "x" } });
		expect(res.ok).toBe(false);
		expect((res as { error: string }).error).toContain("spawn token");
		await client.close();
	});

	it("broker client mode: attachSidecar proxies runWithSecret to the socket", async () => {
		broker.registerProvider({
			name: "stub",
			resolve: async (handle) => ({ handle, value: "proxy-me-555" }),
			isAvailable: async () => true,
		});
		server = new SidecarServer({ sockPath, token: "test-token", broker });
		await server.start();

		// The OMP-side broker has NO providers — it must proxy to the sidecar.
		const ompSideBroker = new SecretBroker();
		const client = new SidecarClient(sockPath);
		ompSideBroker.attachSidecar(client);
		expect(ompSideBroker.hasSidecar).toBe(true);

		const result = await ompSideBroker.runWithSecret({
			handle: { provider: "stub", itemId: "x" },
			command: "printenv",
			args: ["MY_SECRET"],
			envKey: "MY_SECRET",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("proxy-me-555");
		expect(result.stdout).toContain("[REDACTED]");
		await client.close();
	});
});
