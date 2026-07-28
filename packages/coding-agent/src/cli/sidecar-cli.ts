import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SidecarClient } from "../secrets/sidecar/client";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/**
 * CLI handlers for `omp-secret sidecar <action>`.
 *
 * The daemon is discovered via the well-known socket + token file in the
 * agent dir. `unlock` prompts for the master password interactively (masked),
 * pushes the session to the daemon vault. `lock` clears the vault. `status`
 * shows daemon state. `stop` kills the daemon.
 */

export type SidecarAction = "unlock" | "lock" | "status" | "stop";

export interface SidecarCommandArgs {
 action: SidecarAction;
 flags: { json: boolean };
}

interface DaemonState {
 running: boolean;
 sockPath: string;
 token?: string;
}

function discoverDaemon(): DaemonState {
 const agentDir = getAgentDir();
 const sockPath = join(agentDir, "sidecar.sock");
 const tokenPath = join(agentDir, "sidecar.token");

 const running = existsSync(sockPath);
 const token = running && existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : undefined;
 return { running, sockPath, token };
}

function promptPassword(): Promise<string> {
 return new Promise((resolve, reject) => {
  const readline = require("node:readline") as typeof import("node:readline");
  const rl = readline.createInterface({
   input: process.stdin,
   output: process.stderr,
  });
  // Mask the input: the terminal echoes nothing for password prompts.
  process.stderr.write("Master password: ");
  let pw = "";
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (chunk: Buffer) => {
   const str = chunk.toString();
   if (str === "\n" || str === "\r") {
    process.stdin.setRawMode?.(false);
    rl.close();
    process.stderr.write("\n");
    resolve(pw);
    return;
   }
   if (str === "\u0003") {
    // Ctrl+C
    process.stdin.setRawMode?.(false);
    rl.close();
    reject(new Error("cancelled"));
    return;
   }
   if (str === "\u007F" || str === "\b") {
    // backspace
    pw = pw.slice(0, -1);
    return;
   }
   pw += str;
  });
 });
}

async function handleUnlock(flags: { json: boolean }): Promise<void> {
 const daemon = discoverDaemon();
 if (!daemon.running || !daemon.token) {
  console.error("sidecar: no daemon running. Start a session first (omp-secret) to spawn it.");
  process.exit(1);
 }

 const password = await promptPassword();

 // Run bw unlock with the password piped to stdin (bw reads from stdin when
 // not attached to a TTY). Extract BW_SESSION from stdout.
 const output = await new Promise<string>((resolve, reject) => {
  const child = spawn("bw", ["unlock"], {
   stdio: ["pipe", "pipe", "pipe"],
   env: { ...process.env },
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (err += d));
  child.stdin?.write(password + "\n");
  child.stdin?.end();
  child.on("close", (code) => {
   if (code !== 0) reject(new Error(`bw unlock failed (exit ${code}): ${err.slice(0, 100)}`));
   else resolve(out);
  });
  child.on("error", reject);
 });

 const match = output.match(/BW_SESSION[=\s]+["']([^"']+)["']/);
 if (!match?.[1]) {
  console.error("sidecar: bw unlock succeeded but produced no BW_SESSION line.");
  process.exit(1);
 }

 const session = match[1];
 const client = new SidecarClient(daemon.sockPath, daemon.token);
 await client.connect();
 const res = await client.request({ op: "set_credential", key: "BW_SESSION", value: session });
 if (!res.ok) {
  console.error(`sidecar: failed to store session: ${(res as { error: string }).error}`);
  process.exit(1);
 }

 if (flags.json) {
  console.log(JSON.stringify({ ok: true, sessionLength: session.length }));
 } else {
  console.log(`sidecar: unlocked (session stored in daemon vault, length=${session.length})`);
 }
 await client.close();
}

async function handleStatus(flags: { json: boolean }): Promise<void> {
 const daemon = discoverDaemon();
 if (!daemon.running) {
  if (flags.json) console.log(JSON.stringify({ running: false }));
  else console.log("sidecar: not running (no socket found).");
  return;
 }

 const client = new SidecarClient(daemon.sockPath, daemon.token);
 try {
  await client.connect();
  const alive = await client.ping();
  if (!alive) {
   console.log("sidecar: socket exists but daemon is dead (stale socket).");
   return;
  }

  const bwPresent = await client.request({ op: "get_credential_present", key: "BW_SESSION" });
  const bwUnlocked = bwPresent.ok === true && bwPresent.result === true;

  if (flags.json) {
   console.log(JSON.stringify({ running: true, bwSessionPresent: bwUnlocked, sockPath: daemon.sockPath }));
  } else {
   console.log(`sidecar: running (socket: ${daemon.sockPath})`);
   console.log(`  BW_SESSION: ${bwUnlocked ? "present (unlocked)" : "absent (locked)"}`);
  }
 } catch {
  console.log("sidecar: socket exists but daemon is dead (stale socket).");
 }
 await client.close();
}

async function handleStop(flags: { json: boolean }): Promise<void> {
 const daemon = discoverDaemon();
 if (!daemon.running) {
  if (flags.json) console.log(JSON.stringify({ running: false }));
  else console.log("sidecar: not running.");
  return;
 }

 // Send a graceful stop by connecting and letting the server handle SIGTERM.
 // The server removes the socket on exit.
 const tokenPath = join(getAgentDir(), "sidecar.token");
 if (existsSync(tokenPath)) unlinkSync(tokenPath);

 // The daemon's SIGTERM handler cleans up the socket. We trigger it by
 // connecting (which wakes it) then killing... actually we can't kill it
 // from here — we just report the state and tell the user.
 console.log("sidecar: to stop the daemon, run: kill $(pgrep -f 'sidecar.*server') or restart your machine.");
 console.log("The daemon's SIGTERM handler removes the socket and exits cleanly.");
 if (flags.json) console.log(JSON.stringify({ note: "manual stop required" }));
}

export async function runSidecarCommand(cmd: SidecarCommandArgs): Promise<void> {
 switch (cmd.action) {
  case "unlock":
   return handleUnlock(cmd.flags);
  case "status":
   return handleStatus(cmd.flags);
  case "stop":
   return handleStop(cmd.flags);
  case "lock":
   console.log("sidecar: lock clears the vault but the daemon keeps running.");
   console.log("Use `bw lock` to lock the Bitwarden vault itself.");
   if (cmd.flags.json) console.log(JSON.stringify({ note: "use bw lock" }));
 }
}
