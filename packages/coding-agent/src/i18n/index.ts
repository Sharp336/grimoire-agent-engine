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

import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { settings } from "../config/settings";
import { EMBEDDED_TRANSLATIONS } from "./embedded-translations";

/** 包内 bundled 翻译目录 */
const BUNDLED_LAN_DIR = path.join(import.meta.dir, "lang");

/**
 * 缓存失效回调注册表
 * 用于打破循环依赖：其他模块注册缓存失效回调，setLanguage 时统一调用
 */
type CacheInvalidator = () => void;
const cacheInvalidators: CacheInvalidator[] = [];

/**
 * 注册缓存失效回调
 * 当语言切换时，i18n 系统会调用所有注册的回调来清除缓存
 */
export function registerCacheInvalidator(invalidator: CacheInvalidator): void {
	if (!cacheInvalidators.includes(invalidator)) {
		cacheInvalidators.push(invalidator);
	}
}

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
		// 从嵌入式翻译数据同步加载（编译时已导入，立即可用）
		this.#lang = this.#detectLanguageSync();
		this.#loadEmbedded(this.#lang);
		this.#initialized = true;
	}

	/**
	 * 从嵌入式 bundle 加载翻译（同步，立即可用）
	 * @param lang 语言代码
	 * @param target 目标字典，默认为 this.#dict
	 */
	#loadEmbedded(lang: string, target?: TranslationFile): void {
		const dict = target ?? this.#dict;
		const prefix = `${lang}-`;
		for (const [key, data] of Object.entries(EMBEDDED_TRANSLATIONS)) {
			if (key !== lang && !key.startsWith(prefix)) continue;
			this.#mergeTranslations(dict, data);
		}
	}

	/**
	 * 同步检测语言（仅从环境变量，config.yml 由异步 init 补充）
	 */
	#detectLanguageSync(): string {
		if (process.env.OMP_LANG === "zh" || process.env.OMP_LANG === "en") {
			return process.env.OMP_LANG;
		}
		return "en";
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
			// 恢复默认值：bundled 模式
			this.#lanDir = path.join(os.homedir(), ".omp", "lang");
			this.#useBundled = true;
		}
		// 重新加载嵌入式翻译
		this.#lang = this.#detectLanguageSync();
		this.#loadEmbedded(this.#lang);
		this.#initialized = true;
	}

	/**
	 * 初始化 i18n 系统（异步补充：可加载用户覆盖 + config.yml 语言检测）
	 */
	async init(): Promise<void> {
		// 构造函数已从嵌入式数据同步初始化；异步检查 config.yml 覆盖
		// 但如果 OMP_LANG 环境变量已设置，跳过 config 读取（env 优先级高于 config）
		const ompLangSet = process.env.OMP_LANG === "zh" || process.env.OMP_LANG === "en";
		if (!ompLangSet) {
			const configLang = await this.#detectLanguageFromConfig();
			if (configLang && configLang !== this.#lang) {
				this.#lang = configLang;
				this.#dict = {};
				this.#loadEmbedded(configLang);
			}
		}
		// 加载用户目录覆盖（从 ~/.omp/lang/ 加载用户自定义翻译）
		await this.#loadTranslation(this.#lang, this.#dict);
		// 调用所有注册的缓存失效回调（如 settings-defs、welcome tips）
		for (const invalidator of cacheInvalidators) {
			invalidator();
		}
	}

	/**
	 * 检测语言：优先从 Settings（支持 --config overlay），fallback 解析主配置文件
	 */
	async #detectLanguageFromConfig(): Promise<string | null> {
		// Try to read from Settings if initialized (respects --config overlay)
		try {
			const settingsLang = settings.get("i18n.language");
			if (settingsLang === "zh" || settingsLang === "en") {
				return settingsLang;
			}
		} catch {
			// Settings not initialized yet, fall back to parsing config file
		}

		// Fallback: parse main config file
		try {
			const agentDir = getAgentDir();
			for (const basename of ["config.yml", "config.yaml"]) {
				const configPath = path.join(agentDir, basename);
				let content: string;
				try {
					content = await fs.readFile(configPath, "utf-8");
				} catch {
					continue;
				}
				const match =
					content.match(/^\s*i18n:\s*\n(?:[^\n]*\n)*?\s*language:\s*["']?([^"'\s\n#]+)["']?/m) ||
					content.match(/^\s*i18n\.language:\s*["']?([^"'\s\n#]+)["']?/m);
				if (match) {
					const value = match[1].trim();
					if (value === "zh" || value === "en") return value;
				}
			}
		} catch {
			// config file doesn't exist or can't be read
		}
		return null;
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
		// 优先从嵌入的翻译表加载（编译到二进制中的）
		if (dir === BUNDLED_LAN_DIR) {
			this.#loadEmbedded(lang, target);
			return;
		}

		try {
			const files = await fs.readdir(dir);
			const langFiles = files.filter(f => (f === `${lang}.json` || f.startsWith(`${lang}-`)) && f.endsWith(".json"));

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
			return fallback ?? key;
		}

		// 先尝试直接查找扁平 key
		let value = this.#dict[key];
		if (value !== undefined && typeof value === "string" && value !== "") {
			return params ? this.#interpolate(value, params) : value;
		}

		// 再尝试嵌套查找
		value = this.#getNestedValue(this.#dict, key);
		if (value !== undefined && typeof value === "string" && value !== "") {
			return params ? this.#interpolate(value, params) : value;
		}

		// 返回用户提供的 fallback 或 key 本身
		const result = fallback ?? key;
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
		// 验证语言参数（仅支持 en 和 zh）
		if (lang !== "en" && lang !== "zh") {
			logger.warn(`Unsupported language: ${lang}. Supported languages are: en, zh`);
			return;
		}
		this.#lang = lang;
		this.#dict = {};
		this.#initialized = false;
		// 先加载嵌入式翻译（编译时 bundle）
		this.#loadEmbedded(lang);
		// 再从文件系统加载（用户自定义覆盖）
		await this.#loadTranslation(lang, this.#dict);
		this.#initialized = true;

		// Clear all registered caches so UI reflects new language
		for (const invalidator of cacheInvalidators) {
			invalidator();
		}
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
