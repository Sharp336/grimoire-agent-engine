import type { DiffHunk, FileDiff, FileHunks, NumstatEntry } from "../../commit/types";

export function parseNumstat(output: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [addedRaw, deletedRaw, pathRaw] = parts;
		const additions = Number.parseInt(addedRaw, 10);
		const deletions = Number.parseInt(deletedRaw, 10);
		const path = extractPathFromRename(pathRaw);
		entries.push({
			path,
			additions: Number.isNaN(additions) ? 0 : additions,
			deletions: Number.isNaN(deletions) ? 0 : deletions,
		});
	}
	return entries;
}

// Matches both the common unquoted header (`diff --git a/PATH b/PATH`) and
// the C-quoted form Git falls back to for paths containing a literal quote,
// backslash, tab, or newline (`diff --git "a/PATH" "b/PATH"`, with those
// bytes backslash- or octal-escaped) regardless of `core.quotepath`.
const DIFF_HEADER_RE = /^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/;

/**
 * Decode a Git C-quoted path (`"foo\tbar"`) back to its literal text. Only
 * `\NNN` octal escapes represent raw bytes needing UTF-8 reassembly (Git
 * emits them for non-ASCII bytes when `core.quotepath` is left at its
 * default, or the odd byte forcing quoting isn't valid ASCII); everything
 * else in the quoted string is already a correctly-decoded JS character
 * (including multi-byte UTF-8 text left unescaped under
 * `core.quotepath=false`) and must be copied through as-is rather than
 * reinterpreted one UTF-16 code unit at a time as a single byte, which
 * would corrupt any non-ASCII character outside an octal run.
 */
function unquoteGitPath(quoted: string): string {
	const inner = quoted.slice(1, -1);
	let result = "";
	let octalRun: number[] = [];
	const flushOctal = () => {
		if (octalRun.length > 0) {
			result += Buffer.from(octalRun).toString("utf8");
			octalRun = [];
		}
	};
	for (let i = 0; i < inner.length; i += 1) {
		if (inner[i] !== "\\") {
			flushOctal();
			result += inner[i];
			continue;
		}
		const next = inner[i + 1];
		if (next === "n") {
			flushOctal();
			result += "\n";
			i += 1;
		} else if (next === "t") {
			flushOctal();
			result += "\t";
			i += 1;
		} else if (next === "r") {
			flushOctal();
			result += "\r";
			i += 1;
		} else if (next === '"') {
			flushOctal();
			result += '"';
			i += 1;
		} else if (next === "\\") {
			flushOctal();
			result += "\\";
			i += 1;
		} else if (next >= "0" && next <= "7") {
			octalRun.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
			i += 3;
		} else {
			flushOctal();
			result += "\\";
		}
	}
	flushOctal();
	return result;
}

export function parseFileDiffs(diff: string): FileDiff[] {
	const sections: FileDiff[] = [];
	const parts = diff.split("\ndiff --git ");
	for (let index = 0; index < parts.length; index += 1) {
		const part = index === 0 ? parts[index] : `diff --git ${parts[index]}`;
		if (!part.trim()) continue;
		const lines = part.split("\n");
		const header = lines[0] ?? "";
		const match = header.match(DIFF_HEADER_RE);
		if (!match) continue;
		const filename = match[3] !== undefined ? unquoteGitPath(`"${match[3]}"`) : (match[4] ?? "");
		const content = part;
		const isBinary = lines.some(line => line.startsWith("Binary files "));
		let additions = 0;
		let deletions = 0;
		for (const line of lines) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+")) additions += 1;
			else if (line.startsWith("-")) deletions += 1;
		}
		sections.push({
			filename,
			content,
			additions,
			deletions,
			isBinary,
		});
	}
	return sections;
}

export function parseDiffHunks(diff: string): FileHunks[] {
	const files = parseFileDiffs(diff);
	return files.map(file => parseFileHunks(file));
}

export function parseFileHunks(fileDiff: FileDiff): FileHunks {
	if (fileDiff.isBinary) {
		return { filename: fileDiff.filename, isBinary: true, hunks: [] };
	}

	const lines = fileDiff.content.split("\n");
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let buffer: string[] = [];
	let index = 0;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (current) {
				current.content = buffer.join("\n");
				hunks.push(current);
			}
			const headerData = parseHunkHeader(line);
			current = {
				index,
				header: line,
				oldStart: headerData.oldStart,
				oldLines: headerData.oldLines,
				newStart: headerData.newStart,
				newLines: headerData.newLines,
				content: "",
			};
			buffer = [line];
			index += 1;
			continue;
		}
		if (current) {
			buffer.push(line);
		}
	}

	if (current) {
		current.content = buffer.join("\n");
		hunks.push(current);
	}

	return {
		filename: fileDiff.filename,
		isBinary: fileDiff.isBinary,
		hunks,
	};
}

function extractPathFromRename(pathPart: string): string {
	const braceStart = pathPart.indexOf("{");
	if (braceStart !== -1) {
		const arrowPos = pathPart.indexOf(" => ", braceStart);
		if (arrowPos !== -1) {
			const braceEnd = pathPart.indexOf("}", arrowPos);
			if (braceEnd !== -1) {
				const prefix = pathPart.slice(0, braceStart);
				const newName = pathPart.slice(arrowPos + 4, braceEnd).trim();
				return `${prefix}${newName}`;
			}
		}
	}

	if (pathPart.includes(" => ")) {
		const parts = pathPart.split(" => ");
		return parts[1]?.trim() ?? pathPart.trim();
	}

	return pathPart.trim();
}

function parseHunkHeader(line: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
} {
	const match = line.match(/@@\s-([0-9]+)(?:,([0-9]+))?\s\+([0-9]+)(?:,([0-9]+))?\s@@/);
	if (!match) {
		return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
	}
	const oldStart = Number.parseInt(match[1] ?? "0", 10);
	const oldLines = Number.parseInt(match[2] ?? "1", 10);
	const newStart = Number.parseInt(match[3] ?? "0", 10);
	const newLines = Number.parseInt(match[4] ?? "1", 10);
	return {
		oldStart: Number.isNaN(oldStart) ? 0 : oldStart,
		oldLines: Number.isNaN(oldLines) ? 0 : oldLines,
		newStart: Number.isNaN(newStart) ? 0 : newStart,
		newLines: Number.isNaN(newLines) ? 0 : newLines,
	};
}
