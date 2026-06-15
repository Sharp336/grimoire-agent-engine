import * as path from "node:path";

/**
 * Validate that a relative path is safe (no traversal, no absolute paths).
 *
 * Leaf utility shared by the skill://, local://, memory://, and vault:// protocol
 * handlers and by managed-skill bundled-file writes. Kept dependency-free (only
 * `node:path`) so importers never drag the skill-discovery graph into a
 * module-initialization cycle.
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}
