/**
 * Platform-aware filesystem primitives shared by council storage and council publication.
 *
 * Both layers were originally written against a POSIX crash-consistency model: fsync the parent
 * directory to commit a rename, install with a hard link for an atomic no-clobber create, close the
 * symlink race with `O_NOFOLLOW`, and rely on `rename` replacing an open destination. Three of those
 * four do not hold on Windows, and the hard link is a filesystem capability rather than an OS
 * guarantee even on POSIX. Every deviation lives here so a fifth copy cannot reintroduce it.
 */
import * as nodeFs from "node:fs";
import type * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasAnyFsCode } from "@oh-my-pi/pi-utils";

const IS_WINDOWS = process.platform === "win32";

/**
 * `O_NOFOLLOW` is POSIX-only; Windows leaves `fs.constants.O_NOFOLLOW` undefined, and `x | undefined`
 * coerces to `x` so the flag would vanish silently. Naming the fallback keeps that visible: on
 * Windows the `lstat` gate plus the post-open device/inode equality check carry the guarantee alone.
 */
export const O_NOFOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

/** Exclusive create for every staged council temp file: no clobber, no symlink traversal, owner-only. */
export const COUNCIL_STAGE_FLAGS =
	nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | O_NOFOLLOW;
/** Advisory on Windows, where `mode` only drives the read-only attribute and confers no access control. */
export const COUNCIL_STAGE_MODE = 0o600;
/** Read a council file without traversing a symlink at the final component. */
export const COUNCIL_READ_FLAGS = nodeFs.constants.O_RDONLY | O_NOFOLLOW;

/** `candidate` is `root` itself or lies beneath it. Case-insensitive on Windows, matching `path.relative`. */
export function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Council temp files are always siblings of their target, so 48 bits of entropy is ample: `O_EXCL`
 * turns a collision into a visible error rather than corruption. The full 36-character UUID this
 * replaces added 42 characters of decoration, which pushed `council-<runId>-manifest.json` past the
 * ~260-character Windows path ceiling on ordinary checkouts.
 */
export function councilTempPath(directory: string, stem: string, token: string): string {
	return path.join(directory, `.${stem}.${token.replaceAll("-", "").slice(-12)}.tmp`);
}

/**
 * POSIX durability step: fsync the parent so a completed rename or link survives a crash.
 *
 * Windows has no equivalent. `CreateFileW` cannot open a directory as a file handle without
 * `FILE_FLAG_BACKUP_SEMANTICS`, so libuv returns `EISDIR`, and `FlushFileBuffers` rejects directory
 * handles even when the open succeeds. Failing here would fail every council write, so the step is
 * skipped and NTFS metadata ordering is the guarantee that remains. The callback fires only when a
 * sync actually happened, so observers never record durability the run did not get.
 */
export async function syncDirectory(
	filesystem: Pick<typeof fs, "open">,
	directory: string,
	onOperation?: (operation: "directory-sync", targetPath: string) => void,
): Promise<void> {
	if (IS_WINDOWS) return;
	const handle = await filesystem.open(directory, "r");
	try {
		await handle.sync();
		onOperation?.("directory-sync", directory);
	} finally {
		await handle.close();
	}
}

/**
 * Resolve a session-local council root to its canonical path.
 *
 * Only the **final component** is gated: it must be a real directory, never a symlink, because that
 * is what makes a council artifact and its staged sibling provably co-located. Ancestors are
 * deliberately unconstrained — macOS resolves `/var` to `/private/var`, checkouts are routinely
 * reached through a symlinked home, and `resolveLocalRoot` falls back to `os.tmpdir()/omp-local/<id>`
 * for sessions without an artifacts directory. Asserting `realpath(root) === resolve(root)` would
 * therefore reject a perfectly healthy session, so every containment and `path.dirname` comparison
 * downstream is made against the canonical value this returns instead.
 */
export async function canonicalizeLocalRoot(
	lexicalRoot: string,
	filesystem: Pick<typeof fs, "lstat" | "realpath" | "mkdir" | "open">,
	options: {
		create?: boolean;
		onDurabilityOperation?: (operation: "directory-sync", targetPath: string) => void;
	} = {},
): Promise<string> {
	const root = path.resolve(lexicalRoot);
	const assertRealDirectory = async () => {
		const info = await filesystem.lstat(root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("local root is not a real directory");
	};
	let created = false;
	try {
		await assertRealDirectory();
	} catch (error) {
		if (!options.create || !hasAnyFsCode(error, "ENOENT")) throw error;
		await filesystem.mkdir(root, { recursive: true });
		created = true;
		await assertRealDirectory();
	}
	const canonicalRoot = await filesystem.realpath(root);
	// Re-gate after `realpath`: the two syscalls are not atomic, so a swap between them would
	// otherwise hand back a canonical path for a root that is no longer a real directory.
	await assertRealDirectory();
	if (created) await syncDirectory(filesystem, path.dirname(root), options.onDurabilityOperation);
	return canonicalRoot;
}

/**
 * Install `source` at `target` without ever clobbering an existing file.
 *
 * `link` is the fast path and carries the invariant directly: it fails `EEXIST` instead of
 * overwriting. But a hard link is a filesystem capability, not an OS guarantee - `CreateHardLinkW`
 * requires NTFS or ReFS, and FAT/exFAT volumes, most SMB shares, and several virtualized bind mounts
 * refuse it on every platform. The fallback preserves the invariant that callers actually depend on,
 * atomic exclusive create, and gives up only the shared inode, which none of them observe.
 *
 * `EEXIST` propagates from either path so callers keep mapping it to their own collision semantics.
 */
export async function linkExclusive(
	filesystem: Pick<typeof fs, "open" | "link">,
	source: string,
	target: string,
): Promise<void> {
	try {
		await filesystem.link(source, target);
		return;
	} catch (error) {
		if (!hasAnyFsCode(error, "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS")) throw error;
	}
	const reader = await filesystem.open(source, COUNCIL_READ_FLAGS);
	let content: Buffer;
	try {
		content = await reader.readFile();
	} finally {
		await reader.close();
	}
	const writer = await filesystem.open(target, COUNCIL_STAGE_FLAGS, COUNCIL_STAGE_MODE);
	try {
		await writer.writeFile(content);
		await writer.sync();
	} finally {
		await writer.close();
	}
}

const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 25;

/**
 * POSIX `rename` replaces the destination atomically regardless of who holds it open. Windows
 * `MoveFileEx(REPLACE_EXISTING)` fails `EPERM`/`EACCES`/`EBUSY` while any process holds the
 * destination without `FILE_SHARE_DELETE` - antivirus, Search Indexer, an editor, or a second omp
 * reading the manifest - which would surface as intermittently failing checkpoints. Retry inside a
 * bounded window there; on POSIX a failure is real and propagates immediately.
 */
export async function renameReplacing(
	filesystem: Pick<typeof fs, "rename">,
	source: string,
	target: string,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await filesystem.rename(source, target);
			return;
		} catch (error) {
			const retryable = IS_WINDOWS && hasAnyFsCode(error, "EPERM", "EACCES", "EBUSY");
			if (!retryable || attempt >= RENAME_RETRY_ATTEMPTS) throw error;
			await Bun.sleep(RENAME_RETRY_DELAY_MS * attempt);
		}
	}
}
