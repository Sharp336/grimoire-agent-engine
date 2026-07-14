import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface OwnerRecord {
	version: 3;
	ownerId: string;
	pid: number;
	processStartMarker: string;
	backingName: string;
	device: number;
	inode: number;
}

export interface OwnerMarkerSnapshot {
	device: number;
	inode: number;
	mtimeMs: number;
	content: Uint8Array;
}

export interface OwnerPaths {
	directory: string;
	ownerPath: string;
	backingPath: string;
	backingName: string;
	publicPath: string;
}

export interface StrictOwnerRead {
	record: OwnerRecord;
	stat: fs.Stats;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OWNER_MARKER_BYTES = 16 * 1024;
const MAX_PROCESS_START_MARKER_BYTES = 256;
const encoder = new TextEncoder();

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function decodeOwnerRecord(value: unknown): OwnerRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed appserver owner record");
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["backingName", "device", "inode", "ownerId", "pid", "processStartMarker", "version"]))
		throw new Error("malformed appserver owner record");
	if (
		record.version !== 3 ||
		typeof record.ownerId !== "string" ||
		!UUID.test(record.ownerId) ||
		!validInteger(record.pid, 1) ||
		typeof record.processStartMarker !== "string" ||
		record.processStartMarker.length === 0 ||
		encoder.encode(record.processStartMarker).byteLength > MAX_PROCESS_START_MARKER_BYTES ||
		typeof record.backingName !== "string" ||
		!UUID.test(record.backingName.slice(".appserver-".length, -".sock".length)) ||
		record.backingName !== `.appserver-${record.ownerId}.sock` ||
		!validInteger(record.device, 0) ||
		!validInteger(record.inode, 0)
	)
		throw new Error("malformed appserver owner record");
	return {
		version: 3,
		ownerId: record.ownerId,
		pid: record.pid,
		processStartMarker: record.processStartMarker,
		backingName: record.backingName,
		device: record.device,
		inode: record.inode,
	};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

export function sameOwnerMarkerSnapshot(left: OwnerMarkerSnapshot, right: OwnerMarkerSnapshot): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.mtimeMs === right.mtimeMs &&
		sameBytes(left.content, right.content)
	);
}

export function ownerPaths(publicPath: string, ownerId: string): OwnerPaths {
	const directory = path.dirname(publicPath);
	const backingName = `.appserver-${ownerId}.sock`;
	return {
		directory,
		ownerPath: `${publicPath}.owner`,
		backingPath: path.join(directory, backingName),
		backingName,
		publicPath,
	};
}

export function sameIdentity(
	a: Pick<OwnerRecord, "device" | "inode">,
	b: Pick<OwnerRecord, "device" | "inode">,
): boolean {
	return a.device === b.device && a.inode === b.inode;
}

export async function ensureSecureSocketDirectory(publicPath: string): Promise<string> {
	const directory = path.resolve(path.dirname(publicPath));
	const parts = directory.split(path.sep).filter(Boolean);
	let current = directory.startsWith(path.sep) ? path.sep : "";
	for (const part of parts) {
		current = current ? path.join(current, part) : part;
		let created = false;
		let info: fs.Stats;
		try {
			info = await fsp.lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await fsp.mkdir(current, { mode: 0o700 });
				created = true;
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
			}
			info = await fsp.lstat(current);
		}
		if (info.isSymbolicLink()) throw new Error(`appserver socket directory is a symlink: ${current}`);
		if (!info.isDirectory()) throw new Error(`appserver socket directory is not a directory: ${current}`);
		// Existing parents are caller-owned and must never be chmodded. Accept
		// ordinary non-writable parents and sticky temporary directories such as
		// /tmp, but reject paths another user can rename entries within freely.
		if (!created && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
			throw new Error(`appserver socket directory is writable by other users: ${current}`);
	}
	const info = await fsp.lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`appserver socket directory is not a secure directory: ${directory}`);
	return directory;
}

export async function readStrictOwner(ownerPath: string): Promise<StrictOwnerRead> {
	const first = await fsp.lstat(ownerPath);
	if (first.isSymbolicLink() || !first.isFile() || (first.mode & 0o777) !== 0o600)
		throw new Error("malformed appserver owner marker");
	const text = await fsp.readFile(ownerPath, "utf8");
	const second = await fsp.lstat(ownerPath);
	if (first.dev !== second.dev || first.ino !== second.ino)
		throw new Error("appserver owner marker changed during read");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("malformed appserver owner marker");
	}
	return { record: decodeOwnerRecord(parsed), stat: first };
}

/**
 * Capture even malformed owner content without following links. This is used
 * only to recover a stable, old, crash-truncated marker under an atomic rename
 * claim; normal owner reads continue through the stricter decoder above.
 */
export async function readOwnerMarkerSnapshot(ownerPath: string): Promise<OwnerMarkerSnapshot> {
	const first = await fsp.lstat(ownerPath);
	if (
		first.isSymbolicLink() ||
		!first.isFile() ||
		(first.mode & 0o777) !== 0o600 ||
		first.size > MAX_OWNER_MARKER_BYTES
	)
		throw new Error("malformed appserver owner marker");
	const content = await fsp.readFile(ownerPath);
	const second = await fsp.lstat(ownerPath);
	if (
		first.dev !== second.dev ||
		first.ino !== second.ino ||
		first.mtimeMs !== second.mtimeMs ||
		content.byteLength !== second.size
	)
		throw new Error("appserver owner marker changed during read");
	return {
		device: Number(first.dev),
		inode: Number(first.ino),
		mtimeMs: first.mtimeMs,
		content,
	};
}

export async function readPublicTarget(
	publicPath: string,
): Promise<{ stat: { device: number; inode: number }; target: string }> {
	const info = await fsp.lstat(publicPath);
	if (!info.isSymbolicLink()) throw new Error("appserver public path is not an owned symlink");
	const target = await fsp.readlink(publicPath);
	if (
		path.isAbsolute(target) ||
		target.includes("/") ||
		target.includes("\\") ||
		target === "." ||
		target === ".." ||
		path.relative(path.dirname(publicPath), path.resolve(path.dirname(publicPath), target)) !== target
	)
		throw new Error("appserver public symlink target is unsafe");
	return { stat: { device: Number(info.dev), inode: Number(info.ino) }, target };
}

export async function unlinkIfExists(path: string): Promise<void> {
	try {
		await fsp.unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function markerIdentity(handle: fsp.FileHandle): Promise<{ device: number; inode: number }> {
	const info = await handle.stat();
	return { device: Number(info.dev), inode: Number(info.ino) };
}
