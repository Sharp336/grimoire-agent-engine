/**
 * Plugin skill discovery provider.
 * Loads skills from installed plugins based on their manifest declarations.
 */
import path from "node:path";
import { type Skill, skillCapability } from "../capability/skill";
import { registerProvider, type LoadContext, type LoadResult } from "../capability";
import { getAllPluginSkillPaths } from "../extensibility/plugins/loader";
import { scanSkillsFromDir } from "../util/filesystem/skill-scanner";

const PROVIDER_ID = "plugins";
const DISPLAY_NAME = "Plugins";
const DESCRIPTION = "Skills from installed omp plugins";
const PRIORITY = 500; // Load after built-in but before project-specific

/**
 * Load skills from all enabled plugins.
 */
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const pluginSkillPaths = await getAllPluginSkillPaths(ctx.cwd);

	const scans = pluginSkillPaths.map((skillDir) =>
		scanSkillsFromDir(ctx, {
			dir: skillDir,
			providerId: PROVIDER_ID,
			level: "native",
			requireDescription: true,
		}),
	);

	const results = await Promise.all(scans);

	return {
		items: results.flatMap((r) => r.items),
		warnings: results.flatMap((r) => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});
