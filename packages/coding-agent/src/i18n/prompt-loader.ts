/**
 * Markdown Prompt 翻译加载器
 *
 * 加载策略：
 * 1. 优先从包内 bundled lang/prompts/ 目录加载（随代码分发）
 * 2. 再从 ~/.omp/lang/prompts/ 加载用户覆盖（可选）
 * 找不到翻译则使用原始英文版本
 */

import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { getLanguage, registerCacheInvalidator } from "./index";

/** 包内 bundled prompt 翻译目录 */
const BUNDLED_PROMPTS_DIR = path.join(import.meta.dir, "lang", "prompts");

/**
 * Prompt 翻译缓存
 */
const promptCache = new Map<string, string>();

// Register cache invalidator with i18n system
registerCacheInvalidator(clearPromptCache);

/**
 * 尝试从指定路径加载翻译文件
 *
 * @param filePath 文件路径
 * @returns 文件内容（如果存在且可读），否则返回 null
 */
async function tryLoadPrompt(filePath: string): Promise<string | null> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		if (process.env.NODE_ENV === "development") {
			logger.warn(`Failed to load translated prompt: ${filePath}`, { error });
		}
		return null;
	}
}

/**
 * 加载翻译的 prompt 文件
 *
 * @param promptPath prompt 相对路径（不含 .md 后缀），如 "system/system-prompt"
 * @param originalContent 原始英文内容
 * @returns 翻译后的内容（如果存在）或原始内容
 *
 * @example
 * import originalPrompt from "./prompts/system/system-prompt.md" with { type: "text" };
 * import { loadTranslatedPrompt } from "../i18n/prompt-loader";
 *
 * const systemPrompt = await loadTranslatedPrompt("system/system-prompt", originalPrompt);
 */
export async function loadTranslatedPrompt(promptPath: string, originalContent: string): Promise<string> {
	// 确定语言
	const lang = getLanguage();

	// 如果是英文，直接返回原文
	if (lang === "en") {
		return originalContent;
	}

	// 构造缓存键
	const cacheKey = `${lang}:${promptPath}`;

	// 检查缓存
	const cached = promptCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	// 构造翻译文件路径（用户覆盖优先，bundled 兜底）
	const userPath = path.join(os.homedir(), ".omp", "lang", "prompts", lang, `${promptPath}.md`);
	const bundledPath = path.join(BUNDLED_PROMPTS_DIR, lang, `${promptPath}.md`);

	// 尝试用户覆盖路径
	const translated = (await tryLoadPrompt(userPath)) ?? (await tryLoadPrompt(bundledPath));

	if (translated !== null) {
		promptCache.set(cacheKey, translated);
		return translated;
	}

	// 找不到翻译，返回原文
	promptCache.set(cacheKey, originalContent);
	return originalContent;
}

/**
 * 清除 prompt 缓存（用于语言切换）
 */
export function clearPromptCache(): void {
	promptCache.clear();
}

/**
 * 获取缓存统计信息（用于调试）
 */
export function getPromptCacheStats(): { size: number; keys: string[] } {
	return {
		size: promptCache.size,
		keys: Array.from(promptCache.keys()),
	};
}
