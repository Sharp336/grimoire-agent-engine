import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarClient } from "./client";

/**
 * Spawns the sidecar as a child process of OMP at session start.
 *
 * The sidecar is a sibling of the agent's bash tool: both are children of OMP.
 * Under Linux yama `ptrace_scope=1` (Ubuntu default), a child can only ptrace
 * its own descendants — so the agent's bash CANNOT read this sidecar's memory,
 * and it cannot read OMP's memory either. Secrets live in the sidecar's heap,
 * out of reach of both.
 *
 * When spawned as a daemon (unref'd), it persists across session exits.
 */

export interface SpawnedSidecar {
 client: SidecarClient;
 process: ChildProcess;
 sockPath: string;
 /** The gate token generated at spawn. daemon.ts writes this to the
  *  token file so future processes can connect to the same daemon. */
 token: string;
 stop: () => Promise<void>;
}

const SIDECAR_ENTRY = fileURLToPath(new URL("./server.ts", import.meta.url));

export interface SpawnSidecarOptions {
 /** Directory for the socket (mode 0700). */
 agentDir: string;
 /** bun executable to spawn the sidecar with. */
 bunPath?: string;
 /** Timeout in ms to wait for the ready signal. Default 10_000. */
 readyTimeoutMs?: number;
}

export async function spawnSidecar(opts: SpawnSidecarOptions): Promise<SpawnedSidecar> {
 const sockPath = join(opts.agentDir, "sidecar.sock");
 const bunPath = opts.bunPath ?? process.env.SIDECAR_BUN_PATH ?? "bun";
 // Shared gate token: lives only in this heap and the sidecar's heap (the
 // sidecar deletes it from its env at startup). The agent's bash can read
 // /proc/<sidecar-pid>/environ but the token is already gone from there;
 // it can't read either heap under Linux ptrace_scope=1.
 const token = randomBytes(32).toString("hex");

 const child = spawn(bunPath, ["run", SIDECAR_ENTRY], {
  env: {
   ...process.env,
   SIDECAR_SOCK_PATH: sockPath,
   SIDECAR_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
 });

 const ready = await new Promise<{ ready: boolean; sockPath: string }>((resolve, reject) => {
  let stdout = "";
  const timer = setTimeout(() => reject(new Error("sidecar ready timeout")), opts.readyTimeoutMs ?? 10_000);
  child.stdout?.on("data", (chunk) => {
   stdout += chunk.toString();
   const idx = stdout.indexOf("\n");
   if (idx !== -1) {
    clearTimeout(timer);
    try {
     resolve(JSON.parse(stdout.slice(0, idx)));
    } catch (err) {
     reject(err);
    }
   }
  });
  child.stderr?.on("data", (chunk) => {
   // Surface sidecar stderr on failure
   child.once("close", () => reject(new Error(`sidecar failed: ${chunk.toString()}`)));
  });
 });

 const client = new SidecarClient(ready.sockPath, token);
 await client.connect();
 if (!(await client.ping())) {
  throw new Error("sidecar ping failed");
 }

 return {
  client,
  process: child,
  sockPath: ready.sockPath,
  token,
  stop: async () => {
   await client.close();
   child.kill("SIGTERM");
  },
 };
}
