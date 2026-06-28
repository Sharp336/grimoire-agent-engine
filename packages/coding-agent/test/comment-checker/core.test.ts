import { describe, expect, it } from "bun:test";
import {
	extractCommentCheckRequests,
	extractFromOmpEditDetails,
	isToolFailureOutput,
	type ToolResultLike,
	toHookInput,
} from "../../src/comment-checker/core";

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

	it("extracts per-file results from omp edit details", () => {
		const details = {
			perFileResults: [
				{
					filePath: "src/a.ts",
					newText: "const a = 1;\n",
					success: true,
				},
				{
					filePath: "src/b.ts",
					oldText: "const b = 1;\n",
					newText: "const b = 2;\n",
					success: true,
				},
				{
					filePath: "src/c.ts",
					oldText: "const c = 1;\n",
					newText: "const c = 2;\n",
					success: false,
				},
			],
		};

		const results = extractFromOmpEditDetails(details);

		expect(results).toEqual([
			{ filePath: "src/a.ts", oldText: "", newText: "const a = 1;\n", success: true, op: "write" },
			{ filePath: "src/b.ts", oldText: "const b = 1;\n", newText: "const b = 2;\n", success: true, op: "edit" },
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
