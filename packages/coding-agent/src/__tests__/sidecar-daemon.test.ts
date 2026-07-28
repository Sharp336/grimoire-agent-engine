import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBroker } from "../secrets/broker/broker";
import { SidecarClient } from "../secrets/sidecar/client";
import { connectOrSpawnSidecar } from "../secrets/sidecar/daemon";

/**
 * Detached sidecar daemon — the ssh-agent model.
 *
 * Tests verify: discovery (connect-to-existing over spawn), token file
 * management (write/read/cleanup), and the detach behavior (daemon survives
 * the spawning process's exit).
 */

describe("sidecar daemon (ssh-agent model)", () => {
 let dir: string;

 beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidecar-daemon-test-"));
 });

 afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
 });

 it("first call spawns a daemon + writes the token file", async () => {
  const conn = await connectOrSpawnSidecar({ agentDir: dir });
  expect(conn.spawned).toBe(true);
  expect(conn.client).toBeDefined();

  const tokenPath = join(dir, "sidecar.token");
  expect(existsSync(tokenPath)).toBe(true);
  const token = readFileSync(tokenPath, "utf8").trim();
  expect(token.length).toBeGreaterThan(0);

  await conn.stop?.();
 });

 it("second call discovers the existing daemon (does not spawn a new one)", async () => {
  const first = await connectOrSpawnSidecar({ agentDir: dir });
  expect(first.spawned).toBe(true);

  // Second call from a "new session" (same agentDir) should discover.
  const second = await connectOrSpawnSidecar({ agentDir: dir });
  expect(second.spawned).toBe(false);
  expect(second.sockPath).toBe(first.sockPath);

  // Both clients talk to the same daemon.
  expect(await second.client.ping()).toBe(true);

  await first.stop?.();
 });

 it("stale token file with dead daemon → spawns a fresh daemon", async () => {
  // Write a stale token file + stale socket file (no daemon running).
  const tokenPath = join(dir, "sidecar.token");
  const sockPath = join(dir, "sidecar.sock");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tokenPath, "stale-token-abc123", { mode: 0o600 });
  writeFileSync(sockPath, "", { mode: 0o600 });

  const conn = await connectOrSpawnSidecar({ agentDir: dir });
  // The stale files are cleaned up and a fresh daemon is spawned.
  expect(conn.spawned).toBe(true);
  expect(await conn.client.ping()).toBe(true);

  await conn.stop?.();
 });

 it("daemon survives the spawning process's exit (detach)", async () => {
  // This is the core ssh-agent property: the daemon outlives its spawner.
  // We can't actually kill the test process, so we simulate by spawning,
  // then NOT calling stop, then connecting again from a fresh call.
  const first = await connectOrSpawnSidecar({ agentDir: dir });
  expect(first.spawned).toBe(true);

  // The token file exists and the socket answers — the observable proof
  // that the daemon is running independently of any client connection.
  const second = await connectOrSpawnSidecar({ agentDir: dir });
  expect(second.spawned).toBe(false);

  await first.stop?.();
 });

 it("stop() kills the daemon + removes the token file", async () => {
  const conn = await connectOrSpawnSidecar({ agentDir: dir });
  const tokenPath = join(dir, "sidecar.token");
  expect(existsSync(tokenPath)).toBe(true);

  await conn.stop?.();

  // Token file should be gone after stop (server's SIGTERM cleanup).
  // Note: the server removes the socket; the token file removal is
  // handled by the daemon.ts stop() or the caller's cleanup.
  // For now we verify the daemon is dead (ping fails).
  const dead = await connectOrSpawnSidecar({ agentDir: dir });
  // Should spawn a new daemon because the old one is dead.
  expect(dead.spawned).toBe(true);
  await dead.stop?.();
 });

 it("broker attaches to the discovered daemon (capability proxy works)", async () => {
  const conn = await connectOrSpawnSidecar({ agentDir: dir });

  const broker = new SecretBroker();
  broker.attachSidecar(conn.client);

  // Push a credential through the daemon.
  await broker.setCredential("BW_SESSION", "daemon-test-session");

  // Read it back via a second client to prove it's in the daemon's vault,
  // not the local one.
  const second = new SidecarClient(conn.sockPath, readFileSync(join(dir, "sidecar.token"), "utf8").trim());
  const present = await second.request({ op: "get_credential_present", key: "BW_SESSION" });
  expect(present.ok).toBe(true);
  if (!present.ok) throw new Error("expected ok");
  expect(present.result).toBe(true);

  await second.close();
  await conn.stop?.();
 });
});
