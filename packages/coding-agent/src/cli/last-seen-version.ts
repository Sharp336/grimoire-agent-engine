/**
 * One-line "omp updated: A → B" notice on session start.
 *
 * Why: with the auto-update flow (Seed seed_0ca7e1143ac1, Phase 4), the user
 * never runs `omp update` manually. New `omp` sessions just silently load
 * whatever the dev tree currently is. Without any signal, the user can't
 * tell when a real upstream update has landed. We persist the last version
 * the user saw and, on each new session, compare it to the current VERSION.
 * If they differ, we surface exactly one line of plain Korean prose. Then
 * we rewrite the last-seen file so the same line never repeats.
 *
 * Storage: a single plain-text file `~/.omp/state/last-seen-version`. One
 * line, just the semver. No JSON, no schema — keep it boring so the launchd
 * job or any other tool can grok it without parsing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const LAST_SEEN_FILE = path.join(process.env.HOME ?? "", ".omp", "state", "last-seen-version");

/**
 * Compute the one-line update notice to show, or undefined when no notice
 * should appear. Pure function — exposed for unit testing.
 *
 * Rules:
 *   - first run (lastSeen undefined or empty) → no notice
 *   - lastSeen === currentVersion → no notice
 *   - any difference → "omp updated: <lastSeen> → <currentVersion>"
 *
 * The first-run rule matters: brand-new installs would otherwise show a
 * misleading "omp updated: undefined → 15.0.0" on every fresh sandbox.
 */
export function computeUpdateNotice(
	lastSeen: string | undefined | null,
	currentVersion: string,
): string | undefined {
	const trimmed = (lastSeen ?? "").trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed === currentVersion) return undefined;
	return `omp updated: ${trimmed} → ${currentVersion}`;
}

/** Read the persisted last-seen version. Returns undefined if file missing or empty. */
export function readLastSeenVersion(file: string = LAST_SEEN_FILE): string | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Persist the version the user has now seen. Creates parent directory if
 * needed. Writes atomically (write-then-rename) to avoid a half-written
 * file on crash mid-write.
 */
export function writeLastSeenVersion(version: string, file: string = LAST_SEEN_FILE): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${version}\n`, { encoding: "utf-8", mode: 0o644 });
	fs.renameSync(tmp, file);
}
