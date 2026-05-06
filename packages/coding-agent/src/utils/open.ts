import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { $which } from "@oh-my-pi/pi-utils/which";

export interface OpenCommandEnvironment {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	procVersion?: string;
	exists(filePath: string): boolean;
	toWindowsPath(filePath: string): string | undefined;
	hasCommand(command: string): boolean;
}

function readProcVersion(): string | undefined {
	try {
		return fs.readFileSync("/proc/version", "utf8");
	} catch {
		return undefined;
	}
}

function toWindowsPath(filePath: string): string | undefined {
	try {
		const result = Bun.spawnSync(["wslpath", "-w", filePath], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return undefined;

		return result.stdout.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

function getDefaultEnvironment(): OpenCommandEnvironment {
	return {
		platform: process.platform,
		env: process.env,
		procVersion: readProcVersion(),
		exists: fs.existsSync,
		toWindowsPath,
		hasCommand: command => $which(command) !== null,
	};
}

function isWsl(env: Pick<OpenCommandEnvironment, "platform" | "env" | "procVersion">): boolean {
	if (env.platform !== "linux") return false;
	if (env.env.WSL_DISTRO_NAME || env.env.WSL_INTEROP) return true;

	return env.procVersion?.toLowerCase().includes("microsoft") ?? false;
}

function getExistingLocalPath(urlOrPath: string, exists: (filePath: string) => boolean): string | undefined {
	try {
		if (urlOrPath.startsWith("file://")) {
			const filePath = url.fileURLToPath(urlOrPath);
			return exists(filePath) ? filePath : undefined;
		}

		if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(urlOrPath)) return undefined;

		const filePath = path.resolve(urlOrPath);
		return exists(filePath) ? filePath : undefined;
	} catch {
		return undefined;
	}
}

export function resolveOpenCommand(urlOrPath: string, env: OpenCommandEnvironment = getDefaultEnvironment()): string[] {
	if (isWsl(env)) {
		const filePath = getExistingLocalPath(urlOrPath, env.exists);
		const windowsPath = filePath ? env.toWindowsPath(filePath) : undefined;
		if (windowsPath) {
			if (env.hasCommand("wslview")) return ["wslview", windowsPath];
			if (env.hasCommand("cmd.exe")) return ["cmd.exe", "/c", "start", "", windowsPath];
		}
	}

	switch (env.platform) {
		case "darwin":
			return ["open", urlOrPath];
		case "win32":
			return ["rundll32", "url.dll,FileProtocolHandler", urlOrPath];
		default:
			return ["xdg-open", urlOrPath];
	}
}

/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	try {
		cmd = resolveOpenCommand(urlOrPath);
		const process = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		process.exited
			.then(exitCode => {
				if (exitCode !== 0) {
					logger.warn("Failed to open path", { command: cmd[0], exitCode, target: urlOrPath });
				}
			})
			.catch(error => {
				logger.warn("Failed to observe open command", {
					command: cmd[0],
					error: error instanceof Error ? error.message : String(error),
					target: urlOrPath,
				});
			});
	} catch (error) {
		logger.warn("Failed to open path", {
			error: error instanceof Error ? error.message : String(error),
			target: urlOrPath,
		});
	}
}
