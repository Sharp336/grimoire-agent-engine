#!/usr/bin/env bun
import { prompt } from "@oh-my-pi/pi-utils";
/**
 * Format prompt files (mixed XML + Markdown + Handlebars).
 *
 * Rules:
 * 1. No blank line before list items
 * 2. No blank line after opening XML tag or Handlebars block
 * 3. No blank line before closing XML tag or Handlebars block
 * 4. Strip leading whitespace from top-level closing XML tags (opened at col 0) and Handlebars (lines starting with {{)
 * 5. Compact markdown tables (remove padding)
 * 6. Delete a run of 2+ blank lines entirely; a single blank line is preserved
 * 7. Trim trailing whitespace (preserve indentation)
 * 8. Trailing newline at EOF for standalone prompts; the inline council lens keeps none
 * 9. Strip markdown bold from RFC 2119 keywords and alias `MUST NOT`/`SHOULD NOT` to `NEVER`/`AVOID`
 */
import { Glob } from "bun";

const PROMPTS_DIR = `${import.meta.dir}/../src/prompts/`;
const COMMIT_PROMPTS_DIR = `${import.meta.dir}/../src/commit/prompts/`;
const AGENTIC_PROMPTS_DIR = `${import.meta.dir}/../src/commit/agentic/prompts/`;

const PROMPT_DIRS = [PROMPTS_DIR, COMMIT_PROMPTS_DIR, AGENTIC_PROMPTS_DIR];

/**
 * The one prompt written without a trailing newline. It is interpolated into `member-task.md` at
 * `{{lens}}`, whose template already supplies the `\n\n` separating it from the next H1. A final LF
 * here would make that a 2+ blank run, which rule 6 deletes, welding the lens onto the next heading.
 */
const INLINE_COUNCIL_LENS_PATH = `${PROMPTS_DIR}council/lens.md`;

const PROMPT_FORMAT_OPTIONS = {
	renderPhase: "pre-render",
	replaceAsciiSymbols: true,
	normalizeRfc2119: true,
} as const;

async function main() {
	const glob = new Glob("**/*.md");
	const files: string[] = [];
	let changed = 0;
	const check = process.argv.includes("--check");

	for (const dir of PROMPT_DIRS) {
		for await (const path of glob.scan(dir)) {
			files.push(`${dir}${path}`);
		}
	}

	for (const fullPath of files) {
		const original = await Bun.file(fullPath).text();
		const formatted = prompt.format(original, PROMPT_FORMAT_OPTIONS);
		const output = fullPath === INLINE_COUNCIL_LENS_PATH ? formatted : `${formatted}\n`;

		if (original !== output) {
			if (check) {
				console.log(`Would format: ${fullPath}`);
			} else {
				await Bun.write(fullPath, output);
				console.log(`Formatted: ${fullPath}`);
			}
			changed++;
		}
	}

	if (check && changed > 0) {
		console.log(`\n${changed} file(s) need formatting. Run 'bun run format-prompts' to fix.`);
		process.exit(1);
	} else if (changed === 0) {
		console.log("All prompt files are formatted.");
	} else {
		console.log(`\nFormatted ${changed} file(s).`);
	}
}

main();
