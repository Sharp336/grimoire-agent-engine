/**
 * i18n 初始化模块
 *
 * 在应用启动时导入此模块，确保 i18n 系统被正确初始化
 * 此模块会立即执行初始化逻辑
 */

import { i18n } from "./index";

// 立即初始化 i18n 系统
i18n.init();

// 在开发模式下输出初始化信息
if (process.env.NODE_ENV === "development") {
	const lang = i18n.getLanguage();
	const meta = i18n.getMeta();
	console.log(`[i18n] Initialized with language: ${lang}`);
	if (meta) {
		console.log(`[i18n] Translation version: ${meta.version || "unknown"}`);
		console.log(`[i18n] Translation completeness: ${meta.completeness || 0}%`);
	}
}
