import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { getAllPluginPromptPaths, getAllPluginSkillPaths } from "../extensibility/plugins/loader";
import { compareSkillOrder, createSourceMeta, loadFilesFromDir, scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "plugins";
const DISPLAY_NAME = "Plugins";
const DESCRIPTION = "Installed OMP/Pi plugin package resources";
const PRIORITY = 90;

async function loadDirectSkill(resourcePath: string): Promise<Skill | null> {
	const isMarkdownFile = path.extname(resourcePath) === ".md";
	const skillPath = isMarkdownFile ? resourcePath : path.join(resourcePath, "SKILL.md");
	const content = await readFile(skillPath);
	if (!content) return null;
	const { frontmatter, body } = parseFrontmatter(content, { source: skillPath });
	if (frontmatter.enabled === false || !frontmatter.description) return null;
	const skillDirName = path.basename(isMarkdownFile ? path.dirname(skillPath) : resourcePath);
	const rawName = frontmatter.name;
	const name = typeof rawName === "string" ? rawName.trim() || skillDirName : skillDirName;
	return {
		name,
		path: skillPath,
		content: body,
		frontmatter: frontmatter as SkillFrontmatter,
		level: "user",
		_source: createSourceMeta(PROVIDER_ID, skillPath, "user"),
	};
}

async function scanPluginSkillPath(ctx: LoadContext, resourcePath: string): Promise<LoadResult<Skill>> {
	if (path.extname(resourcePath) === ".md") {
		const directSkill = await loadDirectSkill(resourcePath);
		return {
			items: directSkill ? [directSkill] : [],
			warnings: directSkill ? [] : [`Failed to read skill file: ${resourcePath}`],
		};
	}
	const collectionResult = await scanSkillsFromDir(ctx, {
		dir: resourcePath,
		providerId: PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
	if (collectionResult.items.length > 0) return collectionResult;

	const directSkill = await loadDirectSkill(resourcePath);
	return {
		items: directSkill ? [directSkill] : [],
		warnings: collectionResult.warnings,
	};
}

async function loadPluginSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const resourcePaths = await getAllPluginSkillPaths(ctx.cwd);
	const results = await Promise.all(resourcePaths.map(resourcePath => scanPluginSkillPath(ctx, resourcePath)));
	const items = results.flatMap(result => result.items);
	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return {
		items,
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

async function loadPromptFile(filePath: string): Promise<Prompt | null> {
	const content = await readFile(filePath);
	if (content === null) return null;
	return {
		name: path.basename(filePath).replace(/\.md$/, ""),
		path: filePath,
		content,
		_source: createSourceMeta(PROVIDER_ID, filePath, "user"),
	};
}

async function scanPluginPromptPath(ctx: LoadContext, resourcePath: string): Promise<LoadResult<Prompt>> {
	if (path.extname(resourcePath) === ".md") {
		const prompt = await loadPromptFile(resourcePath);
		return { items: prompt ? [prompt] : [], warnings: prompt ? [] : [`Failed to read prompt file: ${resourcePath}`] };
	}
	return await loadFilesFromDir<Prompt>(ctx, resourcePath, PROVIDER_ID, "user", {
		extensions: ["md"],
		transform: (name, content, filePath, source) => ({
			name: name.replace(/\.md$/, ""),
			path: filePath,
			content,
			_source: source,
		}),
	});
}

async function loadPluginPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const resourcePaths = await getAllPluginPromptPaths(ctx.cwd);
	const results = await Promise.all(resourcePaths.map(resourcePath => scanPluginPromptPath(ctx, resourcePath)));
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPluginSkills,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPluginPrompts,
});
