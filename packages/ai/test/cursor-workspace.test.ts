import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	buildCursorRequestContext,
	cursorPreviousWorkspaceUris,
	resolveCursorWorkspacePaths,
	toCursorFileUri,
} from "../src/providers/cursor/workspace.ts";

describe("cursor workspace helpers", () => {
	it("prefers explicit workspacePaths over cwd", () => {
		const root = path.resolve("/tmp/omp-workspace-a");
		expect(resolveCursorWorkspacePaths({ cwd: "/elsewhere", workspacePaths: [root] })).toEqual([root]);
	});

	it("builds a file URI for the workspace root", () => {
		const root = path.resolve("/tmp/omp-workspace-b");
		const uri = toCursorFileUri(root);
		expect(uri.startsWith("file://")).toBe(true);
		expect(uri.includes("omp-workspace-b")).toBe(true);
	});

	it("seeds previousWorkspaceUris from cwd", () => {
		const cwd = path.resolve("/tmp/omp-workspace-c");
		const uri = toCursorFileUri(cwd);
		expect(cursorPreviousWorkspaceUris({ cwd })).toEqual([uri]);
	});

	it("fills requestContext env.workspace_paths and MCP project dir", () => {
		const workspace = path.resolve("/tmp/omp-cursor-image-root");
		const ctx = buildCursorRequestContext([], [workspace]);
		expect(ctx.env?.workspacePaths).toEqual([workspace]);
		expect(ctx.mcpFileSystemOptions?.workspaceProjectDir).toBe(workspace);
		expect(ctx.env?.projectFolder).toContain(".cursor");
	});
});
