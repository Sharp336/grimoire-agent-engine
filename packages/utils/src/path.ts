import * as os from "node:os";

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
 * Semantics: empty strings and non-`~`-prefixed inputs pass through
 * unchanged; bare `~` returns the home directory; `~/x` splices the home
 * prefix on all platforms; `~\x` splices the home prefix only on Windows
 * (on POSIX, `\` is a valid filename character, not a separator, so `~\x`
 * is left untouched and resolves relative to the working directory). Other
 * `~`-prefixed forms (e.g. `~foo`) are left untouched. Pass `home` to
 * override the home directory resolution. Pass `platform` to override
 * platform detection (defaults to `process.platform`).
 */
export function expandTilde(filePath: string, home?: string, platform: NodeJS.Platform = process.platform): string {
	const isWindows = platform === "win32";
	if (filePath !== "~" && !filePath.startsWith("~/") && !(isWindows && filePath.startsWith("~\\"))) {
		return filePath;
	}
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	return h + filePath.slice(1);
}
