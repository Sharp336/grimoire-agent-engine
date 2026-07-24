/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */
import { escapeUnpairedSurrogates, isEnoent } from "@oh-my-pi/pi-utils";
import {
	isNotebookPath,
	type NotebookDocument,
	notebookToEditableText,
	readEditableNotebookText,
	serializeEditedNotebookText,
} from "./notebook";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

/**
 * The one post-boundary representation of a finalized edit. `content` is the
 * exact text a physical UTF-8/structured sink receives; `editContent` is the
 * logical text every diff, `newText`, hash, header, and snapshot derives from
 * (they diverge only for notebooks, where `content` is JSON and `editContent`
 * is virtual cell text). `escapedCodeUnits` counts lone UTF-16 surrogates that
 * were spelled as literal `\\uXXXX` before persistence.
 */
export interface SerializedEditFileText {
	content: string;
	editContent: string;
	escapedCodeUnits: number;
}

/**
 * Prepare plain (non-notebook) file content: escape unpaired surrogates once
 * and reuse that text for both the physical sink and every logical projection.
 */
export function toPersistedEdit(candidate: string): SerializedEditFileText {
	const { text, escapedCodeUnits } = escapeUnpairedSurrogates(candidate);
	return { content: text, editContent: text, escapedCodeUnits };
}

export function formatEscapedCodeUnitsNotice(escapedCodeUnits: number, displayPath: string): string {
	return `Escaped ${escapedCodeUnits} invalid Unicode code unit(s) before writing ${displayPath}.`;
}

/**
 * Destination-aware serialization. The destination extension decides the
 * physical format: non-notebook targets persist the escaped candidate
 * verbatim; notebook targets serialize the escaped virtual text into a JSON
 * document, using the source notebook as a metadata template only when both
 * ends are notebooks (an absent notebook destination falls back to an empty
 * notebook, so plain-to-notebook moves still produce a valid container).
 */
export async function serializeEditFileText(
	sourcePath: string,
	targetPath: string,
	displayPath: string,
	candidate: string,
): Promise<SerializedEditFileText> {
	if (!isNotebookPath(targetPath)) return toPersistedEdit(candidate);
	const { text: editContent, escapedCodeUnits } = escapeUnpairedSurrogates(candidate);
	const templatePath = isNotebookPath(sourcePath) ? sourcePath : targetPath;
	const content = await serializeEditedNotebookText(templatePath, displayPath, editContent);
	const canonicalEditContent = notebookToEditableText(JSON.parse(content) as NotebookDocument);
	return { content, editContent: canonicalEditContent, escapedCodeUnits };
}
