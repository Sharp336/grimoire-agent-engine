/**
 * Compatibility {@link DefaultPackageManager} for legacy pi extensions that
 * enumerate host extensions via `new DefaultPackageManager(...).resolve()`.
 *
 * OMP already discovers extensions through {@link discoverExtensionPaths}; this
 * shim maps that discovery onto pi's ResolvedPaths shape so menus like pi-task's
 * `/task-config` whitelist mirror what the host runtime would load.
 */

import * as path from "node:path";
import type { Settings } from "../config/settings";
import { discoverExtensionPaths } from "./extensions/loader";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "./plugins/loader";
import type { ScopedInstalledPlugin } from "./plugins/loader";

export type SourceScope = "user" | "project" | "temporary";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

type SettingsManagerLike =
	| Settings
	| Promise<Settings>
	| {
			getGlobalSettings?: () => { extensions?: string[]; disabledExtensions?: string[] };
			getProjectSettings?: () => { extensions?: string[]; disabledExtensions?: string[] };
	  };

async function resolveSettingsManager(settingsManager: SettingsManagerLike): Promise<SettingsManagerLike> {
	if (settingsManager && typeof (settingsManager as Promise<unknown>).then === "function") {
		return await settingsManager;
	}
	return settingsManager;
}

function isOmpSettings(settingsManager: SettingsManagerLike): settingsManager is Settings {
	return typeof (settingsManager as Settings).get === "function";
}

async function buildPluginExtensionMetadata(cwd: string): Promise<Map<string, PathMetadata>> {
	const metadataByPath = new Map<string, PathMetadata>();
	const plugins = await getEnabledPlugins(cwd);
	for (const plugin of plugins) {
		for (const extPath of resolvePluginExtensionPaths(plugin)) {
			metadataByPath.set(path.resolve(extPath), {
				source: `npm:${plugin.name}`,
				scope: plugin.scope,
				origin: "package",
				baseDir: plugin.path,
			});
		}
	}
	return metadataByPath;
}

function inferExtensionMetadata(
	extPath: string,
	cwd: string,
	agentDir: string,
	pluginMetadata: Map<string, PathMetadata>,
): PathMetadata {
	const resolved = path.resolve(extPath);
	const fromPlugin = pluginMetadata.get(resolved);
	if (fromPlugin) {
		return fromPlugin;
	}

	const agentExtensionsDir = path.join(agentDir, "extensions");
	if (resolved.startsWith(`${agentExtensionsDir}${path.sep}`) || resolved === agentExtensionsDir) {
		return { source: "auto", scope: "user", origin: "top-level", baseDir: agentDir };
	}

	for (const projectRoot of [path.join(cwd, ".omp"), path.join(cwd, ".pi")]) {
		const projectExtensionsDir = path.join(projectRoot, "extensions");
		if (resolved.startsWith(`${projectExtensionsDir}${path.sep}`) || resolved === projectExtensionsDir) {
			return { source: "auto", scope: "project", origin: "top-level", baseDir: projectRoot };
		}
	}

	return { source: "local", scope: "user", origin: "top-level" };
}

async function discoverHostExtensionPaths(
	settingsManager: SettingsManagerLike,
	cwd: string,
): Promise<{ paths: string[]; disabledExtensionIds: string[] }> {
	if (isOmpSettings(settingsManager)) {
		const disabledExtensionIds = settingsManager.get("disabledExtensions") ?? [];
		const configuredPaths = settingsManager.get("extensions") ?? [];
		const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
		return { paths, disabledExtensionIds };
	}

	const global = settingsManager.getGlobalSettings?.() ?? {};
	const project = settingsManager.getProjectSettings?.() ?? {};
	const configuredPaths = [...(project.extensions ?? []), ...(global.extensions ?? [])];
	const disabledExtensionIds = [
		...(project.disabledExtensions ?? []),
		...(global.disabledExtensions ?? []),
	];
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
	return { paths, disabledExtensionIds };
}

export class DefaultPackageManager {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManagerLike;

	constructor(options: { cwd: string; agentDir: string; settingsManager: SettingsManagerLike }) {
		this.cwd = path.resolve(options.cwd);
		this.agentDir = path.resolve(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	setProgressCallback(_callback?: unknown): void {
		// OMP plugin installs are handled by `omp plugin`; legacy pi install UX is unsupported.
	}

	async resolve(
		_onMissing?: (source: string) => Promise<"install" | "skip" | "error">,
	): Promise<ResolvedPaths> {
		const settingsManager = await resolveSettingsManager(this.settingsManager);
		const { paths } = await discoverHostExtensionPaths(settingsManager, this.cwd);
		const pluginMetadata = await buildPluginExtensionMetadata(this.cwd);
		const disabled = new Set(
			isOmpSettings(settingsManager) ? (settingsManager.get("disabledExtensions") ?? []) : [],
		);

		const extensions: ResolvedResource[] = paths.map(extPath => {
			const resolved = path.resolve(extPath);
			const metadata = inferExtensionMetadata(resolved, this.cwd, this.agentDir, pluginMetadata);
			const enabled = !disabled.has(`extension-module:${path.basename(resolved)}`);
			return { path: resolved, enabled, metadata };
		});

		return { extensions, skills: [], prompts: [], themes: [] };
	}

	async install(): Promise<void> {
		throw new Error("DefaultPackageManager.install is not supported under OMP; use `omp plugin install`.");
	}

	async installAndPersist(): Promise<void> {
		return this.install();
	}

	async remove(): Promise<void> {
		throw new Error("DefaultPackageManager.remove is not supported under OMP; use `omp plugin remove`.");
	}

	async removeAndPersist(): Promise<boolean> {
		await this.remove();
		return false;
	}

	async update(): Promise<void> {
		throw new Error("DefaultPackageManager.update is not supported under OMP; use `omp plugin update`.");
	}

	listConfiguredPackages(): never[] {
		return [];
	}

	async resolveExtensionSources(): Promise<ResolvedPaths> {
		return this.resolve();
	}

	addSourceToSettings(): boolean {
		return false;
	}

	removeSourceFromSettings(): boolean {
		return false;
	}

	getInstalledPath(): undefined {
		return undefined;
	}
}
