/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by scope: one user-level file, and one project-level file per directory depth.
	// Within each depth level, higher-priority providers shadow lower-priority ones.
	// This supports monorepo hierarchies where AGENTS.md exists at multiple ancestor levels.
	// Clamp depth >= 0: files inside config subdirectories of an ancestor (e.g. .claude/, .github/)
	// are same-scope as the ancestor itself.
	//
	// CLAUDE.md discovered by the standalone `agents-md` walk gets its own dedup slot, so an
	// opt-in project CLAUDE.md (`context.loadClaudeMd`) can coexist with a same-scope
	// AGENTS.md instead of one shadowing the other (#2612). The slot is deliberately keyed on
	// that one provider+filename pair rather than on every basename: a filename-wide key would
	// also stop unrelated context files (`.claude/CLAUDE.md`, `.github/copilot-instructions.md`,
	// `GEMINI.md`, …) from shadowing each other, breaking the documented one-file-per-scope
	// precedence model. Config-directory CLAUDE.md keeps competing for the shared slot as before.
	key: file => {
		const standaloneClaudeMd = file._source.provider === "agents-md" && path.basename(file.path) === "CLAUDE.md";
		const slot = standaloneClaudeMd ? ":CLAUDE" : "";
		return file.level === "user" ? `user${slot}` : `project:${Math.max(0, file.depth ?? 0)}${slot}`;
	},
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});
