/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 * This handles AGENTS.md files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 *
 * When `context.loadClaudeMd` is enabled, standalone CLAUDE.md files are discovered
 * by the same walk, under identical skip/stop rules. AGENTS.md is read first so that
 * both files at one depth inject in a deterministic order.
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { settings } from "../config/settings";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

/**
 * Compare paths while tolerating Windows drive casing.
 */
function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

/**
 * Return whether `child` is at or below `parent`.
 */
function isWithin(parent: string, child: string): boolean {
	const normalizedParent = path.resolve(parent);
	const normalizedChild = path.resolve(child);
	const relative = path.relative(
		process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent,
		process.platform === "win32" ? normalizedChild.toLowerCase() : normalizedChild,
	);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Read the CLAUDE.md discovery toggle from settings.
 * Falls back to false (current behavior) when settings are not initialized,
 * e.g. inside discovery unit tests that run without Settings.init().
 */
function claudeMdEnabled(): boolean {
	try {
		return settings.get("context.loadClaudeMd") ?? false;
	} catch {
		return false;
	}
}

/**
 * Load standalone AGENTS.md files, plus CLAUDE.md when `context.loadClaudeMd` is set.
 *
 * When a repository is nested below the user's home directory, continue past
 * the Git root to discover workspace-level AGENTS.md files, but stop before
 * loading the home directory's own AGENTS.md as project context.
 */
export async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const home = path.resolve(ctx.home);
	const cwd = path.resolve(ctx.cwd);
	const repoRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : null;
	const filesystemRoot = path.parse(cwd).root;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot);
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : filesystemRoot));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : !samePath(boundary, home);
	const excludeHome = scanToHome;

	// AGENTS.md first: at a shared depth both survive dedup, and this fixes their order.
	const filenames = claudeMdEnabled() ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"];

	let current = cwd;
	while (true) {
		const atBoundary = samePath(current, boundary);
		const atHome = excludeHome && samePath(current, home);
		if (!(atHome || (atBoundary && !includeBoundary))) {
			const baseName = current.split(path.sep).pop() ?? "";
			if (!baseName.startsWith(".")) {
				for (const filename of filenames) {
					const candidate = path.join(current, filename);
					const content = await readFile(candidate);
					if (content !== null) {
						const calculatedDepth = calculateDepth(cwd, current, path.sep);
						items.push({
							path: candidate,
							content,
							level: "project",
							depth: calculatedDepth,
							_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
						});
					}
				}
			}
		}
		if (atBoundary) break;

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style), and CLAUDE.md when context.loadClaudeMd is enabled",
	priority: 10,
	load: loadAgentsMd,
});
