import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createI18n, type I18nManager, i18n } from "../src/i18n";
import { interceptTips } from "../src/i18n/interceptor";

describe("i18n", () => {
	let tempDir: string;
	const originalEnv = process.env.OMP_LANG;

	beforeEach(async () => {
		// 创建临时目录用于测试翻译文件
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "i18n-test-"));
		// 设置环境变量
		process.env.OMP_LANG = "zh";
	});

	afterEach(async () => {
		// 清理临时目录
		await fs.rm(tempDir, { recursive: true, force: true });
		// 恢复环境变量
		if (originalEnv !== undefined) {
			process.env.OMP_LANG = originalEnv;
		} else {
			delete process.env.OMP_LANG;
		}
	});

	describe("loading translation files", () => {
		it("loads and merges translations from multiple JSON files", async () => {
			await fs.writeFile(
				path.join(tempDir, "zh-ui.json"),
				JSON.stringify({
					meta: { version: "1.0.0" },
					"button.save": "保存",
					"button.cancel": "取消",
				}),
			);
			await fs.writeFile(
				path.join(tempDir, "zh-messages.json"),
				JSON.stringify({
					"message.success": "操作成功",
					"message.error": "操作失败",
				}),
			);

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("button.save")).toBe("保存");
			expect(i18n.t("button.cancel")).toBe("取消");
			expect(i18n.t("message.success")).toBe("操作成功");
		});

		it("handles nested translation structure", async () => {
			await fs.writeFile(
				path.join(tempDir, "zh-nested.json"),
				JSON.stringify({
					custom: {
						feature: {
							settings: {
								label: "测试标签",
								description: "测试描述",
							},
						},
					},
				}),
			);

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("custom.feature.settings.label")).toBe("测试标签");
			expect(i18n.t("custom.feature.settings.description")).toBe("测试描述");
		});

		it("skips invalid JSON files", async () => {
			await fs.writeFile(path.join(tempDir, "zh-valid.json"), JSON.stringify({ key: "值" }));
			await fs.writeFile(path.join(tempDir, "zh-invalid.json"), "{ invalid json }");

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("key")).toBe("值");
		});

		it("skips non-JSON files", async () => {
			await fs.writeFile(path.join(tempDir, "zh-valid.json"), JSON.stringify({ key: "值" }));
			await fs.writeFile(path.join(tempDir, "zh-readme.txt"), "这不是 JSON");

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("key")).toBe("值");
		});
	});

	describe("translation lookup", () => {
		let i18n: I18nManager;

		beforeEach(async () => {
			await fs.writeFile(
				path.join(tempDir, "zh-test.json"),
				JSON.stringify({
					"simple.key": "简单键",
					"with.param": "带 {name} 的键",
					"multiple.params": "{greeting}，{name}！",
				}),
			);

			i18n = createI18n(tempDir);
			await i18n.init();
		});

		it("returns found translation", () => {
			expect(i18n.t("simple.key")).toBe("简单键");
		});

		it("returns fallback when key is missing", () => {
			expect(i18n.t("missing.key", "默认值")).toBe("默认值");
		});

		it("returns key name when missing and no fallback", () => {
			expect(i18n.t("missing.key")).toBe("missing.key");
		});

		it("supports single parameter interpolation", () => {
			expect(i18n.t("with.param", undefined, { name: "参数" })).toBe("带 参数 的键");
		});

		it("supports multiple parameter interpolation", () => {
			expect(i18n.t("multiple.params", undefined, { greeting: "你好", name: "世界" })).toBe("你好，世界！");
		});

		it("preserves placeholders for unprovided parameters", () => {
			expect(i18n.t("multiple.params", undefined, { greeting: "你好" })).toBe("你好，{name}！");
		});

		it("checks if translation exists", () => {
			expect(i18n.has("simple.key")).toBe(true);
			expect(i18n.has("missing.key")).toBe(false);
		});
	});

	describe("fallback language mechanism", () => {
		it("returns key when missing in current language", async () => {
			await fs.writeFile(path.join(tempDir, "zh-partial.json"), JSON.stringify({ "only.in.zh": "仅中文" }));

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("only.in.zh")).toBe("仅中文");
			expect(i18n.t("only.in.en")).toBe("only.in.en");
		});

		it("returns key when missing in both languages", async () => {
			await fs.writeFile(path.join(tempDir, "zh-test.json"), JSON.stringify({ "existing.key": "存在的键" }));

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("missing.key")).toBe("missing.key");
			expect(i18n.t("missing.key", "fallback")).toBe("fallback");
		});
	});

	describe("language switching", () => {
		it("switches language at runtime", async () => {
			await fs.writeFile(path.join(tempDir, "zh-test.json"), JSON.stringify({ key: "中文" }));
			await fs.writeFile(path.join(tempDir, "en-test.json"), JSON.stringify({ key: "English" }));

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("key")).toBe("中文");
			expect(i18n.getLanguage()).toBe("zh");

			process.env.OMP_LANG = "en";
			await i18n.setLanguage("en");

			expect(i18n.t("key")).toBe("English");
			expect(i18n.getLanguage()).toBe("en");
		});
	});

	describe("metadata", () => {
		it("gets translation metadata", async () => {
			await fs.writeFile(
				path.join(tempDir, "zh-meta.json"),
				JSON.stringify({
					meta: {
						version: "1.2.3",
						completeness: 85,
						lastUpdated: "2026-06-28",
					},
				}),
			);

			const i18n = createI18n(tempDir);
			await i18n.init();

			const meta = i18n.getMeta();
			expect(meta?.version).toBe("1.2.3");
			expect(meta?.completeness).toBe(85);
			expect(meta?.lastUpdated).toBe("2026-06-28");
		});
	});

	describe("edge cases", () => {
		it("handles empty files", async () => {
			await fs.writeFile(path.join(tempDir, "zh-empty.json"), "");

			const i18n = createI18n(tempDir);
			await i18n.init();

			// 应该正常初始化，不会崩溃
			expect(i18n.getLanguage()).toBe("zh");
		});

		it("handles non-existent directory", async () => {
			await fs.rm(tempDir, { recursive: true, force: true });

			const i18n = createI18n(tempDir);
			await i18n.init();

			// 应该正常初始化，不会崩溃
			expect(i18n.getLanguage()).toBeDefined();
		});

		it("handles null values in nested structure", async () => {
			await fs.writeFile(
				path.join(tempDir, "zh-null.json"),
				JSON.stringify({
					nested: {
						value: null,
						valid: "有效值",
					},
				}),
			);

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("nested.value")).toBe("nested.value");
			expect(i18n.t("nested.valid")).toBe("有效值");
		});

		it("t() returns fallback when not initialized", () => {
			const i18n = createI18n(tempDir);

			// 未调用 init()，直接调用 t()
			expect(i18n.t("key")).toBe("key");
			expect(i18n.t("key", "fallback")).toBe("fallback");
		});

		it("reset method resets instance state", async () => {
			await fs.writeFile(path.join(tempDir, "zh-test.json"), JSON.stringify({ key: "值" }));

			const i18n = createI18n(tempDir);
			await i18n.init();

			expect(i18n.t("key")).toBe("值");

			i18n.reset();

			// 重置后未初始化，应该返回 key
			expect(i18n.t("key")).toBe("key");
		});
	});
});

describe("interceptTips", () => {
	let tempDir: string;
	const originalLang = process.env.OMP_LANG;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "intercept-tips-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		if (originalLang !== undefined) {
			process.env.OMP_LANG = originalLang;
		} else {
			delete process.env.OMP_LANG;
		}
		i18n.reset();
	});

	it("returns English tips unchanged when language is en", () => {
		process.env.OMP_LANG = "en";
		i18n.reset();

		const tips = ["Tip one", "Tip two", "Tip three"];
		const result = interceptTips(tips);

		expect(result).toEqual(tips);
	});

	it("returns translated tips for zh locale using embedded translations", () => {
		process.env.OMP_LANG = "zh";
		i18n.reset();

		// Embedded zh translations cover all TIP_KEYS, so all tips should be translated
		const enTips = ["Tired of typing? Keep going", "BTW, side question", "Tan background agent"];
		const result = interceptTips(enTips);

		// All three should be translated to embedded zh strings
		expect(result[0]).toContain("厌倦了输入");
		expect(result[1]).toContain("/btw");
		expect(result[2]).toContain("/tan");
		// And they should be non-empty Chinese strings
		for (const tip of result) {
			expect(tip).toBeTypeOf("string");
			expect(tip.length).toBeGreaterThan(0);
		}
	});

	it("overrides embedded translations with user-provided translations", async () => {
		process.env.OMP_LANG = "zh";
		await fs.writeFile(
			path.join(tempDir, "zh-tips.json"),
			JSON.stringify({
				"tips.tired_of_typing_keep_going": "自定义翻译1",
				"tips.btw_side_question": "自定义翻译2",
			}),
		);

		i18n.reset(tempDir);
		await i18n.init();

		const enTips = ["English tip 1", "English tip 2", "English tip 3"];
		const result = interceptTips(enTips);

		// First two should use user-provided translations
		expect(result[0]).toBe("自定义翻译1");
		expect(result[1]).toBe("自定义翻译2");
		// Third tip uses embedded translation (not the English original)
		expect(result[2]).not.toBe("English tip 3");
	});

	it("handles empty array", () => {
		process.env.OMP_LANG = "zh";
		i18n.reset();

		const result = interceptTips([]);

		expect(result).toEqual([]);
	});

	it("keeps extra tips in English when array is longer than TIP_KEYS", () => {
		process.env.OMP_LANG = "zh";
		i18n.reset();

		// TIP_KEYS has 26 items. Create an array with 28 items.
		const enTips = Array.from({ length: 28 }, (_, i) => `English tip ${i}`);
		const result = interceptTips(enTips);

		// First 26 should be translated (embedded zh covers all TIP_KEYS)
		for (let i = 0; i < 26; i++) {
			expect(result[i]).not.toBe(`English tip ${i}`);
		}
		// Items at index 26 and 27 have no TIP_KEYS entry, stay in English
		expect(result[26]).toBe("English tip 26");
		expect(result[27]).toBe("English tip 27");
	});
});
