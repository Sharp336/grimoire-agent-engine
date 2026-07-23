/**
 * 国际化 (i18n) 核心模块
 *
 * 翻译文件加载策略：
 * 1. 优先从包内 bundled lang/ 目录加载（随代码分发）
 * 2. 再从 ~/.omp/lang/ 加载用户覆盖（可选）
 * 支持插值和 fallback 机制
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** 包内 bundled 翻译目录 */
const BUNDLED_LAN_DIR = path.join(import.meta.dir, "lang");

/**
 * 翻译字典类型
 */
export interface TranslationDict {
	[key: string]: string | TranslationDict;
}

/**
 * 翻译元数据
 */
export interface TranslationMeta {
	version?: string;
	upstream_commit?: string;
	lastUpdated?: string;
	completeness?: number;
}

/**
 * 完整的翻译文件结构
 */
export interface TranslationFile {
	meta?: TranslationMeta;
	[key: string]: string | TranslationDict | TranslationMeta | undefined;
}

/**
 * i18n 管理器
 */
class I18nManager {
	#dict: TranslationFile = {};
	#lang: string = "en";
	#lanDir: string;
	#useBundled: boolean;
	#initialized = false;

	constructor(lanDir?: string) {
		this.#useBundled = lanDir === undefined;
		this.#lanDir = lanDir ?? path.join(os.homedir(), ".omp", "lang");
	}

	/**
	 * 重置实例（用于测试）
	 */
	reset(lanDir?: string): void {
		this.#dict = {};
		this.#lang = "en";
		this.#initialized = false;
		if (lanDir) {
			this.#lanDir = lanDir;
			this.#useBundled = false;
		} else {
			// 恢复默认值
			this.#lanDir = path.join(os.homedir(), ".omp", "lang");
			this.#useBundled = true;
		}
	}

	/**
	 * 初始化 i18n 系统
	 */
	async init(): Promise<void> {
		if (this.#initialized) return;

		this.#lang = await this.#detectLanguage();
		await this.#loadTranslation(this.#lang, this.#dict);

		this.#initialized = true;
	}

	/**
	 * 检测语言设置
	 * 优先读取 OMP_LANG 环境变量，其次从 config.yml 读取 i18n.language
	 */
	async #detectLanguage(): Promise<string> {
		// 环境变量优先
		if (process.env.OMP_LANG) {
			return process.env.OMP_LANG;
		}

		// 从 config.yml 读取
		try {
			const agentDir = getAgentDir();
			const configPath = path.join(agentDir, "config.yml");
			const content = await fs.readFile(configPath, "utf-8");
			// 匹配两种 YAML 格式：i18n:\n  language: zh（嵌套，settings 系统写入）
			// 或 i18n.language: zh（扁平，旧格式）。优先匹配嵌套格式。
			const match =
				content.match(/^\s*i18n:\s*\n\s*language:\s*["']?([^"'\s\n#]+)["']?/m) ||
				content.match(/^\s*i18n\.language:\s*["']?([^"'\s\n#]+)["']?/m);
			if (match) {
				const value = match[1].trim();
				if (value === "zh" || value === "en") {
					return value;
				}
			}
		} catch {
			// config.yml 不存在或读取失败，静默回退到 en
		}

		return "en";
	}

	/**
	 * 加载翻译文件
	 * 先加载包内 bundled 翻译，再用用户目录覆盖
	 */
	async #loadTranslation(lang: string, target: TranslationFile): Promise<void> {
		// 1. 加载包内 bundled 翻译（仅默认路径时）
		if (this.#useBundled) {
			await this.#loadTranslationFromDir(lang, BUNDLED_LAN_DIR, target);
		}
		// 2. 加载用户目录翻译
		await this.#loadTranslationFromDir(lang, this.#lanDir, target);
	}

	/**
	 * 从指定目录加载翻译文件
	 */
	async #loadTranslationFromDir(lang: string, dir: string, target: TranslationFile): Promise<void> {
		try {
			const files = await fs.readdir(dir);
			const langFiles = files.filter(f => f.startsWith(`${lang}-`) && f.endsWith(".json"));

			for (const file of langFiles) {
				try {
					const filePath = path.join(dir, file);
					const content = await fs.readFile(filePath, "utf-8");
					const parsed = JSON.parse(content) as TranslationFile;
					this.#mergeTranslations(target, parsed);
				} catch (error) {
					logger.warn(`Failed to load translation file: ${file}`, { error });
				}
			}
		} catch (error) {
			// 目录不存在时静默失败
			if (!isEnoent(error)) {
				logger.warn(`Failed to read translation directory: ${dir}`, { error });
			}
		}
	}

	/**
	 * 合并翻译
	 */
	#mergeTranslations(target: TranslationFile, source: TranslationFile): void {
		for (const [key, value] of Object.entries(source)) {
			if (key === "meta") {
				target.meta = value as TranslationMeta;
			} else if (typeof value === "string") {
				target[key] = value;
			} else if (typeof value === "object" && value !== null) {
				if (!target[key] || typeof target[key] !== "object") {
					target[key] = {};
				}
				this.#mergeTranslations(target[key] as TranslationDict, value as TranslationDict);
			}
		}
	}

	/**
	 * 翻译字符串
	 *
	 * @param key 翻译键，支持点号分隔的嵌套键，如 "settings.theme.dark.label"
	 * @param fallback 如果找不到翻译，返回的默认值
	 * @param params 插值参数
	 */
	t(key: string, fallback?: string, params?: Record<string, unknown>): string {
		if (!this.#initialized) {
			// 同步访问时使用未初始化的状态，返回 key
			return fallback || key;
		}

		// 先尝试直接查找扁平 key
		let value = this.#dict[key];
		if (value !== undefined && typeof value === "string") {
			return params ? this.#interpolate(value, params) : value;
		}

		// 再尝试嵌套查找
		value = this.#getNestedValue(this.#dict, key);
		if (value !== undefined && typeof value === "string") {
			return params ? this.#interpolate(value, params) : value;
		}

		// 返回用户提供的 fallback 或 key 本身
		const result = fallback || key;
		return params ? this.#interpolate(result, params) : result;
	}

	/**
	 * 获取嵌套值
	 */
	#getNestedValue(obj: unknown, key: string): string | TranslationDict | undefined {
		const keys = key.split(".");
		let current: unknown = obj;

		for (const k of keys) {
			if (current === undefined || current === null) return undefined;
			if (typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[k];
		}

		return current as string | TranslationDict | undefined;
	}

	/**
	 * 插值替换
	 * 支持 {key} 格式
	 */
	#interpolate(template: string, params: Record<string, unknown>): string {
		return template.replace(/\{(\w+)\}/g, (match, key) => {
			return params[key] !== undefined ? String(params[key]) : match;
		});
	}

	/**
	 * 获取当前语言
	 */
	getLanguage(): string {
		return this.#lang;
	}

	/**
	 * 设置语言（用于运行时切换，需要重新加载）
	 */
	async setLanguage(lang: string): Promise<void> {
		this.#lang = lang;
		this.#dict = {};
		this.#initialized = false;
		await this.#loadTranslation(lang, this.#dict);
		this.#initialized = true;

		// Clear all caches so UI reflects new language
		(await import("../modes/components/settings-defs")).invalidateSettingDefsCache();
		(await import("./prompt-loader")).clearPromptCache();
	}

	/**
	 * 检查翻译是否存在
	 */
	has(key: string): boolean {
		if (!this.#initialized) return false;
		// 先检查扁平 key
		if (this.#dict[key] !== undefined) return true;
		// 再检查嵌套 key
		return this.#getNestedValue(this.#dict, key) !== undefined;
	}

	/**
	 * 获取翻译元数据
	 */
	getMeta(): TranslationMeta | undefined {
		if (!this.#initialized) return undefined;
		return this.#dict.meta;
	}
}

// 全局单例（默认使用 ~/.omp/lang）
export const i18n = new I18nManager();

/**
 * 创建自定义 i18n 实例（用于测试）
 */
export function createI18n(lanDir?: string): I18nManager {
	return new I18nManager(lanDir);
}
export { I18nManager };

/**
 * 快捷翻译函数
 */
export function t(key: string, fallback?: string, params?: Record<string, unknown>): string {
	return i18n.t(key, fallback, params);
}

/**
 * 获取当前语言
 */
export function getLanguage(): string {
	return i18n.getLanguage();
}

/**
 * 设置语言
 */
export async function setLanguage(lang: string): Promise<void> {
	await i18n.setLanguage(lang);
}

/**
 * 检查翻译是否存在
 */
export function hasTranslation(key: string): boolean {
	return i18n.has(key);
}
