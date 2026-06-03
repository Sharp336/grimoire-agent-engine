/**
 * @file Reference Resolution for Context Files
 *
 * Resolves `@relative/path.ext` references found in context file content
 * (CLAUDE.md, AGENTS.md, etc.) by inlining the referenced file's content
 * at the point of reference.
 *
 * Pattern: a line that is exactly `@path/to/file.ext` (must contain a `.`)
 * — resolved relative to the context file's directory.
 * — recursive with depth limit and cycle detection.
 *
 * See: https://github.com/can1357/oh-my-pi/issues/375
 */

import * as path from "node:path";
import { readFile } from "./fs";

export interface ResolveAtRefsOptions {
	/** Maximum recursion depth for nested @-references (default: 5) */
	maxDepth?: number;
}

/**
 * Matches a line that is *exactly* an @-reference:
 *   - Must start with `@`
 *   - Must contain at least one `.` (to distinguish from mentions/emails)
 *   - Must not contain whitespace (paths don't have spaces)
 *   - Allows letters, digits, `-`, `_`, `.`, `/`
 *   - Must be on its own line (leading/trailing whitespace is stripped)
 *
 * Examples that match:
 *   @package.json
 *   @pyproject.toml
 *   @../configs/rules.md
 *   @src/types.ts
 *
 * Examples that don't match:
 *   @username (no extension)
 *   email@example.com (@ is not at start of segment)
 *   See @foo for details (not on its own line)
 */
const AT_REF_PATTERN = /^@([\w.\-/]+\.[\w.-]+)\s*$/;

async function resolveContent(
	content: string,
	filePath: string,
	seen: Set<string>,
	depth: number,
	maxDepth: number,
): Promise<string> {
	if (depth >= maxDepth) return content;

	const baseDir = path.dirname(filePath);
	const lines = content.split("\n");
	const resolved: string[] = [];

	for (const line of lines) {
		const match = AT_REF_PATTERN.exec(line);
		if (!match) {
			resolved.push(line);
			continue;
		}

		const refPath = match[1];
		const absRefPath = path.resolve(baseDir, refPath);

		// Cycle detection
		if (seen.has(absRefPath)) {
			resolved.push(`<!-- @${refPath}: circular reference skipped -->`);
			continue;
		}

		const refContent = await readFile(absRefPath);
		if (refContent === null) {
			resolved.push(`<!-- @${refPath}: file not found -->`);
			continue;
		}

		// Recursively resolve references in the included file
		seen.add(absRefPath);
		const innerResolved = await resolveContent(refContent, absRefPath, seen, depth + 1, maxDepth);
		seen.delete(absRefPath);

		resolved.push(innerResolved);
	}

	return resolved.join("\n");
}

/**
 * Resolve @-file references in an array of context files.
 *
 * For each context file, scans its content for lines matching `@relative/path.ext`
 * and replaces them with the referenced file's content. References are resolved
 * relative to the context file's own directory. Recursion is bounded by
 * `maxDepth` and cycles are detected.
 *
 * Files that cannot be read produce a comment placeholder instead of crashing.
 */
export async function resolveAtRefs(
	files: Array<{ path: string; content: string; depth?: number }>,
	options: ResolveAtRefsOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const maxDepth = options.maxDepth ?? 5;
	const resolved: Array<{ path: string; content: string; depth?: number }> = [];

	for (const file of files) {
		const seen = new Set<string>([path.resolve(file.path)]);
		const newContent = await resolveContent(file.content, file.path, seen, 0, maxDepth);
		resolved.push({
			path: file.path,
			content: newContent,
			depth: file.depth,
		});
	}

	return resolved;
}
