import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyWorkspaceEdit } from "../../src/lsp/edits";
import type { WorkspaceEdit } from "../../src/lsp/types";
import { fileToUri } from "../../src/lsp/utils";

const tmpDirs: string[] = [];

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("applyWorkspaceEdit workspace-root validation", () => {
	it("rejects a CreateFile targeting a path outside the workspace and creates nothing", async () => {
		const cwd = mkTmp();
		const outsidePath = "/etc/omp-test-DOESNOTEXIST";
		const edit: WorkspaceEdit = {
			documentChanges: [{ kind: "create", uri: `file://${outsidePath}` }],
		};
		await expect(applyWorkspaceEdit(edit, cwd)).rejects.toThrow();
		expect(fs.existsSync(outsidePath)).toBe(false);
	});

	it("rejects a RenameFile whose newUri is outside the workspace", async () => {
		const cwd = mkTmp();
		const source = path.join(cwd, "src.ts");
		fs.writeFileSync(source, "x");
		const edit: WorkspaceEdit = {
			documentChanges: [
				{
					kind: "rename",
					oldUri: fileToUri(source),
					newUri: "file:///etc/omp-test-rename-DOESNOTEXIST",
				},
			],
		};
		await expect(applyWorkspaceEdit(edit, cwd)).rejects.toThrow();
		// Source must remain untouched (no partial application / move).
		expect(fs.existsSync(source)).toBe(true);
		expect(fs.existsSync("/etc/omp-test-rename-DOESNOTEXIST")).toBe(false);
	});

	it("rejects a DeleteFile targeting /etc/passwd before any fs op", async () => {
		const cwd = mkTmp();
		const edit: WorkspaceEdit = {
			documentChanges: [{ kind: "delete", uri: "file:///etc/passwd" }],
		};
		await expect(applyWorkspaceEdit(edit, cwd)).rejects.toThrow();
		// The throw must happen before any fs op — /etc/passwd still exists.
		expect(fs.existsSync("/etc/passwd")).toBe(true);
	});

	it("rejects a changes map keyed by an outside URI", async () => {
		const cwd = mkTmp();
		const edit: WorkspaceEdit = {
			changes: {
				"file:///etc/omp-test2": [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" },
				],
			},
		};
		await expect(applyWorkspaceEdit(edit, cwd)).rejects.toThrow();
		expect(fs.existsSync("/etc/omp-test2")).toBe(false);
	});

	it("applies an in-workspace CreateFile successfully", async () => {
		const cwd = mkTmp();
		const target = path.join(cwd, "created.ts");
		const edit: WorkspaceEdit = {
			documentChanges: [{ kind: "create", uri: fileToUri(target) }],
		};
		const applied = await applyWorkspaceEdit(edit, cwd);
		expect(applied.length).toBeGreaterThan(0);
		expect(fs.existsSync(target)).toBe(true);
	});

	it("applies an in-workspace TextDocumentEdit successfully", async () => {
		const cwd = mkTmp();
		const target = path.join(cwd, "edit.ts");
		fs.writeFileSync(target, "hello world");
		const edit: WorkspaceEdit = {
			documentChanges: [
				{
					textDocument: { uri: fileToUri(target), version: null },
					edits: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "goodbye",
						},
					],
				},
			],
		};
		await applyWorkspaceEdit(edit, cwd);
		expect(fs.readFileSync(target, "utf8")).toBe("goodbye world");
	});
});

const _ = [afterAll, describe, expect, it];
