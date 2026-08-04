import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_EXTENDED_PREFIX = /^\\\\[?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_EXTENDED_PREFIX = /^\\\\[?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;
const WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/([A-Za-z]:\/.*)$/;
const WINDOWS_UNC_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i;
const WINDOWS_DRIVE_NT_PREFIX = /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_NT_PREFIX = /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;

/** Removes Win32 extended-length prefixes before passing paths to Bun APIs. */
export function stripWindowsExtendedLengthPathPrefix(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return filePath;

	const uncMatch = WINDOWS_UNC_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_UNC_NT_PREFIX.exec(filePath);
	if (uncMatch) return `\\\\${uncMatch[1]}\\${uncMatch[2]}`;

	const driveMatch = WINDOWS_DRIVE_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_DRIVE_NT_PREFIX.exec(filePath);
	if (driveMatch) return driveMatch[1];

	const forwardUncMatch = WINDOWS_UNC_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardUncMatch) return `//${forwardUncMatch[1]}/${forwardUncMatch[2]}`;

	const forwardDriveMatch = WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardDriveMatch) return forwardDriveMatch[1];

	return filePath;
}

/**
 * Expand a leading `~` (or `~\` on Windows) to the home directory.
 *
 * Semantics (strict superset of every prior in-repo copy): empty strings and
 * non-`~` inputs pass through unchanged; bare `~` returns the home directory;
 * `~/x` and `~\x` splice the home prefix; `~foo` joins `foo` under the home
 * directory. Pass `home` to override the home directory resolution.
 */
export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}
