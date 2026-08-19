import * as os from "node:os";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import type { McpToolDefinition, RequestContext } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	McpFileSystemOptionsSchema,
	RequestContextEnvSchema,
	RequestContextSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

/** Absolute workspace roots Cursor needs to resolve generated-file writes. */
export function resolveCursorWorkspacePaths(options?: { cwd?: string; workspacePaths?: string[] }): string[] {
	const explicit = (options?.workspacePaths ?? []).map(entry => entry.trim()).filter(Boolean);
	const resolved = (explicit.length > 0 ? explicit : [options?.cwd?.trim() || process.cwd()]).map(entry =>
		path.resolve(entry),
	);
	return [...new Set(resolved)];
}

/** Cursor workspace URIs are `file://` paths, not OS paths. */
export function toCursorFileUri(fsPath: string): string {
	const normalized = path.resolve(fsPath).replaceAll("\\", "/");
	return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

export function cursorProjectFolder(workspaceRoot: string): string {
	const slug = path.basename(workspaceRoot).replace(/[^\w.-]+/g, "_") || "workspace";
	return path.join(os.homedir(), ".cursor", "projects", slug);
}

export function cursorPreviousWorkspaceUris(options?: { cwd?: string; workspacePaths?: string[] }): string[] {
	return resolveCursorWorkspacePaths(options).map(toCursorFileUri);
}

/** Fields Cursor needs so hosted image gen can resolve a workspace folder. */
export function buildCursorRequestContext(
	requestContextTools: McpToolDefinition[],
	workspacePaths: string[] = [],
): RequestContext {
	const roots = workspacePaths.length > 0 ? workspacePaths : resolveCursorWorkspacePaths();
	const projectFolder = roots[0] ? cursorProjectFolder(roots[0]) : "";
	return create(RequestContextSchema, {
		rules: [],
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
