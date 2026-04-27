import { logger } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../capability";
import { type Rule, ruleCapability } from "../capability/rule";
import { loadPromptTemplates, type PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { TtsrManager } from "../export/ttsr";
import { type CustomCommandsLoadResult, loadCustomCommands } from "../extensibility/custom-commands";
import {
	discoverAndLoadExtensions,
	type ExtensionFactory,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
} from "../extensibility/extensions";
import { loadSkills, type Skill, type SkillWarning } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { loadProjectContextFiles } from "../system-prompt";
import type { EventBus } from "../utils/event-bus";

export interface RuntimeResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settings: Settings;
	eventBus: EventBus;
}

export class RuntimeResourceLoader {
	readonly #cwd: string;
	readonly #agentDir: string;
	readonly #settings: Settings;
	readonly #eventBus: EventBus;

	constructor(options: RuntimeResourceLoaderOptions) {
		this.#cwd = options.cwd;
		this.#agentDir = options.agentDir;
		this.#settings = options.settings;
		this.#eventBus = options.eventBus;
	}

	async loadSkills(options: { skills?: Skill[] }): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
		if (options.skills !== undefined) {
			return { skills: options.skills, warnings: [] };
		}

		const skillsSettings = this.#settings.getGroup("skills");
		const disabledExtensionIds = this.#settings.get("disabledExtensions") ?? [];
		return await loadSkills({
			...skillsSettings,
			disabledExtensions: disabledExtensionIds,
			cwd: this.#cwd,
		});
	}

	async loadRules(options: {
		rules?: Rule[];
		injectedTtsrRules: string[];
	}): Promise<{ ttsrManager: TtsrManager; rulebookRules: Rule[]; alwaysApplyRules: Rule[] }> {
		const ttsrSettings = this.#settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings);
		const rulesResult =
			options.rules !== undefined
				? { items: options.rules, warnings: undefined }
				: await loadCapability<Rule>(ruleCapability.id, { cwd: this.#cwd });
		const rulebookRules: Rule[] = [];
		const alwaysApplyRules: Rule[] = [];
		for (const rule of rulesResult.items) {
			const isTtsrRule = rule.condition && rule.condition.length > 0 ? ttsrManager.addRule(rule) : false;
			if (isTtsrRule) {
				continue;
			}
			if (rule.alwaysApply === true) {
				alwaysApplyRules.push(rule);
				continue;
			}
			if (rule.description) {
				rulebookRules.push(rule);
			}
		}
		if (options.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(options.injectedTtsrRules);
		}
		return { ttsrManager, rulebookRules, alwaysApplyRules };
	}

	async loadContextFiles(options: {
		contextFiles?: Array<{ path: string; content: string }>;
	}): Promise<Array<{ path: string; content: string; depth?: number }>> {
		return options.contextFiles ?? (await loadProjectContextFiles({ cwd: this.#cwd }));
	}

	async loadPromptTemplates(options: { promptTemplates?: PromptTemplate[] }): Promise<PromptTemplate[]> {
		return options.promptTemplates ?? (await loadPromptTemplates({ cwd: this.#cwd, agentDir: this.#agentDir }));
	}

	async loadSlashCommands(options: { slashCommands?: FileSlashCommand[] }): Promise<FileSlashCommand[]> {
		return options.slashCommands ?? (await loadSlashCommands({ cwd: this.#cwd }));
	}

	async loadCustomCommands(options: { disableExtensionDiscovery?: boolean }): Promise<CustomCommandsLoadResult> {
		if (options.disableExtensionDiscovery) {
			return { commands: [], errors: [] };
		}

		const result = await loadCustomCommands({ cwd: this.#cwd, agentDir: this.#agentDir });
		for (const { path, error } of result.errors) {
			logger.error("Failed to load custom command", { path, error });
		}
		return result;
	}

	async loadExtensions(options: {
		disableExtensionDiscovery?: boolean;
		preloadedExtensions?: LoadExtensionsResult;
		additionalExtensionPaths?: string[];
		inlineExtensions?: ExtensionFactory[];
	}): Promise<LoadExtensionsResult> {
		let extensionsResult: LoadExtensionsResult;
		if (options.disableExtensionDiscovery) {
			const configuredPaths = options.additionalExtensionPaths ?? [];
			extensionsResult = await logger.time(
				"loadExtensions",
				loadExtensions,
				configuredPaths,
				this.#cwd,
				this.#eventBus,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else if (options.preloadedExtensions) {
			extensionsResult = options.preloadedExtensions;
		} else {
			const configuredPaths = [
				...(options.additionalExtensionPaths ?? []),
				...(this.#settings.get("extensions") ?? []),
			];
			const disabledExtensionIds = this.#settings.get("disabledExtensions") ?? [];
			extensionsResult = await logger.time(
				"discoverAndLoadExtensions",
				discoverAndLoadExtensions,
				configuredPaths,
				this.#cwd,
				this.#eventBus,
				disabledExtensionIds,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}

		const inlineExtensions = options.inlineExtensions ?? [];
		for (let i = 0; i < inlineExtensions.length; i++) {
			const factory = inlineExtensions[i];
			const loaded = await loadExtensionFromFactory(
				factory,
				this.#cwd,
				this.#eventBus,
				extensionsResult.runtime,
				`<inline-${i}>`,
			);
			extensionsResult.extensions.push(loaded);
		}

		return extensionsResult;
	}
}
