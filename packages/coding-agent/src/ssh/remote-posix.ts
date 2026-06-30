import { ptree } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath, wrapInPosixShell } from "./utils";

export type RemotePosixShell = "sh" | "bash" | "zsh";

const DEFAULT_REMOTE_CWD_TIMEOUT_MS = 30_000;

const POSIX_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function ensureRemotePosixShell(
	target: SSHConnectionTarget,
	purpose = "remote execution",
): Promise<RemotePosixShell> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (info.os === "windows") {
		throw new Error(`${purpose} requires a POSIX SSH host; ${target.name} is Windows`);
	}
	if (!info.transferShell) {
		throw new Error(
			`${purpose} requires a verified POSIX shell on ${target.name}; none of sh/bash/zsh passed the capability probe`,
		);
	}
	return info.transferShell;
}

export function formatPosixEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			if (!POSIX_ENV_NAME_PATTERN.test(key)) {
				throw new Error(`Invalid remote environment variable name: ${key}`);
			}
			return `${key}=${quotePosixPath(value)}`;
		})
		.join(" ");
}

export function buildRemotePosixCommand(options: {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
}): string {
	const assignments = formatPosixEnvAssignments(options.env);
	const command = assignments ? `env ${assignments} ${options.command}` : options.command;
	if (!options.cwd) return command;
	return `cd -- ${quotePosixPath(options.cwd)} && ${command}`;
}

export async function resolveRemoteCwd(
	target: SSHConnectionTarget,
	cwd: string | undefined,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	const shell = await ensureRemotePosixShell(target, "Remote cwd resolution");
	const command = buildRemotePosixCommand({ command: "pwd -P", cwd: cwd ?? "." });
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_REMOTE_CWD_TIMEOUT_MS),
	});
	const text = new TextDecoder().decode(await child.bytes()).trim();
	await child.exitedCleanly;
	const resolved = text.split(/\r?\n/).at(-1)?.trim() ?? "";
	if (!resolved.startsWith("/")) {
		throw new Error(
			`Remote cwd resolution on ${target.name} did not return an absolute POSIX path: ${resolved || "(empty)"}`,
		);
	}
	return resolved;
}
