/**
 * Persist a hosted `generate_image_tool_call` (conversation-step oneof field 28,
 * not an exec frame). The PNG is `GenerateImageSuccess.image_data` (base64) and
 * `file_path` is often under `env.project_folder` (`~/.cursor/projects/<slug>/`).
 *
 * Ignoring this step leaves a later `writeArgs` whose proto3 `file_text` is `""`
 * and whose `file_bytes` are empty — a successful 0-byte / truncated PNG.
 * Remap the artifact path onto the workspace root first, then confine: remap
 * returns non-artifact paths unchanged (including relative paths), so
 * confinement is what actually refuses escapes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { confineCursorWorkspacePath, remapCursorArtifactPath } from "./cursor/workspace";
import { decodeCursorImageData, isRasterImagePath, MAX_CURSOR_WRITE_BYTES } from "./cursor-pi-args";

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

export function persistGenerateImageResult(
	call: HostedGenerateImageCall | undefined,
	workspacePaths: readonly string[] = [],
): { text: string; isError: boolean; filePath?: string } {
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
	const remapped = remapCursorArtifactPath(requested, workspacePaths);
	if (!isRasterImagePath(remapped)) {
		return { text: `Refused to persist GenerateImage to a non-image path: ${remapped}`, isError: true };
	}
	const filePath = confineCursorWorkspacePath(remapped, workspacePaths);
	if (!filePath) {
		return { text: `Refused to write generated image outside the workspace: ${remapped}`, isError: true };
	}
	const imageData = result.value?.imageData;
	if (!imageData) {
		return { text: "GenerateImage succeeded but image_data was empty", isError: true };
	}
	if (imageData.length > Math.ceil((MAX_CURSOR_WRITE_BYTES * 4) / 3) + 8) {
		return { text: `GenerateImage image_data exceeds ${MAX_CURSOR_WRITE_BYTES} bytes`, isError: true };
	}
	const bytes = decodeCursorImageData(imageData);
	if (!bytes) {
		return { text: "GenerateImage succeeded but image_data was not valid base64", isError: true };
	}
	try {
		writeBytesAtomically(filePath, bytes);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { text: `Failed to save generated image: ${message}`, isError: true };
	}
	return { text: `Saved ${bytes.byteLength} bytes to ${filePath}`, isError: false, filePath };
}

/**
 * Sibling tmp + rename so a crash mid-write cannot truncate an existing PNG.
 * `wx` refuses to clobber a leftover tmp. The tmp is a dest-derived sibling so
 * rename stays on one volume. Unlink in `finally` is best-effort: `wx` can
 * throw before the file exists, and a successful rename already removed it.
 * Windows cannot always rename over an existing dest (`EPERM`/`EEXIST`);
 * delete the dest and retry.
 */
function writeBytesAtomically(filePath: string, bytes: Uint8Array): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp.${process.pid}`;
	try {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* no leftover from a previous killed persist */
		}
		fs.writeFileSync(tmp, bytes, { flag: "wx" });
		try {
			fs.renameSync(tmp, filePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (process.platform === "win32" && (code === "EPERM" || code === "EEXIST")) {
				fs.rmSync(filePath, { force: true });
				fs.renameSync(tmp, filePath);
			} else {
				throw error;
			}
		}
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* renamed away or never created */
		}
	}
}
