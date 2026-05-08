import { describe, expect, it } from "bun:test";
import { renderTopicDetail, renderTopicList } from "@oh-my-pi/pi-coding-agent/evolution-board/renderer";
import type { EvolutionTopic } from "@oh-my-pi/pi-coding-agent/evolution-board/types";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const sampleTopic: EvolutionTopic = {
	id: "feature-dashboard",
	name: "功能进化看板",
	brief: "在 TUI 中展示 omp 二次开发任务状态",
	status: "in-progress",
	progress: 30,
	modules: ["coding-agent", "pi-tui"],
	tags: ["tui", "developer-tool"],
};

describe("EvolutionBoard Renderer", () => {
	it("renders topic list", async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const lines = renderTopicList([sampleTopic], 80, theme!);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("功能进化看板");
	});

	it("renders topic detail", async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const lines = renderTopicDetail(sampleTopic, 80, theme!);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some(l => l.includes("功能进化看板"))).toBe(true);
	});
});
