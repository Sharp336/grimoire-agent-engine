/**
 * AGENTS.md / CLAUDE.md Provider
 *
 * Discovers standalone AGENTS.md and CLAUDE.md files by walking up from cwd.
 * This handles files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md / CLAUDE.md";

const FILENAMES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Load standalone AGENTS.md and CLAUDE.md files.
 */
async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// Walk up from cwd looking for AGENTS.md and CLAUDE.md files
	let current = ctx.cwd;

	while (true) {
		const dirBaseName = current.split(path.sep).pop() ?? "";

		if (!dirBaseName.startsWith(".")) {
			for (const filename of FILENAMES) {
				const candidate = path.join(current, filename);
				const content = await readFile(candidate);

				if (content !== null) {
					const fileDir = path.dirname(candidate);
					const calculatedDepth = calculateDepth(ctx.cwd, fileDir, path.sep);

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
	description: "Standalone AGENTS.md / CLAUDE.md files (Codex/Gemini/Claude style)",
	priority: 10,
	load: loadAgentsMd,
});
