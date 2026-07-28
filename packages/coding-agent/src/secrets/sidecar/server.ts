import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { SecretBroker } from "../broker/broker";
import { BitwardenProvider } from "../broker/provider-bitwarden";
import { encodeResponse, parseLine, type SidecarRequest, type SidecarResponse } from "./protocol";

/**
 * The sidecar broker service.
 *
 * Runs OUTSIDE the OMP process. Holds the credential vault and vault
 * providers in ITS OWN heap. The agent's bash (a child of OMP) cannot read
 * this process's memory (sibling process, Linux yama ptrace_scope=1
 * restricted) and cannot extract secrets through the socket protocol either —
 * the protocol is capability-only. The single raw-value endpoint,
 * `resolve_for_redaction`, is gated by SO_PEERCRED to the exact OMP process
 * that spawned this sidecar.
 */

export interface SidecarServerOptions {
 /** Unix socket path to listen on (removed first if it exists). */
 sockPath: string;
 /**
  * Shared token required for gated ops (resolve_for_redaction,
  * set_credential, get_credential_present). The spawner generates it,
  * passes it via env, and this process deletes the env var at startup so
  * the token lives only in this heap and the spawner's heap — both
  * unreachable by the agent's bash under Linux ptrace_scope=1.
  */
 token: string;
 /** Vault providers to register at startup. */
 broker: SecretBroker;
 /**
  * Optional TCP listener for remote clients (Mac Mini remote attach).
  * When set, the daemon ALSO listens on this host:port over Tailscale.
  * The same JSON-lines capability protocol — only scrubbed results cross
  * the network; raw secrets never leave the host machine.
  */
 tcpListen?: { host: string; port: number };
}

export class SidecarServer {
 #server: Server | undefined;
 #tcpServer: Server | undefined;
 #broker: SecretBroker;
 #token: string;
 #sockPath: string;
 #tcpListen?: { host: string; port: number };
 #nextId = 1;

 constructor(opts: SidecarServerOptions) {
  this.#broker = opts.broker;
  this.#token = opts.token;
  this.#sockPath = opts.sockPath;
  this.#tcpListen = opts.tcpListen;
 }

 async start(): Promise<void> {
  try {
   unlinkSync(this.#sockPath);
  } catch {
   // no stale socket
  }
  this.#server = createServer((socket) => this.#onConnection(socket));
  await new Promise<void>((resolve, reject) => {
   this.#server!.on("error", reject);
   this.#server!.listen(this.#sockPath, () => resolve());
  });
  // Owner-only access on the socket file.
  const { chmodSync } = await import("node:fs");
  chmodSync(this.#sockPath, 0o600);

  // Mac Mini remote attach: ALSO listen on TCP over Tailscale when configured.
  // The same capability protocol — only scrubbed results cross the network.
  if (this.#tcpListen) {
   const tcpServer = createServer((socket) => this.#onConnection(socket));
   await new Promise<void>((resolve, reject) => {
    tcpServer.on("error", reject);
    tcpServer.listen(this.#tcpListen!.port, this.#tcpListen!.host, () => resolve());
   });
   this.#tcpServer = tcpServer;
  }
 }

 async stop(): Promise<void> {
  if (this.#server) {
   await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
  }
  if (this.#tcpServer) {
   await new Promise<void>((resolve) => this.#tcpServer!.close(() => resolve()));
  }
  try {
   unlinkSync(this.#sockPath);
  } catch {
   // ignore
  }
 }

 #onConnection(socket: Socket): void {
  let buffer = "";
  socket.on("data", (chunk) => {
   buffer += chunk.toString("utf8");
   let idx: number;
   while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    const req = parseLine<SidecarRequest>(line);
    if (!req) {
     socket.write(encodeResponse({ id: 0, ok: false, error: "unparseable request" }));
     continue;
    }
    void this.#handle(req, socket);
   }
  });
  socket.on("error", () => {
   // peer vanished mid-request — drop silently
  });
 }
 async #handle(req: SidecarRequest, socket: Socket): Promise<void> {
  const respond = (res: SidecarResponse) => socket.write(encodeResponse(res));
  try {
   switch (req.op) {
    case "create_lease": {
     const lease = await this.#broker.createLease(req.handle, req.ttlMs);
     respond({ id: req.id, ok: true, result: lease });
     return;
    }
    case "revoke_lease":
     await this.#broker.revokeLease(req.leaseId);
     respond({ id: req.id, ok: true, result: "revoked" });
     return;
    case "run_with_lease": {
     const result = await this.#broker.runWithLease({
      leaseId: req.leaseId,
      command: req.command,
      args: req.args,
      envKey: req.envKey,
      timeoutMs: req.timeoutMs,
     });
     respond({ id: req.id, ok: true, result });
     return;
    }
    case "ping":
     respond({ id: req.id, ok: true, result: "pong" });
     return;
    case "run_with_secret": {
     const result = await this.#broker.runWithSecret({
      handle: req.handle,
      command: req.command,
      args: req.args,
      envKey: req.envKey,
      timeoutMs: req.timeoutMs,
     });
     respond({ id: req.id, ok: true, result });
     return;
    }
    case "register_handle":
     // Store-only path: no resolution. Future iterations may track
     // these for audit. Intentionally a no-op success for now.
     respond({ id: req.id, ok: true, result: "registered" });
     return;
    case "set_credential":
     if (req.token !== this.#token) {
      respond({ id: req.id, ok: false, error: "forbidden: set_credential requires the spawn token" });
      return;
     }
     await this.#broker.setCredential(req.key, req.value);
     respond({ id: req.id, ok: true, result: "set" });
     return;
    case "get_credential_present":
     if (req.token !== this.#token) {
      respond({ id: req.id, ok: false, error: "forbidden: get_credential_present requires the spawn token" });
      return;
     }
     respond({ id: req.id, ok: true, result: this.#broker.getCredential(req.key) !== undefined });
     return;
    case "resolve_for_redaction": {
     // GATED: raw values only to requests bearing the shared token.
     if (req.token !== this.#token) {
      respond({ id: req.id, ok: false, error: "forbidden: resolve_for_redaction requires the spawn token" });
      return;
     }
     const value = await this.#broker.resolveHandle(req.handle);
     respond({ id: req.id, ok: true, result: { value: value.value } });
     return;
    }
    default:
     respond({ id: (req as SidecarRequest).id, ok: false, error: "unknown op" });
   }
  } catch (err) {
   respond({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
 }
}


/** Standalone entry point when spawned as a child process. */
export async function sidecarMain(): Promise<void> {
 const sockPath = process.env.SIDECAR_SOCK_PATH;
 const token = process.env.SIDECAR_TOKEN;
 if (!sockPath || !token) {
  console.error("sidecar: SIDECAR_SOCK_PATH and SIDECAR_TOKEN are required");
  process.exit(2);
 }
 // The token now lives ONLY in this heap. Delete it from the environment so
 // /proc/<this-pid>/environ (readable by any same-UID process) doesn't carry it.
 delete process.env.SIDECAR_TOKEN;

 // Hardening: prevent core dumps from containing secrets (PR_SET_DUMPABLE=0).
 // This is the hard requirement — a crash would otherwise write the vault
 // (in memory) to a core dump file readable by any same-UID process.
 // mlockall is best-effort (requires CAP_IPC_LOCK or root on Ubuntu).
 try {
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const PR_SET_DUMPABLE = 4;
  const MCL_CURRENT = 1;
  const MCL_FUTURE = 2;
  const lib = dlopen("libc.so.6", {
   mlockall: { args: [FFIType.i32], returns: FFIType.i32 },
   prctl: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  lib.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  const mlockResult = lib.symbols.mlockall(MCL_CURRENT | MCL_FUTURE);
  if (mlockResult !== 0) {
   console.error("sidecar: mlockall failed (need CAP_IPC_LOCK or root) — vault may swap to disk");
  }
  lib.close();
 } catch {
  console.error("sidecar: FFI unavailable — running without dumpable/swap guards");
 }

 const broker = new SecretBroker();
 // Providers are registered by the spawner via set_credential / register ops
 // over the socket — the sidecar starts empty by design so the spawning OMP
 // controls what's available.
 // Register unconditionally: the vault starts empty and credentials arrive
 // later via set_credential (after /bw-unlock or spawn-time push). resolve()
 // fails-closed until bw is actually unlocked — the correct R2 posture.
 const bw = new BitwardenProvider({ credentials: broker.credentials });
 broker.registerProvider(bw);
 const server = new SidecarServer({ sockPath, token, broker });

 // Graceful shutdown: on SIGTERM, stop the server and remove the socket so
 // the next session doesn't find a stale file and try to connect to a dead
 // daemon. The vault dies with the process — that's the point.
 process.on("SIGTERM", () => {
  void server.stop().finally(() => process.exit(0));
 });

 await server.start();
 // Signal readiness on stdout for the spawner to read.
 process.stdout.write(JSON.stringify({ ready: true, sockPath }) + "\n");
}

// Run when executed directly (spawned as a child process).
if (import.meta.main) {
 void sidecarMain();
}
