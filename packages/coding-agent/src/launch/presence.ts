import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isEisdir, isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import { daemonRuntimeDir } from "./paths";

const CLIENTS_DIR = "clients";

/** Default timeout for command socket round-trips. */
const COMMAND_TIMEOUT_MS = 5_000;

/** Fields written into each `clients/*.json` presence record. */
export interface RelayPresenceRecord {
	/** Process PID. */
	pid: number;
	/** Unique presence identifier. */
	id: string;
	/** Canonical project directory. */
	projectDir: string;
	/** Relay-link URI for cross-process discovery (e.g. `omp://session/…`). */
	relayLink?: string;
	/** Room key for grouping processes in the same swarm session. */
	roomKey?: string;
}

/** Discovery result for a relay link found in the presence registry. */
export interface RelayLinkDiscovery {
	/** Process PID. */
	pid: number;
	/** Unique presence identifier. */
	id: string;
	/** Relay-link URI. */
	relayLink: string;
	/** Room key for grouping. */
	roomKey: string;
	/** Canonical project directory. */
	projectDir: string;
}

/** Options for registering daemon project presence. */
export interface RegisterPresenceOptions {
	/** Override the runtime directory. */
	runtimeDir?: string;
	/** Relay-link URI for cross-process discovery. */
	relayLink?: string;
	/** Room key for grouping processes in the same swarm session. */
	roomKey?: string;
}

/** Command types accepted by the command socket. */
export type CommandSocketCmd = "gate-response" | "kill" | "pause" | "resume";

/** A command sent over the command socket. */
export interface CommandSocketMessage {
	cmd: CommandSocketCmd;
	payload: Record<string, unknown>;
}

/** Response from a command socket. */
export interface CommandSocketResponse {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
}

/** Handle keeping one omp process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	readonly id: string;
	close(): Promise<void>;
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/** Register this omp process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	options: RegisterPresenceOptions = {},
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = options.runtimeDir ?? daemonRuntimeDir(canonical);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	const record: RelayPresenceRecord = {
		pid: process.pid,
		id,
		projectDir: canonical,
		relayLink: options.relayLink,
		roomKey: options.roomKey,
	};
	await Bun.write(presencePath, JSON.stringify(record));
	await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { id, close };
}

/** Return whether a registered omp process in this runtime directory is still alive. */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			try {
				process.kill(decoded.pid, 0);
				live = true;
			} catch {
				await fs.rm(presencePath, { force: true });
			}
		} catch (error) {
			if (!isEnoent(error)) await fs.rm(presencePath, { force: true });
		}
	}
	return live;
}

/** Discover relay links from live processes in the presence registry. */
export async function discoverRelayLinks(
	runtimeDir: string,
	selfPresence?: DaemonProjectPresence,
): Promise<RelayLinkDiscovery[]> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const results: RelayLinkDiscovery[] = [];
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				continue;
			}
			const record = decoded as Record<string, unknown>;
			const pid = record.pid as number;
			// Check if process is still alive
			try {
				process.kill(pid, 0);
			} catch {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			// Skip own presence if selfPresence is provided (match by id, not pid)
			if (selfPresence && record.id === selfPresence.id) {
				continue;
			}
			// Only include entries that have relayLink
			if (
				typeof record.relayLink === "string" &&
				record.relayLink.length > 0
			) {
				results.push({
					pid,
					id: (record.id as string) ?? "",
					relayLink: record.relayLink as string,
					roomKey: (record.roomKey as string) ?? "",
					projectDir: (record.projectDir as string) ?? "",
				});
			}
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}
	}
	return results;
}

/** Send a command to a command socket and await the response. */
export async function sendCommand(
	socketPath: string,
	message: CommandSocketMessage,
	timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandSocketResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandSocketResponse>();
	const socket = net.createConnection(socketPath);
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
	};

	const timer = setTimeout(() => {
		finish();
		reject(new Error(`Command socket timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	socket.setEncoding("utf8");
	let buffer = "";

	socket.on("data", chunk => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line) return;
		try {
			const response = JSON.parse(line) as CommandSocketResponse;
			finish();
			resolve(response);
		} catch {
			// Ignore malformed lines
		}
	});

	socket.on("error", error => {
		finish();
		reject(error);
	});

	// Send the command
	socket.write(JSON.stringify(message) + "\n");

	try {
		const result = await promise;
		clearTimeout(timer);
		return result;
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
}
