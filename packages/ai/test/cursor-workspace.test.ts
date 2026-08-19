import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CursorRuleSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import {
	buildCursorRequestContext,
	cursorPreviousWorkspaceUris,
	cursorProjectFolder,
	cursorProjectSlug,
	mergeCursorPreviousWorkspaceUris,
	remapCursorArtifactPath,
	resolveCursorWorkspacePaths,
	toCursorFileUri,
} from "../src/providers/cursor/workspace.ts";

describe("cursor workspace helpers", () => {
	it("prefers explicit workspacePaths over cwd", () => {
		const root = path.resolve("/tmp/omp-workspace-a");
		expect(resolveCursorWorkspacePaths({ cwd: "/elsewhere", workspacePaths: [root] })).toEqual([root]);
	});

	it("resolves relative workspacePaths against cwd, not process.cwd()", () => {
		const cwd = path.resolve("/tmp/omp-session-root");
		expect(resolveCursorWorkspacePaths({ cwd, workspacePaths: ["assets"] })).toEqual([path.resolve(cwd, "assets")]);
	});

	it("falls back to cwd when workspacePaths is empty or blank", () => {
		const cwd = path.resolve("/tmp/omp-workspace-fallback");
		expect(resolveCursorWorkspacePaths({ cwd, workspacePaths: [] })).toEqual([cwd]);
		expect(resolveCursorWorkspacePaths({ cwd, workspacePaths: ["", "  "] })).toEqual([cwd]);
	});

	it("builds a file URI for the workspace root", () => {
		const root = path.resolve("/tmp/omp-workspace-b");
		const uri = toCursorFileUri(root);
		expect(uri.startsWith("file://")).toBe(true);
		expect(uri.includes("omp-workspace-b")).toBe(true);
	});

	it("percent-encodes spaces in workspace URIs", () => {
		const root = path.join(path.resolve("/tmp"), "omp space");
		const uri = toCursorFileUri(root);
		expect(uri.startsWith("file://")).toBe(true);
		expect(uri).not.toContain(" ");
		expect(decodeURIComponent(uri)).toContain("omp space");
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
		expect(ctx.env?.projectFolder).toBe(cursorProjectFolder(workspace));
		expect(path.basename(ctx.env?.projectFolder ?? "")).not.toBe(path.basename(workspace));
		expect(ctx.rules).toEqual([]);
	});

	it("round-trips requestContext.rules so a parallel rules fill is not wiped", () => {
		const workspace = path.resolve("/tmp/omp-cursor-rules-root");
		const ctx = buildCursorRequestContext([], [workspace], [
			create(CursorRuleSchema, { fullPath: "/omp/system-prompt/0.mdc", content: "PIKEL-CANARY-7F3A" }),
		]);
		expect(ctx.rules).toHaveLength(1);
		expect(ctx.rules[0]?.content).toBe("PIKEL-CANARY-7F3A");
		expect(ctx.env?.workspacePaths).toEqual([workspace]);
	});

	it("slugs project_folder from the full path, matching Cursor CLI", () => {
		const workspace = path.resolve("/tmp/omp-cursor-image-root");
		const slug = cursorProjectSlug(workspace);
		expect(slug).not.toBe(path.basename(workspace));
		expect(slug.includes("omp-cursor-image-root")).toBe(true);
		if (process.platform === "win32") {
			expect(cursorProjectSlug("C:\\Users\\dylan\\.dev\\ATHENA")).toBe("c-Users-dylan-dev-ATHENA");
		} else {
			expect(cursorProjectSlug("/home/user/git/agentera")).toBe("home-user-git-agentera");
		}
		expect(cursorProjectFolder(workspace).startsWith(path.join(os.homedir(), ".cursor", "projects"))).toBe(true);
	});

	it("remaps Imagine paths under ~/.cursor/projects/<slug> onto the workspace root", () => {
		const workspace = path.resolve("/tmp/omp-cursor-image-root");
		const artifact = path.join(cursorProjectFolder(workspace), "assets", "cat.png");
		expect(remapCursorArtifactPath(artifact, [workspace])).toBe(path.join(workspace, "assets", "cat.png"));
		expect(remapCursorArtifactPath(path.join(workspace, "assets", "cat.png"), [workspace])).toBe(
			path.join(workspace, "assets", "cat.png"),
		);
	});

	it("appends live workspace URIs after a cwd change without dropping the checkpoint", () => {
		const cached = ["file:///old"];
		const live = ["file:///new"];
		expect(mergeCursorPreviousWorkspaceUris(cached, live)).toEqual(["file:///old", "file:///new"]);
		expect(mergeCursorPreviousWorkspaceUris([], live)).toEqual(live);
		expect(mergeCursorPreviousWorkspaceUris(cached, cached)).toEqual(cached);
	});
});
