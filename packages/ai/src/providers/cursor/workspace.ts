import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CursorRule, McpToolDefinition, RequestContext } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	McpFileSystemOptionsSchema,
	RequestContextEnvSchema,
	RequestContextSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/**
 * Absolute workspace roots for RequestContext and Imagine confinement.
 * Relative `workspacePaths` resolve against `options.cwd`, never against
 * `process.cwd()`: the session root and the process root diverge after
 * `/move` and in tests.
 */
export function resolveCursorWorkspacePaths(options?: { cwd?: string; workspacePaths?: string[] }): string[] {
	const cwd = options?.cwd?.trim() || undefined;
	const explicit = (options?.workspacePaths ?? []).map(entry => entry.trim()).filter(Boolean);
	const raw = explicit.length > 0 ? explicit : [cwd || process.cwd()];
	const base = cwd || process.cwd();
	return dedupeWorkspacePaths(raw.map(entry => path.resolve(base, entry)));
}

function dedupeWorkspacePaths(resolved: string[]): string[] {
	if (process.platform !== "win32") {
		return [...new Set(resolved)];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of resolved) {
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

/**
 * Fold Windows drive-letter / case so a later `writeArgs` path still hits
 * `persistedGenerateImagePaths`. A case miss lets proto3-empty `file_text`
 * truncate the PNG this turn just saved.
 */
export function normalizeCursorFsPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Cursor workspace URIs are `file://` URLs, not OS paths. */
export function toCursorFileUri(fsPath: string): string {
	return pathToFileURL(path.resolve(fsPath)).href;
}

function normalizeWorkspaceUri(uri: string): string {
	try {
		const parsed = new URL(uri);
		if (parsed.protocol !== "file:") return uri;
		// Trailing slash and drive-letter case are the same folder on Windows.
		let href = parsed.href.replace(/\/+$/, "");
		if (process.platform === "win32") {
			href = href.replace(/^file:\/\/\/([A-Za-z]):/, (_match, letter: string) => `file:///${letter.toLowerCase()}:`);
		}
		return href;
	} catch {
		return uri;
	}
}

/** Cursor CLI artifact dir (`~/.cursor/projects/{full-path-slug}/`). Basename-only slugs collide. */
export function cursorProjectFolder(workspaceRoot: string): string {
	return path.join(os.homedir(), ".cursor", "projects", cursorProjectSlug(workspaceRoot));
}

export function cursorProjectSlug(workspaceRoot: string): string {
	const resolved = path.resolve(workspaceRoot);
	const withDrive = resolved.replace(/^([A-Za-z]):/, (_match, letter: string) => letter.toLowerCase());
	return (
		withDrive
			.replace(/[\\/:.]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "workspace"
	);
}

/**
 * Hosted Imagine writes under `env.project_folder` (`~/.cursor/projects/<slug>/`).
 * Map that artifact path back onto the live workspace root so PNGs land in the repo.
 *
 * Relative `writeArgs` paths are returned unchanged. Resolving them with
 * `path.resolve(filePath)` would pin them to `process.cwd()`, which is not the
 * session workspace. They are resolved against each workspace root only to
 * test artifact-dir membership; non-artifact paths keep the original string
 * so the exec bridge still applies session-cwd resolution.
 */
export function remapCursorArtifactPath(filePath: string, workspacePaths: readonly string[]): string {
	if (!filePath) return filePath;
	for (const root of workspacePaths) {
		if (!root) continue;
		const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
		const artifactRoot = cursorProjectFolder(root);
		const relative = path.relative(artifactRoot, candidate);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
		return relative === "" ? path.resolve(root) : path.resolve(root, relative);
	}
	return filePath;
}

function tryRealpath(target: string): string | null {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return null;
	}
}

function isSymlink(target: string): boolean {
	try {
		return fs.lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

function isLexicallyInside(target: string, root: string): boolean {
	const relative = path.relative(normalizeCursorFsPath(root), normalizeCursorFsPath(target));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve `filePath` to an absolute path inside one of `workspacePaths`.
 *
 * Same realpath + ancestor walk as coding-agent `confineToWorkspace`, but
 * absolute inputs are allowed: Imagine remap yields absolute workspace
 * paths, while `confineToWorkspace` rejects them because MCP `download_path`
 * is relative-by-contract. A workspace-internal symlink whose realpath
 * escapes the root is refused. Dangling links are refused; not-yet-created
 * files are allowed if some existing ancestor stays inside the real root.
 */
export function confineCursorWorkspacePath(filePath: string, workspacePaths: readonly string[]): string | undefined {
	if (!filePath || workspacePaths.length === 0) return undefined;
	for (const root of workspacePaths) {
		const workspaceRoot = path.resolve(root);
		const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspaceRoot, filePath);
		if (!isLexicallyInside(resolved, workspaceRoot)) continue;
		const realRoot = tryRealpath(workspaceRoot);
		if (!realRoot) continue;
		const realTarget = tryRealpath(resolved);
		if (realTarget) {
			if (isLexicallyInside(realTarget, realRoot)) return resolved;
			continue;
		}
		if (isSymlink(resolved)) continue;
		let ancestor = path.dirname(resolved);
		const tail: string[] = [path.basename(resolved)];
		let ok = false;
		for (;;) {
			const real = tryRealpath(ancestor);
			if (real) {
				ok = isLexicallyInside(path.join(real, ...tail.reverse()), realRoot);
				break;
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor || !isLexicallyInside(ancestor, workspaceRoot)) break;
			tail.push(path.basename(ancestor));
			ancestor = parent;
		}
		if (ok) return resolved;
	}
	return undefined;
}

export function cursorPreviousWorkspaceUris(options?: { cwd?: string; workspacePaths?: string[] }): string[] {
	return resolveCursorWorkspacePaths(options).map(toCursorFileUri);
}

/** Keep a non-empty server checkpoint, but append live roots after `/move`. */
export function mergeCursorPreviousWorkspaceUris(cached: readonly string[], live: readonly string[]): string[] {
	if (cached.length === 0) {
		return [...live];
	}
	const seen = new Set(cached.map(normalizeWorkspaceUri));
	const extra = live.filter(uri => !seen.has(normalizeWorkspaceUri(uri)));
	return extra.length === 0 ? [...cached] : [...cached, ...extra];
}

/**
 * RequestContext so hosted Imagine can resolve a workspace.
 * `env.project_folder` is `~/.cursor/projects/<full-path-slug>/`, not the
 * live root — that is the directory Imagine writes into, and why
 * `remapCursorArtifactPath` exists. `rules` is an argument (often `[]`) so a
 * later rules fill cannot be dropped and workspace paths cannot occupy the
 * rules slot.
 */
export function buildCursorRequestContext(
	requestContextTools: McpToolDefinition[],
	workspacePaths: string[] = [],
	rules: readonly CursorRule[] = [],
): RequestContext {
	const roots = resolveCursorWorkspacePaths({ workspacePaths });
	const projectFolder = roots[0] ? cursorProjectFolder(roots[0]) : "";
	return create(RequestContextSchema, {
		rules: [...rules],
		repositoryInfo: [],
		tools: requestContextTools,
		gitRepos: [],
		projectLayouts: [],
		mcpInstructions: [],
		fileContents: {},
		customSubagents: [],
		env: create(RequestContextEnvSchema, {
			osVersion: `${os.platform()} ${os.release()}`,
			workspacePaths: roots,
			shell: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
			projectFolder,
		}),
		mcpFileSystemOptions: roots[0]
			? create(McpFileSystemOptionsSchema, { workspaceProjectDir: roots[0] })
			: undefined,
	});
}
