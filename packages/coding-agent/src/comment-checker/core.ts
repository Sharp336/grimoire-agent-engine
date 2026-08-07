import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export type CheckerToolName = "Write" | "Edit" | "MultiEdit";

export type CheckerEdit = {
	old_string: string;
	new_string: string;
};

export type CheckerToolInput = {
	file_path: string;
	content?: string;
	old_string?: string;
	new_string?: string;
	edits?: CheckerEdit[];
};

export type CommentCheckRequest = {
	sourceToolName: string;
	toolName: CheckerToolName;
	filePath: string;
	toolInput: CheckerToolInput;
	isDelete?: boolean;
};

export type OmpPerFileEditResult = {
	filePath: string;
	movePath?: string | undefined;
	sourcePath?: string | undefined;
	oldText: string;
	newText: string;
	success: boolean;
};

export type CommentCheckerHookInput = {
	session_id: string;
	tool_name: CheckerToolName;
	transcript_path: string;
	cwd: string;
	hook_event_name: "PostToolUse";
	tool_input: CheckerToolInput;
};

export type ToolResultContent = TextContent | ImageContent;

export type ToolResultLike = {
	toolName: string;
	input: Record<string, unknown>;
	content?: ToolResultContent[];
	isError?: boolean;
	details?: unknown;
};

type ApplyPatchAccumulator = {
	operation: "add" | "delete" | "update";
	filePath: string;
	movePath?: string;
	oldLines: string[];
	newLines: string[];
};

type ApplyPatchFileMetadata = {
	filePath: string;
	movePath?: string;
	before: string;
	after: string;
	type?: string;
};

export function extractFromOmpEditDetails(
	details: unknown,
	input?: Record<string, unknown>,
): Array<OmpPerFileEditResult & { op: "write" | "edit" | "delete" }> {
	if (!isRecord(details)) return [];
	const source = details.perFileResults ?? details.files;
	const results: Array<OmpPerFileEditResult & { op: "write" | "edit" | "delete" }> = [];
	if (Array.isArray(source)) {
		for (const item of source) {
			if (!isRecord(item)) continue;
			if (item.isError === true || item.success === false || item.error !== undefined) continue;
			const typeOp = getString(item, ["type", "op", "operation"]);
			const filePath = getString(item, ["path", "filePath", "file_path"]) ?? "";
			if (typeOp === "delete") {
				if (filePath.length > 0) {
					results.push({
						filePath,
						oldText: "",
						newText: "",
						op: "delete",
						success: true,
					});
				}
				continue;
			}
			const movePath = getString(item, ["move", "movePath", "move_path"]);
			const sourcePath = getString(item, ["sourcePath", "source_path", "preMovePath", "pre_move_path"]);
			let oldText = getString(item, ["oldText", "old_text", "oldString", "old_string", "before", "old"]) ?? "";
			let newText = getString(item, ["newText", "new_text", "newString", "new_string", "after", "new"]) ?? "";

			const isPruned = item.snapshotsPruned === true || details.snapshotsPruned === true;
			const hasSnapshotText =
				hasField(item, ["oldText", "old_text", "oldString", "old_string", "before", "old"]) ||
				hasField(item, ["newText", "new_text", "newString", "new_string", "after", "new"]);

			if (isPruned) {
				if (oldText.length === 0 && input) {
					oldText = getString(input, ["old_string", "oldString", "oldText", "old_text", "before", "old"]) ?? "";
				}
				if (newText.length === 0 && input) {
					newText = getString(input, ["new_string", "newString", "newText", "new_text", "after", "new"]) ?? "";
				}
				if ((oldText.length === 0 || newText.length === 0) && input) {
					const fromEdits = getEditTextsFromInputEdits(input);
					if (fromEdits) {
						if (oldText.length === 0) oldText = fromEdits.oldText;
						if (newText.length === 0) newText = fromEdits.newText;
					}
				}
				if (oldText.length === 0 || newText.length === 0) {
					// Cannot reconstruct text from pruned snapshot — emit a
					// file-path-only request so the checker can read the file
					// from disk itself instead of skipping it entirely.
					if (typeof filePath === "string" && filePath.length > 0) {
						results.push({
							filePath,
							movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
							sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
							oldText: "",
							newText: "",
							op: "write",
							success: true,
						});
					}
					continue;
				}
			} else if (!hasSnapshotText) {
				continue;
			}

			if (typeof filePath !== "string" || filePath.length === 0) continue;
			if (oldText.length > 0 && newText.length === 0) {
				results.push({
					filePath,
					movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
					sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
					oldText,
					newText: "",
					op: "delete",
					success: true,
				});
				continue;
			}
			results.push({
				filePath,
				movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
				sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
				oldText,
				newText,
				op: oldText.length === 0 ? "write" : "edit",
				success: true,
			});
		}
	} else {
		const typeOp = getString(details, ["type", "op", "operation"]);
		const filePath = getString(details, ["path", "filePath", "file_path"]) ?? "";
		if (typeOp === "delete") {
			if (filePath.length > 0) {
				return [
					{
						filePath,
						oldText: "",
						newText: "",
						op: "delete",
						success: true,
					},
				];
			}
			return [];
		}
		if (typeof filePath !== "string" || filePath.length === 0) return [];
		const movePath = getString(details, ["move", "movePath", "move_path"]);
		const sourcePath = getString(details, ["sourcePath", "source_path", "preMovePath", "pre_move_path"]);
		let oldText = getString(details, ["oldText", "old_text", "oldString", "old_string", "before", "old"]) ?? "";
		let newText = getString(details, ["newText", "new_text", "newString", "new_string", "after", "new"]) ?? "";

		const isPruned = details.snapshotsPruned === true;
		const hasSnapshotText =
			hasField(details, ["oldText", "old_text", "oldString", "old_string", "before", "old"]) ||
			hasField(details, ["newText", "new_text", "newString", "new_string", "after", "new"]);

		if (isPruned) {
			if (oldText.length === 0 && input) {
				oldText = getString(input, ["old_string", "oldString", "oldText", "old_text", "before", "old"]) ?? "";
			}
			if (newText.length === 0 && input) {
				newText = getString(input, ["new_string", "newString", "newText", "new_text", "after", "new"]) ?? "";
			}
			if ((oldText.length === 0 || newText.length === 0) && input) {
				const fromEdits = getEditTextsFromInputEdits(input);
				if (fromEdits) {
					if (oldText.length === 0) oldText = fromEdits.oldText;
					if (newText.length === 0) newText = fromEdits.newText;
				}
			}
			if (oldText.length === 0 || newText.length === 0) {
				// Cannot reconstruct text from pruned snapshot — emit a
				// file-path-only request so the checker can read the file
				// from disk itself instead of skipping it entirely.
				return [
					{
						filePath,
						movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
						sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
						oldText: "",
						newText: "",
						op: "write",
						success: true,
					},
				];
			}
		} else if (!hasSnapshotText) {
			return [];
		}

		if (oldText.length > 0 && newText.length === 0) {
			results.push({
				filePath,
				movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
				sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
				oldText,
				newText: "",
				op: "delete",
				success: true,
			});
		} else {
			results.push({
				filePath,
				movePath: typeof movePath === "string" && movePath.length > 0 ? movePath : undefined,
				sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined,
				oldText,
				newText,
				op: oldText.length === 0 ? "write" : "edit",
				success: true,
			});
		}
	}
	return results;
}

function ompEditResultsToCommentCheckRequests(
	sourceToolName: string,
	results: Array<OmpPerFileEditResult & { op: "write" | "edit" | "delete" }>,
): CommentCheckRequest[] {
	const requests: CommentCheckRequest[] = [];
	for (const result of results) {
		const targetPath = result.movePath ?? result.filePath;
		// When a move is detected, emit a delete request for the source path
		// to clear any orphaned warnings from the pre-move file.
		if (result.sourcePath && result.sourcePath !== result.filePath && result.movePath) {
			requests.push({
				sourceToolName,
				toolName: "Edit",
				filePath: result.sourcePath,
				toolInput: { file_path: result.sourcePath },
				isDelete: true,
			});
		}
		if (result.op === "delete") {
			requests.push({
				sourceToolName,
				toolName: "Edit",
				filePath: targetPath,
				toolInput: { file_path: targetPath },
				isDelete: true,
			});
			continue;
		}
		if (result.op === "write") {
			requests.push({
				sourceToolName,
				toolName: "Write",
				filePath: targetPath,
				toolInput: {
					file_path: targetPath,
					content: result.newText,
				},
			});
			continue;
		}
		requests.push({
			sourceToolName,
			toolName: "Edit",
			filePath: targetPath,
			toolInput: {
				file_path: targetPath,
				old_string: result.oldText,
				new_string: result.newText,
			},
		});
	}
	return requests;
}

export function extractCommentCheckRequests(event: ToolResultLike): CommentCheckRequest[] {
	// When details is not a record at all, bail early on errors.
	if (!isRecord(event.details)) {
		if (event.isError) return [];
		if (isToolFailureOutput(getContentText(event.content))) return [];
	}

	// Try extracting from edit details first — even when isError is true,
	// top-level single-file details may contain a successfully applied edit
	// (e.g. partial success where the edit applied but a post-step failed).
	const ompResults = extractFromOmpEditDetails(event.details, event.input);
	const ompRequests = ompEditResultsToCommentCheckRequests(event.toolName, ompResults);
	if (ompRequests.length > 0) return ompRequests;

	if (event.isError) return [];
	if (isToolFailureOutput(getContentText(event.content))) return [];

	const toolName = event.toolName.toLowerCase();
	if (toolName === "write") return extractWriteRequest(event);
	if (toolName === "edit") return extractEditRequest(event);
	if (toolName === "multiedit" || toolName === "multi_edit") return extractMultiEditRequest(event);
	if (toolName === "apply_patch") return extractApplyPatchRequests(event);
	return [];
}

export function toHookInput(
	request: CommentCheckRequest,
	context: {
		sessionId: string;
		cwd: string;
	},
): CommentCheckerHookInput {
	return {
		session_id: context.sessionId,
		tool_name: request.toolName,
		transcript_path: "",
		cwd: context.cwd,
		hook_event_name: "PostToolUse",
		tool_input: request.toolInput,
	};
}

export function isToolFailureOutput(text: string): boolean {
	const lower = text.trim().toLowerCase();
	return (
		lower.startsWith("error") ||
		lower.includes("error:") ||
		lower.includes("failed to") ||
		lower.includes("could not")
	);
}

function extractWriteRequest(event: ToolResultLike): CommentCheckRequest[] {
	const detailPath = isRecord(event.details)
		? getString(event.details, ["resolvedPath", "path", "filePath", "file_path"])
		: undefined;
	const rawPath = getString(event.input, ["filePath", "file_path", "path"]);
	const filePath = detailPath ?? rawPath;
	const content = getString(event.input, ["content"]);
	if (!filePath || content === undefined) return [];
	return [
		{
			sourceToolName: event.toolName,
			toolName: "Write",
			filePath,
			toolInput: {
				file_path: filePath,
				content,
			},
		},
	];
}

function extractEditRequest(event: ToolResultLike): CommentCheckRequest[] {
	const detailPath = isRecord(event.details)
		? getString(event.details, ["resolvedPath", "path", "filePath", "file_path"])
		: undefined;
	const rawPath = getString(event.input, ["filePath", "file_path", "path"]);
	const filePath = detailPath ?? rawPath;
	const oldString = getString(event.input, ["oldString", "old_string"]);
	const newString = getString(event.input, ["newString", "new_string"]);
	if (!filePath || (oldString === undefined && newString === undefined)) return [];
	const toolInput: CheckerToolInput = { file_path: filePath };
	if (oldString !== undefined) toolInput.old_string = oldString;
	if (newString !== undefined) toolInput.new_string = newString;
	return [
		{
			sourceToolName: event.toolName,
			toolName: "Edit",
			filePath,
			toolInput,
		},
	];
}

function extractMultiEditRequest(event: ToolResultLike): CommentCheckRequest[] {
	const detailPath = isRecord(event.details)
		? getString(event.details, ["resolvedPath", "path", "filePath", "file_path"])
		: undefined;
	const rawPath = getString(event.input, ["filePath", "file_path", "path"]);
	const filePath = detailPath ?? rawPath;
	const edits = getEdits(event.input.edits);
	if (!filePath || edits.length === 0) return [];
	return [
		{
			sourceToolName: event.toolName,
			toolName: "MultiEdit",
			filePath,
			toolInput: {
				file_path: filePath,
				edits,
			},
		},
	];
}

function extractApplyPatchRequests(event: ToolResultLike): CommentCheckRequest[] {
	const metadataRequests = extractApplyPatchMetadataRequests(event.details, event.toolName);
	if (metadataRequests.length > 0) return metadataRequests;

	const patch = getString(event.input, ["input", "patch"]);
	if (!patch) return [];
	return parseApplyPatchRequests(patch, event.toolName);
}

function extractApplyPatchMetadataRequests(details: unknown, sourceToolName: string): CommentCheckRequest[] {
	const metadataFiles = getApplyPatchMetadataFiles(details);
	if (metadataFiles.length === 0) return [];

	const requests: CommentCheckRequest[] = [];
	for (const file of metadataFiles) {
		const filePath = file.movePath ?? file.filePath;
		if (file.type === "delete") {
			requests.push({
				sourceToolName,
				toolName: "Edit",
				filePath,
				toolInput: { file_path: filePath },
				isDelete: true,
			});
			continue;
		}
		if (file.before.length === 0) {
			requests.push({
				sourceToolName,
				toolName: "Write",
				filePath,
				toolInput: {
					file_path: filePath,
					content: file.after,
				},
			});
			continue;
		}
		requests.push({
			sourceToolName,
			toolName: "Edit",
			filePath,
			toolInput: {
				file_path: filePath,
				old_string: file.before,
				new_string: file.after,
			},
		});
	}
	return requests;
}

function getApplyPatchMetadataFiles(details: unknown): ApplyPatchFileMetadata[] {
	if (!isRecord(details)) return [];
	const direct = readApplyPatchMetadataFiles(details.files);
	if (direct.length > 0) return direct;
	const resultValue = details.result;
	const result = isRecord(resultValue) ? readApplyPatchMetadataFiles(resultValue.files) : [];
	if (result.length > 0) return result;
	const metadataValue = details.metadata;
	const metadata = isRecord(metadataValue) ? readApplyPatchMetadataFiles(metadataValue.files) : [];
	return metadata;
}

function readApplyPatchMetadataFiles(value: unknown): ApplyPatchFileMetadata[] {
	if (!Array.isArray(value)) return [];
	const files: ApplyPatchFileMetadata[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const filePath = getString(item, ["filePath", "file_path", "path"]);
		const movePath = getString(item, ["movePath", "move_path"]);
		const before = getString(item, ["before", "old", "oldString", "old_string"]) ?? "";
		const after = getString(item, ["after", "new", "newString", "new_string"]) ?? "";
		const type = getString(item, ["type", "operation"]);
		if (!filePath) continue;
		const file: ApplyPatchFileMetadata = { filePath, before, after };
		if (movePath !== undefined) file.movePath = movePath;
		if (type !== undefined) file.type = type;
		files.push(file);
	}
	return files;
}

export function parseApplyPatchRequests(patch: string, sourceToolName = "apply_patch"): CommentCheckRequest[] {
	const requests: CommentCheckRequest[] = [];
	let current: ApplyPatchAccumulator | undefined;

	const flush = (): void => {
		if (!current) return;
		if (current.operation === "delete") {
			requests.push({
				sourceToolName,
				toolName: "Edit",
				filePath: current.filePath,
				toolInput: { file_path: current.filePath },
				isDelete: true,
			});
		}
		if (current.operation === "add") {
			const content = joinPatchLines(current.newLines);
			if (content.length > 0) {
				requests.push({
					sourceToolName,
					toolName: "Write",
					filePath: current.filePath,
					toolInput: {
						file_path: current.filePath,
						content,
					},
				});
			}
		}
		if (current.operation === "update") {
			const newString = joinPatchLines(current.newLines);
			if (newString.length > 0) {
				const filePath = current.movePath ?? current.filePath;
				requests.push({
					sourceToolName,
					toolName: "Edit",
					filePath,
					toolInput: {
						file_path: filePath,
						old_string: joinPatchLines(current.oldLines),
						new_string: newString,
					},
				});
			}
		}
		current = undefined;
	};

	for (const line of patch.split(/\r?\n/)) {
		if (line === "*** Begin Patch" || line === "*** End Patch") continue;
		if (line.startsWith("*** Add File: ")) {
			flush();
			current = makeAccumulator("add", line.slice("*** Add File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			flush();
			current = makeAccumulator("update", line.slice("*** Update File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			flush();
			current = makeAccumulator("delete", line.slice("*** Delete File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Move to: ")) {
			if (current?.operation === "update") current.movePath = line.slice("*** Move to: ".length).trim();
			continue;
		}
		if (!current) continue;
		if (line.startsWith("@@")) continue;
		if (current.operation === "add") {
			if (line.startsWith("+")) current.newLines.push(line.slice(1));
			continue;
		}
		if (current.operation === "update") {
			if (line.startsWith("+")) current.newLines.push(line.slice(1));
			if (line.startsWith("-")) current.oldLines.push(line.slice(1));
		}
	}

	flush();
	return requests;
}

function makeAccumulator(operation: ApplyPatchAccumulator["operation"], filePath: string): ApplyPatchAccumulator {
	return {
		operation,
		filePath,
		oldLines: [],
		newLines: [],
	};
}

function getContentText(content: ToolResultContent[] | undefined): string {
	if (!content) return "";
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function getString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function hasField(input: Record<string, unknown>, keys: string[]): boolean {
	for (const key of keys) {
		const value = input[key];
		if (value !== undefined && value !== null) return true;
	}
	return false;
}

function getEdits(value: unknown): CheckerEdit[] {
	if (!Array.isArray(value)) return [];
	const edits: CheckerEdit[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const oldString = getString(item, ["oldString", "old_string"]);
		const newString = getString(item, ["newString", "new_string"]);
		if (oldString === undefined || newString === undefined) continue;
		edits.push({ old_string: oldString, new_string: newString });
	}
	return edits;
}

function joinPatchLines(lines: string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getEditTextsFromInputEdits(input: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = input.edits;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const oldParts: string[] = [];
	const newParts: string[] = [];
	for (const edit of edits) {
		if (!isRecord(edit)) continue;
		const old = getString(edit, ["old_text", "old_string", "oldText", "oldString"]);
		const next = getString(edit, ["new_text", "new_string", "newText", "newString"]);
		if (old !== undefined) oldParts.push(old);
		if (next !== undefined) newParts.push(next);
	}
	if (oldParts.length === 0 && newParts.length === 0) return undefined;
	return { oldText: oldParts.join("\n"), newText: newParts.join("\n") };
}
