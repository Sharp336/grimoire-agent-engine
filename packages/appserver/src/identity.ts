import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { HostId } from "@oh-my-pi/app-wire";
import { hostId } from "@oh-my-pi/app-wire";

export function createHostId(value?: string): HostId {
	return hostId(value ?? `host-${randomUUID()}`);
}
export function createEpoch(value?: string): string {
	return value ?? `epoch-${randomUUID()}`;
}
export function defaultSocketPath(
	platform = process.platform,
	home = os.homedir(),
	runtime = process.env.XDG_RUNTIME_DIR,
): string {
	return platform === "darwin"
		? nodePath.join(home, ".omp", "run", "appserver.sock")
		: nodePath.join(runtime || nodePath.join(home, ".omp", "run"), "omp", "appserver.sock");
}
async function loadPersistentHostIdWithPublishHook(path: string, beforePublish?: () => Promise<void>): Promise<HostId> {
	try {
		const value = (await fs.readFile(path, "utf8")).trim();
		if (!value) throw new Error(`persistent appserver host ID is empty: ${path}`);
		return hostId(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const value = createHostId();
	await fs.mkdir(nodePath.dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temp, `${value}\n`, { flag: "wx", mode: 0o600 });
		await beforePublish?.();
		try {
			// Publish a complete inode without replacing a concurrent winner.
			await fs.link(temp, path);
			await fs.chmod(path, 0o600);
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const winner = (await fs.readFile(path, "utf8")).trim();
			if (!winner) throw new Error(`persistent appserver host ID is empty: ${path}`);
			return hostId(winner);
		}
	} finally {
		try {
			await fs.unlink(temp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				process.emitWarning(`failed to remove appserver host ID temporary file: ${String(error)}`);
		}
	}
}
export function loadPersistentHostId(
	path = nodePath.join(process.env.HOME || os.homedir(), ".omp", "agent", "appserver", "host-id"),
): Promise<HostId> {
	return loadPersistentHostIdWithPublishHook(path);
}
export const __internalsForTesting = { loadPersistentHostIdWithPublishHook };
export async function unixSocketActive(path: string): Promise<boolean> {
	const gate = Promise.withResolvers<boolean>();
	const socket = createConnection(path);
	socket.once("connect", () => {
		socket.destroy();
		gate.resolve(true);
	});
	socket.once("error", error => {
		socket.destroy();
		gate.resolve(
			(error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && (error as NodeJS.ErrnoException).code !== "ENOENT",
		);
	});
	return gate.promise;
}
