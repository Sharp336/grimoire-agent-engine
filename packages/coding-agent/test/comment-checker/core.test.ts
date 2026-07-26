import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runCommentChecker, spawnProcess } from "../../src/comment-checker/cli";
import {
	extractCommentCheckRequests,
	extractFromOmpEditDetails,
	isToolFailureOutput,
	type ToolResultLike,
	toHookInput,
} from "../../src/comment-checker/core";
import { createCommentCheckerToolResultHandler } from "../../src/comment-checker/index";
import type { ExtensionContext, ToolResultEvent } from "../../src/extensibility/extensions";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import type { ReadonlySessionManager } from "../../src/session/session-manager";

describe("extractCommentCheckRequests", () => {
	it("maps a write tool result to a Write hook input", () => {
		const event: ToolResultLike = {
			toolName: "write",
			input: {
				filePath: "src/example.ts",
				content: "const value = 1;\n",
			},
			content: [{ type: "text", text: "wrote src/example.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "write",
				toolName: "Write",
				filePath: "src/example.ts",
				toolInput: {
					file_path: "src/example.ts",
					content: "const value = 1;\n",
				},
			},
		]);
	});

	it("maps an edit tool result to an Edit hook input", () => {
		const event: ToolResultLike = {
			toolName: "edit",
			input: {
				path: "src/example.ts",
				old_string: "const value = 1;",
				new_string: "const value = 2;",
			},
			content: [{ type: "text", text: "edited src/example.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "edit",
				toolName: "Edit",
				filePath: "src/example.ts",
				toolInput: {
					file_path: "src/example.ts",
					old_string: "const value = 1;",
					new_string: "const value = 2;",
				},
			},
		]);
	});

	it("maps a multiedit tool result to a MultiEdit hook input", () => {
		const event: ToolResultLike = {
			toolName: "multiedit",
			input: {
				file_path: "src/example.ts",
				edits: [
					{ old_string: "const a = 1;", new_string: "const a = 2;" },
					{ oldString: "const b = 1;", newString: "const b = 2;" },
				],
			},
			content: [{ type: "text", text: "edited src/example.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "multiedit",
				toolName: "MultiEdit",
				filePath: "src/example.ts",
				toolInput: {
					file_path: "src/example.ts",
					edits: [
						{ old_string: "const a = 1;", new_string: "const a = 2;" },
						{ old_string: "const b = 1;", new_string: "const b = 2;" },
					],
				},
			},
		]);
	});

	it("maps apply_patch add and update hunks to checker inputs", () => {
		const patch = `*** Begin Patch
*** Add File: src/added.ts
+// explain value
+const value = 1;
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-const before = 1;
+// explain next value
+const after = 2;
*** Delete File: src/deleted.ts
*** End Patch`;
		const event: ToolResultLike = {
			toolName: "apply_patch",
			input: { input: patch },
			content: [{ type: "text", text: "add: src/added.ts\nupdate: src/old.ts -> src/new.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "apply_patch",
				toolName: "Write",
				filePath: "src/added.ts",
				toolInput: {
					file_path: "src/added.ts",
					content: "// explain value\nconst value = 1;\n",
				},
			},
			{
				sourceToolName: "apply_patch",
				toolName: "Edit",
				filePath: "src/new.ts",
				toolInput: {
					file_path: "src/new.ts",
					old_string: "const before = 1;\n",
					new_string: "// explain next value\nconst after = 2;\n",
				},
			},
		]);
	});

	it("uses full before and after content from apply_patch OMO metadata", () => {
		const event: ToolResultLike = {
			toolName: "apply_patch",
			input: { input: "*** Begin Patch\n*** End Patch" },
			details: {
				files: [
					{
						filePath: "src/added.ts",
						before: "",
						after: "// explain value\nconst value = 1;\n",
						type: "add",
					},
					{
						filePath: "src/old.ts",
						movePath: "src/new.ts",
						before: "const before = 1;\n",
						after: "// explain next value\nconst after = 2;\n",
						type: "update",
					},
					{
						filePath: "src/deleted.ts",
						before: "// old comment\n",
						after: "",
						type: "delete",
					},
				],
			},
			content: [{ type: "text", text: "apply_patch ok" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "apply_patch",
				toolName: "Write",
				filePath: "src/added.ts",
				toolInput: {
					file_path: "src/added.ts",
					content: "// explain value\nconst value = 1;\n",
				},
			},
			{
				sourceToolName: "apply_patch",
				toolName: "Edit",
				filePath: "src/new.ts",
				toolInput: {
					file_path: "src/new.ts",
					old_string: "const before = 1;\n",
					new_string: "// explain next value\nconst after = 2;\n",
				},
			},
		]);
	});

	it("returns no work for a failed tool result", () => {
		const event: ToolResultLike = {
			toolName: "write",
			input: {
				filePath: "src/example.ts",
				content: "const value = 1;\n",
			},
			content: [{ type: "text", text: "Error: failed to write" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([]);
	});

	it("extracts top-level single-file edit details in extractFromOmpEditDetails", () => {
		const details = {
			path: "src/single.ts",
			oldText: "const value = 1;\n",
			newText: "const value = 2;\n",
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([
			{
				filePath: "src/single.ts",
				movePath: undefined,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
				success: true,
				op: "edit",
			},
		]);
	});

	it("handles partial batch errors by returning successful file requests", () => {
		const event: ToolResultLike = {
			toolName: "edit",
			input: {},
			details: {
				perFileResults: [
					{
						path: "src/success.ts",
						oldText: "const a = 1;\n",
						newText: "const a = 2;\n",
					},
					{
						path: "src/failed.ts",
						isError: true,
					},
				],
			},
			content: [{ type: "text", text: "Error editing src/failed.ts" }],
			isError: true,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "edit",
				toolName: "Edit",
				filePath: "src/success.ts",
				toolInput: {
					file_path: "src/success.ts",
					old_string: "const a = 1;\n",
					new_string: "const a = 2;\n",
				},
			},
		]);
	});

	it("extracts per-file results from omp edit details", () => {
		const details = {
			perFileResults: [
				{
					path: "src/a.ts",
					newText: "const a = 1;\n",
				},
				{
					path: "src/b.ts",
					oldText: "const b = 1;\n",
					newText: "const b = 2;\n",
				},
				{
					path: "src/c.ts",
					oldText: "const c = 1;\n",
					newText: "const c = 2;\n",
					isError: true,
				},
				{
					path: "src/d.ts",
					move: "src/d_renamed.ts",
					oldText: "const d = 1;\n",
					newText: "const d = 2;\n",
				},
			],
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([
			{
				filePath: "src/a.ts",
				movePath: undefined,
				oldText: "",
				newText: "const a = 1;\n",
				success: true,
				op: "write",
			},
			{
				filePath: "src/b.ts",
				movePath: undefined,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
				success: true,
				op: "edit",
			},
			{
				filePath: "src/d.ts",
				movePath: "src/d_renamed.ts",
				oldText: "const d = 1;\n",
				newText: "const d = 2;\n",
				success: true,
				op: "edit",
			},
		]);
	});

	it("re-reads or falls back to input when per-file result has snapshotsPruned", () => {
		const details = {
			perFileResults: [
				{
					path: "src/a.ts",
					oldText: "const a = 1;\n",
					newText: "const a = 2;\n",
				},
				{
					path: "src/b.ts",
					snapshotsPruned: true,
				},
			],
		};
		const input = {
			new_string: "const b = 2;\n",
		};

		const results = extractFromOmpEditDetails(details, input);

		expect(results).toEqual([
			{
				filePath: "src/a.ts",
				movePath: undefined,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
				success: true,
				op: "edit",
			},
			{
				filePath: "src/b.ts",
				movePath: undefined,
				oldText: "",
				newText: "const b = 2;\n",
				success: true,
				op: "write",
			},
		]);
	});

	it("does not drop files when top-level snapshotsPruned is true in extractFromOmpEditDetails", () => {
		const details = {
			snapshotsPruned: true,
			perFileResults: [
				{
					path: "src/a.ts",
					oldText: "const a = 1;\n",
					newText: "const a = 2;\n",
				},
			],
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([
			{
				filePath: "src/a.ts",
				movePath: undefined,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
				success: true,
				op: "edit",
			},
		]);
	});

	it("falls back to input when edit details snapshots are pruned", () => {
		const event: ToolResultLike = {
			toolName: "edit",
			input: {
				path: "src/example.ts",
				old_string: "const value = 1;",
				new_string: "const value = 2;",
			},
			details: {
				snapshotsPruned: true,
				perFileResults: [
					{
						path: "src/example.ts",
						snapshotsPruned: true,
					},
				],
			},
			content: [{ type: "text", text: "edited src/example.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "edit",
				toolName: "Edit",
				filePath: "src/example.ts",
				toolInput: {
					file_path: "src/example.ts",
					old_string: "const value = 1;",
					new_string: "const value = 2;",
				},
			},
		]);
	});

	it("re-reads updated content from disk when edit details snapshots are pruned and file exists", () => {
		using tempDir = TempDir.createSync("@omp-comment-checker-test-");
		const filePath = join(tempDir.path(), "pruned.ts");
		writeFileSync(filePath, "const diskValue = 42;\n", "utf-8");

		const details = {
			perFileResults: [
				{
					path: filePath,
					snapshotsPruned: true,
				},
			],
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([
			{
				filePath,
				movePath: undefined,
				oldText: "",
				newText: "const diskValue = 42;\n",
				op: "write",
				success: true,
			},
		]);
	});
});

describe("toHookInput", () => {
	it("includes session id and cwd in the hook input", () => {
		const [request] = extractCommentCheckRequests({
			toolName: "write",
			input: {
				filePath: "src/example.ts",
				content: "const value = 1;\n",
			},
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		if (!request) throw new Error("expected a comment check request");

		const input = toHookInput(request, {
			sessionId: "session-1",
			cwd: "/workspace",
		});

		expect(input).toEqual({
			session_id: "session-1",
			tool_name: "Write",
			transcript_path: "",
			cwd: "/workspace",
			hook_event_name: "PostToolUse",
			tool_input: {
				file_path: "src/example.ts",
				content: "const value = 1;\n",
			},
		});
	});
});

describe("isToolFailureOutput", () => {
	it("identifies failed tool execution text", () => {
		expect(isToolFailureOutput("Could not apply patch")).toBe(true);
	});

	it("does not flag clean tool output", () => {
		expect(isToolFailureOutput("wrote src/example.ts")).toBe(false);
	});
});

describe("createCommentCheckerToolResultHandler UI status update and warning clearing", () => {
	it("updates ctx.ui.setStatus when warnings are found and clears resolved warnings", async () => {
		const setStatusCalls: Array<{ key: string; text?: string }> = [];
		const setWidgetCalls: Array<{ key: string; lines?: string[] }> = [];
		const clearedFiles: string[][] = [];

		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: (key: string, text?: string) => {
				setStatusCalls.push({ key, text });
			},
			setWidget: (key: string, lines?: string[]) => {
				setWidgetCalls.push({ key, lines });
			},
		} as unknown as ExtensionUIContext;

		const mockCtx: ExtensionContext = {
			sessionManager: mockSessionManager,
			cwd: "/root",
			ui: mockUI,
		} as unknown as ExtensionContext;

		const handler = createCommentCheckerToolResultHandler({
			run: async () => ({
				status: "warning",
				message: "Avoid vague comments",
			}),
			onClearWarnings: cleanFiles => {
				clearedFiles.push(cleanFiles);
			},
		});

		const event: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_1",
			toolName: "write",
			input: { filePath: "src/foo.ts", content: "// TODO fix\nconst x = 1;" },
			content: [{ type: "text", text: "wrote src/foo.ts" }],
			isError: false,
			details: undefined,
		};

		const result = await handler(event, mockCtx);

		expect(result).toBeDefined();
		expect(setStatusCalls.length).toBe(1);
		expect(setStatusCalls[0]).toEqual({
			key: "omp-comment-checker",
			text: "⚠ comment-checker: 1 warning(s) in src/foo.ts",
		});

		const cleanHandler = createCommentCheckerToolResultHandler({
			run: async () => ({
				status: "pass",
				message: "",
			}),
			onClearWarnings: cleanFiles => {
				clearedFiles.push(cleanFiles);
			},
		});

		await cleanHandler(event, mockCtx);
		expect(clearedFiles).toEqual([["src/foo.ts"], ["src/foo.ts"]]);
	});
});

describe("runCommentChecker and spawnProcess executor seam", () => {
	it("executes comment checker via controllable executor mock", async () => {
		const result = await runCommentChecker(
			{
				session_id: "test",
				tool_name: "Write",
				transcript_path: "",
				cwd: "/workspace",
				hook_event_name: "PostToolUse",
				tool_input: { file_path: "foo.ts", content: "code" },
			},
			{
				binaryPath: "/bin/comment-checker",
				executor: async (_cmd, _args, _stdin) => ({
					exitCode: 2,
					stdout: "",
					stderr: "comment warning",
				}),
			},
		);

		expect(result.status).toBe("warning");
		expect(result.message).toBe("comment warning");
	});

	it("executes process using spawnProcess helper", async () => {
		const res = await spawnProcess("echo", ["hello"], "");
		expect(res.exitCode).toBe(0);
		expect(res.stdout.trim()).toBe("hello");
	});
});
