import { tmpdir } from "node:os";
import { join } from "node:path";

/** Return Prime's per-user Unix socket path, or an explicit override. */
export function defaultPrimeDaemonSocketPath(explicitPath?: string): string {
	if (explicitPath !== undefined) return explicitPath;
	if (process.platform === "win32") return "\\\\.\\pipe\\prime-agent-daemon";
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`, "daemon.sock");
}
