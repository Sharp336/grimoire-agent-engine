import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SidecarClient } from "./client";
import { type SpawnedSidecar, spawnSidecar } from "./spawn";

/**
 * Detached sidecar daemon — the ssh-agent model.
 *
 * First session spawns the daemon (detached, survives session exit).
 * Subsequent sessions discover it via the well-known socket + token file and
 * connect to it instead of spawning their own. One daemon, one vault, shared
 * by every process — `omp -p`, tmux windows, SDK scripts.
 *
 * The daemon dies when: manually stopped, OS reboots, it crashes, or OOM
 * kills it. When it dies, the vault is gone (in-memory only). Re-unlock
 * needed on the next spawn.
 */

export interface DaemonConnection {
 client: SidecarClient;
 sockPath: string;
 /** true when this call spawned the daemon (vs. connected to an existing one). */
 spawned: boolean;
 /** Kill the daemon. Only available when this call spawned it. */
 stop?: () => Promise<void>;
}

function readTokenFile(tokenPath: string): string | undefined {
 try {
  if (!existsSync(tokenPath)) return undefined;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token.length > 0 ? token : undefined;
 } catch {
  return undefined;
 }
}

function writeTokenFile(tokenPath: string, token: string): void {
 writeFileSync(tokenPath, token, { mode: 0o600 });
 chmodSync(tokenPath, 0o600);
}

/**
 * Connect to an existing sidecar daemon, or spawn one if none exists.
 *
 * Discovery order:
 * 1. Read the token file. If missing, no daemon → spawn.
 * 2. Connect to the socket with that token. Ping. If it answers → attach.
 * 3. If ping fails (stale socket / dead daemon) → clean up + spawn fresh.
 *
 * The spawned daemon is detached (unref'd): the spawning process can exit
 * and the daemon keeps running, reparented to init. Subsequent sessions
 * discover it via the token file + socket and connect directly.
 */
export async function connectOrSpawnSidecar(opts: {
 agentDir: string;
 bunPath?: string;
}): Promise<DaemonConnection> {
 const sockPath = join(opts.agentDir, "sidecar.sock");
 const tokenPath = join(opts.agentDir, "sidecar.token");

 // 1. Try to connect to an existing daemon.
 const existingToken = readTokenFile(tokenPath);
 if (existingToken) {
  try {
   const client = new SidecarClient(sockPath, existingToken);
   await client.connect();
   if (await client.ping()) {
    return { client, sockPath, spawned: false };
   }
  } catch {
   // stale socket or dead daemon — fall through to spawn
  }
 }

 // 2. No daemon — clean up any stale files, then spawn one (detached).
 try {
  unlinkSync(sockPath);
 } catch {
  // no stale socket
 }
 try {
  unlinkSync(tokenPath);
 } catch {
  // no stale token
 }

 const spawned: SpawnedSidecar = await spawnSidecar({
  agentDir: opts.agentDir,
  bunPath: opts.bunPath,
 });

 // Write the token file so future processes can connect to this daemon.
 writeTokenFile(tokenPath, spawned.token);

 // Detach: the child survives this process's exit (reparented to init).
 spawned.process.unref();

 return {
  client: spawned.client,
  sockPath: spawned.sockPath,
  spawned: true,
  stop: spawned.stop,
 };
}
