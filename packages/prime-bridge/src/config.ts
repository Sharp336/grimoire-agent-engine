import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PRIME_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_PRIME_BRIDGE_PORT = 0;

export interface PrimeBridgeConfig {
	stateDir: string;
	databasePath: string;
	tokenFile: string;
	primeConfigFile: string;
	host: typeof PRIME_BRIDGE_HOST;
	port: number;
	allowedOrigins: readonly string[];
}

export interface PrimeBridgeConfigOverrides {
	stateDir?: string;
	databasePath?: string;
	tokenFile?: string;
	primeConfigFile?: string;
	port?: number;
	allowedOrigins?: readonly string[];
}

export interface PrimeBridgePointerConfig {
	url: string;
	tokenFile: string;
}

function absolute(filePath: string): string {
	return path.resolve(filePath);
}

function validatePort(port: number): number {
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new RangeError("bridge port must be an integer between 0 and 65535");
	}
	return port;
}

export function resolveBridgeConfig(overrides: PrimeBridgeConfigOverrides = {}): PrimeBridgeConfig {
	const stateDir = absolute(overrides.stateDir ?? path.join(os.homedir(), ".omp", "agent", "prime-bridge"));
	return {
		stateDir,
		databasePath: absolute(overrides.databasePath ?? path.join(stateDir, "bridge.sqlite")),
		tokenFile: absolute(overrides.tokenFile ?? path.join(stateDir, "token")),
		primeConfigFile: absolute(
			overrides.primeConfigFile ?? path.join(os.homedir(), ".prime", "agent", "omp-bridge.json"),
		),
		host: PRIME_BRIDGE_HOST,
		port: validatePort(overrides.port ?? DEFAULT_PRIME_BRIDGE_PORT),
		allowedOrigins: [...(overrides.allowedOrigins ?? [])],
	};
}

async function ensureParentDirectory(filePath: string): Promise<void> {
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	await fs.chmod(parent, 0o700);
}

export async function provisionPrimeBridgeConfig(filePath: string, pointer: PrimeBridgePointerConfig): Promise<void> {
	if (!pointer.url || !pointer.tokenFile) throw new Error("Prime bridge pointer requires url and tokenFile");
	await ensureParentDirectory(filePath);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = `${JSON.stringify({ url: pointer.url, tokenFile: absolute(pointer.tokenFile) })}\n`;
	try {
		await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fs.chmod(temporaryPath, 0o600);
		await fs.rename(temporaryPath, filePath);
		await fs.chmod(filePath, 0o600);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}
