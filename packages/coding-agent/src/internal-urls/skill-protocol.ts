/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 * For marketplace plugin skills (those with a pluginRoot), relative paths may traverse up
 * to the plugin root boundary, enabling cross-skill asset sharing within one plugin.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir (or plugin root)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface SkillProtocolOptions {
	/**
	 * Returns the currently loaded skills.
	 */
	getSkills: () => readonly Skill[];
}

/**
 * Get content type based on file extension.
 */
function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a relative path is safe: no absolute paths, no .. traversal.
 * Used by local:// and memory:// handlers that resolve within a fixed root.
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

/**
 * Handler for skill:// URLs.
 *
 * Resolves skill names to their content files.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	constructor(private readonly options: SkillProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const skills = this.options.getSkills();

		// Extract skill name from host
		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		// Find the skill
		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		// Determine the file to read
		let targetPath: string;
		// Use rawPathname (pre-normalization) so that .. segments intentionally used for
		// plugin-root traversal are not stripped by new URL() when the skill name looks
		// like a hostname:port pair (e.g. plugin:8080) and URL parsing succeeds.
		const urlPath = url.rawPathname ?? url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1)); // Remove leading /

			if (path.isAbsolute(relativePath)) {
				throw new Error("Absolute paths are not allowed in skill:// URLs");
			}

			// For skills without a pluginRoot, .. is not allowed — there is no safe boundary
			// above the skill directory to constrain traversal.
			if (!skill.pluginRoot) {
				const normalized = path.normalize(relativePath);
				if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
					throw new Error("Path traversal (..) is not allowed in skill:// URLs");
				}
			}

			targetPath = path.join(skill.baseDir, relativePath);

			// Lexical containment check — rejects obvious traversal before any I/O.
			const resolvedPath = path.resolve(targetPath);
			const securityRoot = path.resolve(skill.pluginRoot ?? skill.baseDir);
			if (!resolvedPath.startsWith(securityRoot + path.sep) && resolvedPath !== securityRoot) {
				throw new Error("Path traversal is not allowed");
			}

			// Realpath containment check — prevents symlink escape within pluginRoot.
			// A plugin could ship a symlink inside its root pointing outside; the lexical
			// check passes because the path stays within pluginRoot lexically, but
			// fs.realpath reveals the true destination.
			let realSecurityRoot: string;
			try {
				realSecurityRoot = await fs.realpath(securityRoot);
			} catch {
				realSecurityRoot = securityRoot;
			}
			try {
				const realTargetPath = await fs.realpath(targetPath);
				if (!realTargetPath.startsWith(realSecurityRoot + path.sep) && realTargetPath !== realSecurityRoot) {
					throw new Error("Path traversal is not allowed");
				}
				// Use the resolved real path for the file read below.
				targetPath = realTargetPath;
			} catch (err) {
				// ENOENT: file absent — lexical check already confirmed containment;
				// the exists() check below handles the missing-file case.
				// Re-throw anything else (permission denied, I/O errors).
				if (!isEnoent(err)) throw err;
			}
		} else {
			// Read SKILL.md
			targetPath = skill.filePath;
		}

		// Read the file
		const file = Bun.file(targetPath);
		if (!(await file.exists())) {
			throw new Error(`File not found: ${targetPath}`);
		}

		const content = await file.text();
		const contentType = getContentType(targetPath);

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}
}
