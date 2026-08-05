import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getSessionsDir, getTerminalSessionsDir, isEnoent, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	legacyRelativeDirName: string | undefined;
	resolvedCwd: string;
} {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);

	let scope: "home" | "tmp" | "abs";
	let legacyRelativeDirName: string | undefined;
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		scope = "home";
		legacyRelativeDirName = encodeRelativeSessionDirName("-", homeRelative);
	} else if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		scope = "tmp";
		legacyRelativeDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
	} else {
		scope = "abs";
	}

	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	const encodedDirName = `${scope}-${readable || "project"}-${digest}`;
	return { encodedDirName, legacyRelativeDirName, resolvedCwd };
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName, legacyRelativeDirName } = getDefaultSessionDirName(cwd);
	if (
		currentDirName !== encodedDirName &&
		currentDirName !== legacyRelativeDirName &&
		currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)
	) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/** A managed session directory that remains part of the project's read set. */
export type ManagedSessionDirectoryKind = "hashed" | "legacy";

export interface ManagedSessionDirectory {
	path: string;
	kind: ManagedSessionDirectoryKind;
}

export interface DefaultSessionDirectories {
	canonicalDir: string;
	readableDirs: readonly ManagedSessionDirectory[];
}

/**
 * Resolve the canonical session directory and any coexisting legacy
 * directories that may still contain sessions from older versions.
 */
export function resolveDefaultSessionDirectories(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): DefaultSessionDirectories {
	const { encodedDirName, legacyRelativeDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	const canonicalDir = path.join(sessionsRoot, encodedDirName);
	const legacyDirs = [
		legacyRelativeDirName ? path.join(sessionsRoot, legacyRelativeDirName) : undefined,
		path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(resolvedCwd)),
	].filter((legacyDir): legacyDir is string => legacyDir !== undefined && legacyDir !== canonicalDir);
	storage.ensureDirSync(canonicalDir);

	const readableDirs: ManagedSessionDirectory[] = [{ path: canonicalDir, kind: "hashed" }];
	for (const legacyDir of legacyDirs) {
		try {
			const stat = fs.lstatSync(legacyDir, { throwIfNoEntry: false });
			if (stat?.isDirectory()) readableDirs.push({ path: legacyDir, kind: "legacy" });
		} catch (error) {
			logger.warn("Failed to inspect legacy session directory", {
				legacyDir,
				canonicalDir,
				error: String(error),
			});
		}
	}
	return { canonicalDir, readableDirs };
}

/** Compute the collision-safe canonical session directory for a cwd. */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	return resolveDefaultSessionDirectories(cwd, storage, sessionsRoot).canonicalDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * `fresh` marks a `/new` (or freshly-minted) session boundary whose JSONL is
 * not yet materialized (new-session persistence is lazy until assistant output
 * exists). A fresh breadcrumb is honored by {@link readTerminalBreadcrumbEntry}
 * even when its target file is still absent, so relaunch/auto-resume reopens the
 * post-`/new` session instead of falling back to the pre-`/new` transcript. Once
 * the session materializes the caller rewrites the breadcrumb with `fresh:false`
 * so a later external delete is still treated as a genuinely stale crumb.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = fresh ? `${cwd}\n${sessionFile}\nfresh\n` : `${cwd}\n${sessionFile}\n`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy `/new` fresh crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh.
	try {
		fs.mkdirSync(breadcrumbDir, { recursive: true });
		fs.writeFileSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file regardless of whether the recorded
 * cwd still matches the current one. Callers decide how to interpret a cwd
 * mismatch (e.g. a moved/renamed worktree).
 *
 * A missing target file yields `null` UNLESS the breadcrumb is a `fresh`
 * boundary — a lazy `/new` session whose JSONL was never written — in which case
 * the entry is returned with `exists:false` so the caller can distinguish it
 * from a genuinely stale/deleted breadcrumb.
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];
		const fresh = lines[2] === "fresh";

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a fresh `/new` boundary (never-written lazy session).
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
