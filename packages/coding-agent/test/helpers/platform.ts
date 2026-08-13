import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";

export const isWindows = process.platform === "win32";

let symlinkProbe: boolean | undefined;

/**
 * Whether this host can actually create a symlink.
 *
 * `process.platform` is not enough: Windows permits symlink creation only under Developer Mode or an
 * elevated process and otherwise fails `EPERM`, so the capability has to be probed rather than
 * inferred. Memoized, since the answer cannot change inside one test process.
 */
export function symlinksSupported(): boolean {
	if (symlinkProbe !== undefined) return symlinkProbe;
	using temp = TempDir.createSync("@omp-symlink-probe-");
	const target = temp.join("target");
	fs.writeFileSync(target, "probe");
	try {
		fs.symlinkSync(target, temp.join("link"));
		symlinkProbe = true;
	} catch {
		symlinkProbe = false;
	}
	return symlinkProbe;
}

/**
 * `type` argument for a symlink whose target is a directory. Node defaults to `"file"` on Windows,
 * which produces a link that resolves to nothing even when symlink creation is permitted.
 */
export const directorySymlinkType = isWindows ? "junction" : "dir";

/**
 * Filters an expected council durability-operation sequence for the running platform.
 *
 * `syncDirectory` fsyncs a parent directory to commit a rename or link, which Windows cannot do at
 * all, so council skips the step there and never reports it.
 */
export function durableOps<T extends string>(...operations: T[]): T[] {
	return isWindows ? operations.filter(operation => operation !== "directory-sync") : operations;
}
