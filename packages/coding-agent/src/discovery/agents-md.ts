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
import type { LoadContext, LoadResult } from "../capability/types";
import { settings } from "../config/settings";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

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
 */
async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// AGENTS.md first: at a shared depth both survive dedup, and this fixes their order.
	const filenames = claudeMdEnabled() ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"];

	// Walk up from cwd looking for context files
	let current = ctx.cwd;

	while (true) {
		// Files whose parent directory name starts with "." belong to a config-directory
		// provider, not here. CLAUDE.md uses the identical check so the two filenames
		// share one skip rule (see #2612).
		const baseName = current.split(path.sep).pop() ?? "";

		if (!baseName.startsWith(".")) {
			for (const filename of filenames) {
				const candidate = path.join(current, filename);
				const content = await readFile(candidate);

				if (content !== null) {
					const calculatedDepth = calculateDepth(ctx.cwd, current, path.sep);

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

		if (current === (ctx.repoRoot ?? ctx.home)) break; // scanned repo root or home, stop

		// Move to parent directory
		const parent = path.dirname(current);
		if (parent === current) break; // Reached filesystem root
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
