import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type {
	CursorRule,
	McpToolDefinition,
	RequestContext,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	McpFileSystemOptionsSchema,
	RequestContextEnvSchema,
	RequestContextSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

/** Absolute workspace roots Cursor needs to resolve generated-file writes. */
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

/** Cursor workspace URIs are `file://` URLs, not OS paths. */
export function toCursorFileUri(fsPath: string): string {
	return pathToFileURL(path.resolve(fsPath)).href;
}

/** Cursor CLI artifact dir (`~/.cursor/projects/{full-path-slug}/`). Basename-only slugs collide. */
export function cursorProjectFolder(workspaceRoot: string): string {
	return path.join(os.homedir(), ".cursor", "projects", cursorProjectSlug(workspaceRoot));
}

export function cursorProjectSlug(workspaceRoot: string): string {
	const resolved = path.resolve(workspaceRoot);
	const withDrive = resolved.replace(/^([A-Za-z]):/, (_match, letter: string) => letter.toLowerCase());
	return withDrive.replace(/[\\/:.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workspace";
}

export function cursorPreviousWorkspaceUris(options?: { cwd?: string; workspacePaths?: string[] }): string[] {
	return resolveCursorWorkspacePaths(options).map(toCursorFileUri);
}

/** Keep a non-empty server checkpoint, but append live roots after `/move`. */
export function mergeCursorPreviousWorkspaceUris(cached: readonly string[], live: readonly string[]): string[] {
	if (cached.length === 0) {
		return [...live];
	}
	const seen = new Set(cached);
	const extra = live.filter(uri => !seen.has(uri));
	return extra.length === 0 ? [...cached] : [...cached, ...extra];
}

/** Fields Cursor needs so hosted image gen can resolve a workspace folder. */
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
