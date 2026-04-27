/**
 * Plugin loader - discovers and loads manifest entry points from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their
 * tools/hooks/extensions/commands based on manifest entries and enabled features.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsLockfile, getPluginsNodeModules, getPluginsPackageJson, isEnoent } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../../config";
import { normalizePiCompatibleManifest } from "../pi-compat/manifest";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

// =============================================================================
// Runtime Config Loading
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 */
async function loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
	const lockPath = getPluginsLockfile();
	try {
		return await Bun.file(lockPath).json();
	} catch (err) {
		if (isEnoent(err)) return { plugins: {}, settings: {} };
		throw err;
	}
}

/**
 * Load project-local plugin overrides (checks .omp and .pi directories).
 */
async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			// JSON parse error - continue to next path
		}
	}
	return {};
}

// =============================================================================
// Plugin Discovery
// =============================================================================

/**
 * Get list of enabled plugins with their resolved configurations.
 * Respects both global runtime config and project overrides.
 */
export async function getEnabledPlugins(cwd: string): Promise<InstalledPlugin[]> {
	const pkgJsonPath = getPluginsPackageJson();
	let pkg: { dependencies?: Record<string, string> };
	try {
		pkg = await Bun.file(pkgJsonPath).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const nodeModulesPath = getPluginsNodeModules();
	if (!fs.existsSync(nodeModulesPath)) {
		return [];
	}

	const deps = pkg.dependencies || {};
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);
	const plugins: InstalledPlugin[] = [];

	for (const [name] of Object.entries(deps)) {
		const pluginPath = path.join(nodeModulesPath, name);
		const pluginPkgPath = path.join(pluginPath, "package.json");
		let pluginPkg: { version: string; omp?: PluginManifest; pi?: PluginManifest };
		try {
			pluginPkg = await Bun.file(pluginPkgPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}

		const manifestResult = await normalizePiCompatibleManifest(pluginPkg, pluginPath);
		const manifest = manifestResult.manifest;

		if (!manifest) {
			// Not an omp/pi plugin and no conventional Pi resource dirs, skip
			continue;
		}

		const runtimeState = runtimeConfig.plugins[name];

		// Check if disabled globally
		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		// Check if disabled in project
		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		// Resolve enabled features (project overrides take precedence)
		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;

		plugins.push({
			name,
			version: pluginPkg.version,
			path: pluginPath,
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// =============================================================================

type PluginResourceKey = "tools" | "hooks" | "commands" | "extensions" | "skills" | "prompts" | "themes";

function isExtensionEntryFile(filePath: string): boolean {
	return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

function resolveExtensionDirectoryEntries(dir: string): string[] {
	const indexTs = path.join(dir, "index.ts");
	if (fs.existsSync(indexTs)) return [indexTs];

	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexJs)) return [indexJs];

	const entries: string[] = [];
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return entries;
	}

	for (const entry of dirents) {
		const entryPath = path.join(dir, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionEntryFile(entry.name)) {
			entries.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const nestedIndexTs = path.join(entryPath, "index.ts");
			if (fs.existsSync(nestedIndexTs)) {
				entries.push(nestedIndexTs);
				continue;
			}
			const nestedIndexJs = path.join(entryPath, "index.js");
			if (fs.existsSync(nestedIndexJs)) {
				entries.push(nestedIndexJs);
			}
		}
	}

	return entries;
}

function resolvePluginEntryPath(key: PluginResourceKey, resolved: string): string[] {
	if (key !== "extensions") return [resolved];
	try {
		if (fs.statSync(resolved).isDirectory()) {
			const entries = resolveExtensionDirectoryEntries(resolved);
			return entries.length > 0 ? entries : [resolved];
		}
	} catch {
		return [];
	}
	return [resolved];
}

/**
 * Generic path resolver for plugin manifest entries.
 * Handles both single-string and string[] base entries, plus feature-specific entries.
 */
function resolvePluginPaths(plugin: InstalledPlugin, key: PluginResourceKey): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base entry (always included if exists)
	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			const resolved = path.join(plugin.path, entry);
			if (fs.existsSync(resolved)) {
				paths.push(...resolvePluginEntryPath(key, resolved));
			}
		}
	}

	// Feature-specific entries
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = path.join(plugin.path, entry);
					if (fs.existsSync(resolved)) {
						paths.push(...resolvePluginEntryPath(key, resolved));
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = path.join(plugin.path, entry);
					if (fs.existsSync(resolved)) {
						paths.push(...resolvePluginEntryPath(key, resolved));
					}
				}
			}
		}
	}

	return paths;
}

export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "hooks");
}

export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "commands");
}

export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

export function resolvePluginSkillPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "skills");
}

export function resolvePluginPromptPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "prompts");
}

export function resolvePluginThemePaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "themes");
}

// =============================================================================
// Aggregated Discovery
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 */
export async function getAllPluginToolPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 */
export async function getAllPluginHookPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 */
export async function getAllPluginCommandPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get all extension module paths from all enabled plugins.
 */
export async function getAllPluginExtensionPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

export async function getAllPluginSkillPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginSkillPaths(plugin));
	}

	return paths;
}

export async function getAllPluginPromptPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginPromptPaths(plugin));
	}

	return paths;
}

export async function getAllPluginThemePaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginThemePaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 */
export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
