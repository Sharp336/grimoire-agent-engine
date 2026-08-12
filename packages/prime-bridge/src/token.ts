import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
}

async function rejectSymlink(filePath: string): Promise<void> {
	try {
		const stats = await fs.lstat(filePath);
		if (stats.isSymbolicLink()) throw new Error(`bridge token path must not be a symlink: ${filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function ensureBridgeToken(tokenFile: string): Promise<string> {
	const resolvedPath = path.resolve(tokenFile);
	await ensurePrivateDirectory(path.dirname(resolvedPath));
	await rejectSymlink(resolvedPath);

	try {
		const existing = (await fs.readFile(resolvedPath, "utf8")).trim();
		if (existing.length === 0) throw new Error(`bridge token file is empty: ${resolvedPath}`);
		await fs.chmod(resolvedPath, 0o600);
		return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const token = `${randomUUID()}${randomUUID()}`;
	const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
	let temporaryHandle: fs.FileHandle | undefined;
	try {
		temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
		await temporaryHandle.writeFile(token, "utf8");
		await temporaryHandle.sync();
		await temporaryHandle.close();
		temporaryHandle = undefined;
		try {
			await fs.link(temporaryPath, resolvedPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await temporaryHandle?.close();
		await fs.rm(temporaryPath, { force: true });
	}

	await rejectSymlink(resolvedPath);
	const published = (await fs.readFile(resolvedPath, "utf8")).trim();
	if (published.length === 0) throw new Error(`bridge token file is empty: ${resolvedPath}`);
	await fs.chmod(resolvedPath, 0o600);
	return published;
}
