import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { ReadToolGroupComponent } from "../../../src/modes/components/read-tool-group";
import { createUsageRowBlock, formatUsageRow } from "../../../src/modes/components/usage-row";
import { initTheme } from "../../../src/modes/theme/theme";

const usage: Usage = {
	input: 1_000,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_050,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function plain(rendered: readonly string[]): string {
	return Bun.stripANSI(rendered.join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("formatUsageRow", () => {
	it("appends the serving model and thinking level after the metrics", () => {
		const row = formatUsageRow(
			usage,
			undefined,
			undefined,
			undefined,
			"openrouter/deepseek/deepseek-v4-pro",
			"xhigh",
		);
		expect(row.endsWith("openrouter/deepseek/deepseek-v4-pro  xhigh")).toBe(true);
	});

	it("omits the level when it is off or undefined", () => {
		const withLevel = formatUsageRow(
			usage,
			undefined,
			undefined,
			undefined,
			"openrouter/deepseek/deepseek-v4-pro",
			"off",
		);
		expect(withLevel.endsWith("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
		expect(withLevel).not.toContain("off");
		const withoutLevel = formatUsageRow(
			usage,
			undefined,
			undefined,
			undefined,
			"openrouter/deepseek/deepseek-v4-pro",
			undefined,
		);
		expect(withoutLevel).toBe(withLevel);
	});

	it("renders nothing extra without a model", () => {
		const bare = formatUsageRow(usage);
		expect(formatUsageRow(usage, undefined, undefined, undefined, undefined, undefined)).toBe(bare);
	});
});

describe("createUsageRowBlock", () => {
	it("renders model and level in the block text", () => {
		const text = plain(createUsageRowBlock(usage, undefined, undefined, undefined, "p/m", "high").render(120));
		expect(text).toContain("p/m");
		expect(text).toContain("high");
	});
});

describe("ReadToolGroupComponent attachUsage", () => {
	it("renders model and level on the compact group row", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: false });
		group.updateArgs({ path: "file.ts" }, "c1");
		group.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false, "c1");
		expect(group.attachUsage(["c1"], usage, undefined, undefined, undefined, "p/m", "high")).toBe(true);
		const text = plain(group.render(120));
		expect(text).toContain("p/m");
		expect(text).toContain("high");
	});
});
