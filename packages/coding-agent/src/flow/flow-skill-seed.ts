/**
 * Flow skill seed — copies bundled skill files (SKILL.md + helpers) into
 * the project's `.omp/skills/<name>/` directory on first run so the live
 * flow can reference them via `skill://<name>`.
 *
 * The skill content is statically imported from `./skills/*​/SKILL.md` so
 * it survives `bun build --compile` (reading from fs at runtime would fail
 * once the binary is compiled).
 *
 * Only flow-owned skills live here. Pre-existing user skills in the
 * project are never touched.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import flowEditorSkill from "./skills/flow-editor/SKILL.md" with { type: "text" };

/**
 * The set of skills the flow engine manages. Keys are skill names
 * (matching `skill://<name>`). Values are the SKILL.md body.
 */
const BUNDLED_FLOW_SKILLS: Record<string, string> = {
	"flow-editor": flowEditorSkill,
};

/**
 * Seed the bundled flow skills into `<cwd>/.omp/skills/<name>/SKILL.md`
 * if the destination file does not yet exist. Returns the list of skill
 * names that were written this time (may be empty on subsequent runs).
 */
export function seedFlowSkills(cwd: string = process.cwd()): string[] {
	const written: string[] = [];
	const skillsDir = join(cwd, ".omp", "skills");
	try {
		mkdirSync(skillsDir, { recursive: true });
	} catch {
		// ignore
	}
	for (const [name, body] of Object.entries(BUNDLED_FLOW_SKILLS)) {
		const dir = join(skillsDir, name);
		const file = join(dir, "SKILL.md");
		if (existsSync(file)) continue;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, body, "utf8");
			written.push(name);
		} catch {
			// best effort
		}
	}
	return written;
}
