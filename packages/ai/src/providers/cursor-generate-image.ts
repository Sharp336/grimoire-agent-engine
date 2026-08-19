/**
 * Persist Cursor hosted GenerateImage results and refuse 0-byte image writes.
 *
 * `generate_image_tool_call` is a conversation-step oneof (field 28), not an
 * exec frame. The server puts the PNG in `GenerateImageSuccess.image_data`
 * (base64) and the destination in `file_path`. Ignoring that step leaves a
 * later `writeArgs` with empty `file_text` / `file_bytes`, which used to
 * create a successful 0-byte file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { type CursorWritePayload, decodeCursorWriteBytes } from "./cursor-pi-args";
import { remapCursorArtifactPath } from "./cursor/workspace";

const RASTER_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif)$/i;

export type HostedGenerateImageCall = {
	args?: { description?: string; filePath?: string };
	result?: {
		result?: {
			case?: string;
			value?: { filePath?: string; imageData?: string; error?: string };
		};
	};
};

export function selectGenerateImageCall(
	toolCall: { tool?: { case?: string; value?: HostedGenerateImageCall } } | undefined,
): HostedGenerateImageCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "generateImageToolCall") return oneof.value;
	return undefined;
}

export function emptyImageWriteReason(filePath: string, payload: CursorWritePayload): string | undefined {
	if (payload.mode === "bytes") return undefined;
	if (payload.text.length > 0) return undefined;
	if (!RASTER_IMAGE_EXT.test(filePath)) return undefined;
	return (
		"Refusing to write a 0-byte image. Hosted GenerateImage delivers PNG bytes in " +
		"file_bytes or generate_image.image_data, not empty file_text."
	);
}

export function persistGenerateImageResult(
	call: HostedGenerateImageCall | undefined,
	workspacePaths: readonly string[] = [],
): { text: string; isError: boolean } {
	const result = call?.result?.result;
	if (result?.case === "error") {
		return { text: result.value?.error || "GenerateImage failed", isError: true };
	}
	if (result?.case !== "success") {
		return { text: "GenerateImage completed without a result", isError: true };
	}
	const requested = result.value?.filePath || call?.args?.filePath;
	if (!requested) {
		return { text: "GenerateImage succeeded but file_path was empty", isError: true };
	}
	const filePath = remapCursorArtifactPath(requested, workspacePaths);
	if (!pathInsideWorkspace(filePath, workspacePaths)) {
		return { text: `Refused to write generated image outside the workspace: ${filePath}`, isError: true };
	}
	const bytes = decodeCursorWriteBytes(result.value?.imageData);
	if (!bytes) {
		return { text: "GenerateImage succeeded but image_data was empty", isError: true };
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, bytes);
	return { text: `Saved ${bytes.byteLength} bytes to ${filePath}`, isError: false };
}

function pathInsideWorkspace(filePath: string, workspacePaths: readonly string[]): boolean {
	if (workspacePaths.length === 0) return false;
	const resolved = normalizeFsPath(filePath);
	return workspacePaths.some(root => {
		const workspaceRoot = normalizeFsPath(root);
		return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep);
	});
}

function normalizeFsPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
