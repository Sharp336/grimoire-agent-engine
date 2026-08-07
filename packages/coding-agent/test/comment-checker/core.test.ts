import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as cli from "../../src/comment-checker/cli";
import { runCommentChecker, spawnProcess } from "../../src/comment-checker/cli";
import {
	extractCommentCheckRequests,
	extractFromOmpEditDetails,
	isToolFailureOutput,
	type ToolResultLike,
	toHookInput,
} from "../../src/comment-checker/core";
import { createCommentCheckerExtension, createCommentCheckerToolResultHandler } from "../../src/comment-checker/index";
import { formatFooterStatus, formatPreview, getCommentCheckerWidgetLines } from "../../src/comment-checker/ui";
import { Settings } from "../../src/config/settings";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolResultEvent,
} from "../../src/extensibility/extensions";
import type { ExtensionUIContext, SessionStartEvent } from "../../src/extensibility/extensions/types";
import type { ReadonlySessionManager } from "../../src/session/session-manager";

type MockExtensionApi = Pick<ExtensionAPI, "on" | "registerCommand" | "sendMessage" | "appendEntry">;

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
			{
				sourceToolName: "apply_patch",
				toolName: "Edit",
				filePath: "src/deleted.ts",
				toolInput: {
					file_path: "src/deleted.ts",
				},
				isDelete: true,
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
			{
				sourceToolName: "apply_patch",
				toolName: "Edit",
				filePath: "src/deleted.ts",
				toolInput: {
					file_path: "src/deleted.ts",
				},
				isDelete: true,
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

	it("suppresses failed multi-entry edit details and does not re-read from disk", () => {
		using tempDir = TempDir.createSync("@omp-comment-checker-test-");
		const filePath = path.join(tempDir.path(), "existing.ts");
		fs.writeFileSync(filePath, "// TODO: pre-existing comment\nconst a = 1;\n", "utf-8");

		const event: ToolResultLike = {
			toolName: "edit",
			input: {
				file_path: filePath,
			},
			details: {
				diff: "",
				path: filePath,
			},
			content: [{ type: "text", text: `Error editing ${filePath} (entry 1 of 2): Failed to match old_string` }],
			isError: true,
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

	it("skips file when per-file result has snapshotsPruned and deltas cannot be reconstructed from input", () => {
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
		]);
	});

	it("reconstructs edit delta from input when snapshots are pruned and both old and new text exist in input", () => {
		const details = {
			perFileResults: [
				{
					path: "src/pruned.ts",
					snapshotsPruned: true,
				},
			],
		};
		const input = {
			old_string: "const a = 1;",
			new_string: "const a = 2;",
		};

		const results = extractFromOmpEditDetails(details, input);

		expect(results).toEqual([
			{
				filePath: "src/pruned.ts",
				movePath: undefined,
				oldText: "const a = 1;",
				newText: "const a = 2;",
				op: "edit",
				success: true,
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

	it("reconstructs edit deltas from input.edits array when snapshots are pruned in replace mode", () => {
		const event: ToolResultLike = {
			toolName: "edit",
			input: {
				path: "src/replace_example.ts",
				edits: [{ old_text: "// old comment\nconst a = 1;", new_text: "// new comment\nconst a = 1;" }],
			},
			details: {
				snapshotsPruned: true,
				perFileResults: [
					{
						path: "src/replace_example.ts",
						snapshotsPruned: true,
					},
				],
			},
			content: [{ type: "text", text: "edited src/replace_example.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "edit",
				toolName: "Edit",
				filePath: "src/replace_example.ts",
				toolInput: {
					file_path: "src/replace_example.ts",
					old_string: "// old comment\nconst a = 1;",
					new_string: "// new comment\nconst a = 1;",
				},
			},
		]);
	});

	it("skips pruned snapshots without deltas instead of re-reading from disk and emitting whole-file scan", () => {
		using tempDir = TempDir.createSync("@omp-comment-checker-test-");
		const filePath = path.join(tempDir.path(), "pruned.ts");
		fs.writeFileSync(filePath, "const diskValue = 42;\n", "utf-8");

		const details = {
			perFileResults: [
				{
					path: filePath,
					snapshotsPruned: true,
				},
			],
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([]);
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
			text: "⚠ comment-checker: 1 warning(s) in /root/src/foo.ts",
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
		expect(clearedFiles).toEqual([["/root/src/foo.ts"], ["/root/src/foo.ts"]]);
	});

	it("preserves isError=true when warnings are appended to a failed tool result", async () => {
		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: () => {},
			setWidget: () => {},
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
		});

		const event: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_1",
			toolName: "edit",
			input: {},
			details: {
				perFileResults: [
					{
						path: "src/foo.ts",
						oldText: "const x = 1;\n",
						newText: "// TODO fix\nconst x = 1;\n",
					},
					{
						path: "src/failed.ts",
						isError: true,
					},
				],
			},
			content: [{ type: "text", text: "partial failure" }],
			isError: true,
		};

		const result = await handler(event, mockCtx);

		expect(result).toBeDefined();
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([
			{ type: "text", text: "partial failure" },
			{ type: "text", text: "\n\nAvoid vague comments" },
		]);
	});

	it("normalizes relative and absolute file paths so edit rechecks clear warnings recorded from write", async () => {
		let recordedWarning: { filePath: string; message: string; sourceToolName: string } | undefined;
		let clearedFiles: string[] = [];

		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: () => {},
			setWidget: () => {},
		} as unknown as ExtensionUIContext;

		const mockCtx: ExtensionContext = {
			sessionManager: mockSessionManager,
			cwd: "/workspace",
			ui: mockUI,
		} as unknown as ExtensionContext;

		const writeHandler = createCommentCheckerToolResultHandler({
			run: async () => ({
				status: "warning",
				message: "Avoid vague comments",
			}),
			onWarning: warning => {
				recordedWarning = warning;
			},
			onClearWarnings: cleanFiles => {
				clearedFiles = cleanFiles;
			},
		});

		const writeEvent: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_1",
			toolName: "write",
			input: { filePath: "src/foo.ts", content: "// TODO fix" },
			content: [{ type: "text", text: "wrote src/foo.ts" }],
			isError: false,
			details: undefined,
		};

		await writeHandler(writeEvent, mockCtx);
		expect(recordedWarning?.filePath).toBe("/workspace/src/foo.ts");
		expect(clearedFiles).toEqual(["/workspace/src/foo.ts"]);

		const editHandler = createCommentCheckerToolResultHandler({
			run: async () => ({
				status: "pass",
				message: "",
			}),
			onClearWarnings: cleanFiles => {
				clearedFiles = cleanFiles;
			},
		});

		const editEvent: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_2",
			toolName: "edit",
			input: { path: "/workspace/src/foo.ts", old_string: "// TODO fix", new_string: "const x = 1;" },
			content: [{ type: "text", text: "edited" }],
			isError: false,
			details: { path: "/workspace/src/foo.ts" },
		};

		await editHandler(editEvent, mockCtx);
		expect(clearedFiles).toEqual(["/workspace/src/foo.ts"]);
	});

	it("clears warnings when a file deletion event occurs", async () => {
		let clearedFiles: string[] = [];

		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: () => {},
			setWidget: () => {},
		} as unknown as ExtensionUIContext;

		const mockCtx: ExtensionContext = {
			sessionManager: mockSessionManager,
			cwd: "/workspace",
			ui: mockUI,
		} as unknown as ExtensionContext;

		const handler = createCommentCheckerToolResultHandler({
			onClearWarnings: cleanFiles => {
				clearedFiles = cleanFiles;
			},
		});

		const deleteEvent: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_del",
			toolName: "apply_patch",
			input: { input: "*** Begin Patch\n*** Delete File: src/deleted.ts\n*** End Patch" },
			content: [{ type: "text", text: "deleted src/deleted.ts" }],
			isError: false,
			details: undefined,
		};

		await handler(deleteEvent, mockCtx);
		expect(clearedFiles).toEqual(["/workspace/src/deleted.ts"]);
	});

	it("clears warnings when an edit empties a file", async () => {
		let clearedFiles: string[] = [];

		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: () => {},
			setWidget: () => {},
		} as unknown as ExtensionUIContext;

		const mockCtx: ExtensionContext = {
			sessionManager: mockSessionManager,
			cwd: "/workspace",
			ui: mockUI,
		} as unknown as ExtensionContext;

		const handler = createCommentCheckerToolResultHandler({
			onClearWarnings: cleanFiles => {
				clearedFiles = cleanFiles;
			},
		});

		const emptyFileEvent: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_empty",
			toolName: "edit",
			input: {},
			details: {
				perFileResults: [
					{
						path: "src/emptied.ts",
						oldText: "// TODO: old comment\nconst x = 1;\n",
						newText: "",
					},
				],
			},
			content: [{ type: "text", text: "emptied src/emptied.ts" }],
			isError: false,
		};

		await handler(emptyFileEvent, mockCtx);
		expect(clearedFiles).toEqual(["/workspace/src/emptied.ts"]);
	});

	it("notifies UI when runner returns status=error", async () => {
		const notifications: Array<{ message: string; type?: string }> = [];

		const mockSessionManager = {
			getSessionId: () => "sess-1",
			getHeader: () => null,
		} as unknown as ReadonlySessionManager;

		const mockUI = {
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
		} as unknown as ExtensionUIContext;

		const mockCtx: ExtensionContext = {
			sessionManager: mockSessionManager,
			cwd: "/workspace",
			ui: mockUI,
		} as unknown as ExtensionContext;

		const handler = createCommentCheckerToolResultHandler({
			run: async () => ({
				status: "error",
				message: "process crashed\twith\nexit code 1",
			}),
		});

		const event: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "call_err",
			toolName: "write",
			input: { filePath: "src/foo.ts", content: "const x = 1;" },
			content: [{ type: "text", text: "wrote src/foo.ts" }],
			isError: false,
			details: undefined,
		};

		await handler(event, mockCtx);
		expect(notifications).toEqual([
			{ message: "omp-comment-checker error: process crashed with exit code 1", type: "error" },
		]);
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

describe("formatPreview and getCommentCheckerWidgetLines", () => {
	it("collapses multi-line warning messages into a single preview line", () => {
		const multiLineMessage = "Avoid vague comments.\n  - Line 1\n  - Line 2";
		const preview = formatPreview(multiLineMessage);
		expect(preview).not.toContain("\n");
		expect(preview).toBe("Avoid vague comments. - Line 1 - Line 2");

		const lines = getCommentCheckerWidgetLines({
			status: "warning",
			checkedFiles: ["src/foo.ts"],
			warnings: [{ filePath: "src/foo.ts", message: multiLineMessage }],
		});

		expect(lines).toBeDefined();
		expect(lines?.length).toBe(3);
		expect(lines?.[2]).toContain("Avoid vague comments. - Line 1 - Line 2");
	});

	it("renders error and missing states in widget lines and footer status", () => {
		const errorState = {
			status: "error" as const,
			checkedFiles: [],
			warnings: [],
			errorMessage: "process crashed",
		};
		const missingState = {
			status: "missing" as const,
			checkedFiles: [],
			warnings: [],
		};

		const errorWidget = getCommentCheckerWidgetLines(errorState);
		expect(errorWidget).toEqual(["✖ omp-comment-checker error", "  process crashed"]);

		const missingWidget = getCommentCheckerWidgetLines(missingState);
		expect(missingWidget).toEqual([
			"✖ omp-comment-checker missing binary",
			"  Install @code-yeongyu/comment-checker",
		]);

		expect(formatFooterStatus(errorState)).toBe("✖ comment-checker error: process crashed");
		expect(formatFooterStatus(missingState)).toBe("comment-checker: missing binary");
	});
});

describe("extractWriteRequest with resolved detail path", () => {
	it("prefers resolved detail path over raw input path for write requests", () => {
		const event: ToolResultLike = {
			toolName: "write",
			input: {
				filePath: "[src/foo.ts#ABCD]",
				content: "const x = 1;\n",
			},
			details: {
				resolvedPath: "src/foo.ts",
			},
			content: [{ type: "text", text: "wrote src/foo.ts" }],
			isError: false,
		};

		const requests = extractCommentCheckRequests(event);

		expect(requests).toEqual([
			{
				sourceToolName: "write",
				toolName: "Write",
				filePath: "src/foo.ts",
				toolInput: {
					file_path: "src/foo.ts",
					content: "const x = 1;\n",
				},
			},
		]);
	});
});

describe("createCommentCheckerExtension disabled state", () => {
	it("clears widget and status when commentChecker is disabled after being active", async () => {
		await Settings.init({ inMemory: true });
		const spyBin = spyOn(cli, "resolveCommentCheckerBinary").mockReturnValue(undefined);
		try {
			const widgetCalls: Array<{ key: string; lines?: string[] }> = [];
			const statusCalls: Array<{ key: string; text?: string }> = [];

			const mockCtx: ExtensionContext = {
				sessionManager: {
					getSessionId: () => "sess-1",
					getHeader: () => null,
					getEntries: () => [],
				} as Pick<ReadonlySessionManager, "getSessionId" | "getHeader" | "getEntries">,
				cwd: "/workspace",
				ui: {
					setWidget: (key: string, lines?: string[]) => {
						widgetCalls.push({ key, lines });
					},
					setStatus: (key: string, text?: string) => {
						statusCalls.push({ key, text });
					},
					notify: () => {},
				} as Pick<ExtensionUIContext, "setWidget" | "setStatus" | "notify">,
			} as ExtensionContext;

			let sessionStartHandler: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
			let toolResultHandler: ((event: ToolResultEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;

			const mockApi: MockExtensionApi = {
				on: ((event: string, handler: ExtensionHandler<never, never>) => {
					if (event === "session_start")
						sessionStartHandler = handler as (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
					if (event === "tool_result")
						toolResultHandler = handler as (event: ToolResultEvent, ctx: ExtensionContext) => Promise<unknown>;
				}) as ExtensionAPI["on"],
				registerCommand: () => {},
				sendMessage: () => {},
				appendEntry: () => {},
			};

			createCommentCheckerExtension(mockApi);

			// Start session with checker enabled, but binary missing to set state to "missing" (non-idle)
			Settings.instance.set("commentChecker.enabled", true);
			await sessionStartHandler!({}, mockCtx);

			expect(statusCalls[statusCalls.length - 1]).toEqual({
				key: "omp-comment-checker",
				text: "comment-checker: missing binary",
			});

			// Now disable the checker and trigger a tool_result event
			Settings.instance.set("commentChecker.enabled", false);
			await toolResultHandler!(
				{
					type: "tool_result",
					toolCallId: "c1",
					toolName: "write",
					input: { filePath: "src/a.ts", content: "x" },
					content: [],
					isError: false,
				},
				mockCtx,
			);

			// Widget and status should be cleared (lines=undefined, text=undefined)
			expect(widgetCalls[widgetCalls.length - 1]).toEqual({
				key: "omp-comment-checker",
				lines: undefined,
			});
			expect(statusCalls[statusCalls.length - 1]).toEqual({
				key: "omp-comment-checker",
				text: undefined,
			});
		} finally {
			spyBin.mockRestore();
		}
	});
});
