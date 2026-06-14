/**
 * OKF codebase-walking enrichment — spawns a Task subagent that walks the
 * project tree and authors/updates OKF concepts.
 *
 * The subagent gets the enrichment prompt + the agent's existing file tools
 * (`read`/`search`/`find`) plus `okf://` read/write access. It explores the
 * codebase, identifies non-obvious architecture/conventions/pitfalls, and
 * writes concept files directly via the `okf://` protocol.
 *
 * This is a thin wrapper that builds the prompt and delegates to the
 * Task-agent framework. The actual exploration happens inside the subagent.
 */

import enrichmentPrompt from "../../prompts/okf/enrichment-codebase.md" with { type: "text" };

export interface CodebaseEnrichmentOptions {
	cwd: string;
	/** Optional scope hint (e.g. "auth module", "build system"). */
	focus?: string;
	/** Max number of concepts to aim for. Default 10. */
	maxConcepts?: number;
}

/**
 * Build the user-message prompt for the codebase-walking enrichment subagent.
 */
export function buildCodebaseEnrichmentPrompt(options: CodebaseEnrichmentOptions): string {
	const target = options.focus ? `Focus on: ${options.focus}.` : "Explore the whole codebase.";
	const maxConcepts = options.maxConcepts ?? 10;
	return `${enrichmentPrompt}

---

Target: ${target}
Aim for up to ${maxConcepts} high-quality concepts.
Working directory: ${options.cwd}

Start by reading the project structure (README, package.json/Cargo.toml/pyproject.toml, main entry points), then explore key modules. Use \`read okf://\` to check existing concepts, then \`write okf://<category>/<topic>.md\` to author new ones. Finish with \`/okf stats\` to verify.`;
}
