import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * S4 — Broker-owned restricted SSH agent.
 *
 * The agent's bash tool inherits your full SSH agent (SSH_AUTH_SOCK). It can
 * ssh to any host your keys authorize — including the VPS, where it can
 * `cat /srv/infrastructure/secrets/*` — bypassing the broker entirely.
 *
 * The fix: a separate, broker-owned SSH agent holding ONLY the keys the
 * broker needs (e.g., just the Infisical machine-identity key for the VPS
 * chain). The broker's subprocesses get this restricted agent's socket; the
 * agent's bash keeps the full agent.
 *
 * Day-to-day: you start the broker-owned agent with only the scoped keys.
 * When the broker runs a chain (BW → SSH → Infisical), it passes the
 * restricted agent's socket. The agent's own bash still has your full agent,
 * but the broker's children only see the scoped one.
 */

export interface RestrictedSshAgent {
 socketPath: string;
 pid: number;
 stop: () => Promise<void>;
}

export interface RestrictedSshAgentOptions {
 /** Keys to add to the restricted agent (absolute paths). Only these keys. */
 keyPaths: string[];
 /** Socket directory (mode 0700). Default: tmpdir. */
 sockDir?: string;
}

/**
 * Start a broker-owned SSH agent with only the specified keys.
 *
 * The agent runs as a separate process (`ssh-agent -a <socket>`). Only the
 * keys in `keyPaths` are loaded — the agent has no access to your full key
 * chain. When the broker spawns a subprocess that needs SSH, it passes this
 * agent's socket as `SSH_AUTH_SOCK` in the hardened env (NOT your full
 * agent's socket).
 *
 * The agent's regular bash tool still sees your full SSH agent (for general
 * use). The broker's children only see the restricted one.
 */
export async function startRestrictedSshAgent(opts: RestrictedSshAgentOptions): Promise<RestrictedSshAgent> {
 const sockDir = opts.sockDir ?? mkdtempSync(join(tmpdir(), "omp-restricted-ssh-"));
 const socketPath = join(sockDir, "agent.sock");

 // Start ssh-agent with a custom socket path. `ssh-agent -a <path>` binds
 // to that socket instead of the default /tmp/ssh-XXXXX/agent.<pid>.
 const child = spawn("ssh-agent", ["-a", socketPath], {
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
 });

 let pid = 0;
 await new Promise<void>((resolve, reject) => {
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
   stdout += chunk.toString();
   // ssh-agent prints: SSH_AUTH_SOCK=<path>; export SSH_AUTH_SOCK;
   //                   SSH_AGENT_PID=<pid>; export SSH_AGENT_PID;
   const pidMatch = stdout.match(/SSH_AGENT_PID=(\d+)/);
   if (pidMatch) {
    pid = Number(pidMatch[1]);
    resolve();
   }
  });
  child.stderr?.on("data", (chunk) => {
   reject(new Error(`ssh-agent failed: ${chunk.toString()}`));
  });
  child.on("close", (code) => {
   if (code !== 0) reject(new Error(`ssh-agent exited ${code}`));
  });
 });

 // Add ONLY the scoped keys (never the full keychain).
 for (const keyPath of opts.keyPaths) {
  const addResult = Bun.spawnSync({
   cmd: ["ssh-add", keyPath],
   env: {
    ...process.env,
    SSH_AUTH_SOCK: socketPath,
   },
  });
  if (addResult.exitCode !== 0) {
   throw new Error(`ssh-add ${keyPath} failed: ${addResult.stderr.toString()}`);
  }
 }

 return {
  socketPath,
  pid,
  stop: async () => {
   try {
    process.kill(pid, "SIGTERM");
   } catch {
    // already dead
   }
   rmdirSync(sockDir);
  },
 };
}
