import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval-render";
import { sshToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/ssh";
import { webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import { renderSearchResult, type SearchRenderDetails } from "@oh-my-pi/pi-coding-agent/web/search/render";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import type { TUI } from "@oh-my-pi/pi-tui";

function clean(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n"));
}

describe("concise tool display mode", () => {
	let theme: Theme;

	beforeAll(async () => {
		await initTheme();
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps generic fallback concise when collapsed and reveals details when expanded", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd(), overrides: { "tools.displayMode": "concise" } });
		const ui = { requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"generic_tool",
			{ _i: "Checking generic result", secretArg: "ARG_SECRET" },
			{},
			undefined,
			ui,
			process.cwd(),
		);

		component.updateResult({ content: [{ type: "text", text: '{"secret":"OUTPUT_SECRET"}' }] }, false);
		const collapsed = clean(component.render(120));

		expect(collapsed).toContain("generic_tool");
		expect(collapsed).toContain("Checking generic result");
		expect(collapsed).toMatch(/expand/i);
		expect(collapsed).not.toContain("ARG_SECRET");
		expect(collapsed).not.toContain("OUTPUT_SECRET");

		component.setExpanded(true);
		const expanded = clean(component.render(120));

		expect(expanded).toContain("ARG_SECRET");
		expect(expanded).toContain("OUTPUT_SECRET");
	});

	it("keeps bash concise when collapsed and reveals command/output when expanded", () => {
		const args = { command: "printf BASH_COMMAND_SECRET" };
		const result = {
			content: [{ type: "text", text: "BASH_OUTPUT_SECRET" }],
			details: { exitCode: 7 },
			isError: true,
		};

		const collapsed = clean(
			bashToolRenderer
				.renderResult(
					result,
					{ expanded: false, isPartial: false, displayMode: "concise", intent: "Running hidden bash" },
					theme,
					args,
				)
				.render(120),
		);

		expect(collapsed).toContain("Running hidden bash");
		expect(collapsed).toContain("Exit: 7");
		expect(collapsed).toMatch(/expand/i);
		expect(collapsed).not.toContain("BASH_COMMAND_SECRET");
		expect(collapsed).not.toContain("BASH_OUTPUT_SECRET");

		const expanded = clean(
			bashToolRenderer
				.renderResult(
					result,
					{ expanded: true, isPartial: false, displayMode: "concise", intent: "Running hidden bash" },
					theme,
					args,
				)
				.render(120),
		);

		expect(expanded).toContain("BASH_COMMAND_SECRET");
		expect(expanded).toContain("BASH_OUTPUT_SECRET");
	});

	it("keeps ssh concise when collapsed and reveals command/output when expanded", () => {
		const args = { host: "secret-host.example", command: "cat SSH_COMMAND_SECRET" };
		const result = { content: [{ type: "text", text: "SSH_OUTPUT_SECRET" }] };

		const collapsed = clean(
			sshToolRenderer
				.renderResult(
					result,
					{ expanded: false, isPartial: false, displayMode: "concise", intent: "Running hidden remote" },
					theme,
					args,
				)
				.render(120),
		);

		expect(collapsed).toContain("SSH");
		expect(collapsed).toContain("secret-host.example");
		expect(collapsed).toContain("Running hidden remote");
		expect(collapsed).not.toContain("SSH_COMMAND_SECRET");
		expect(collapsed).not.toContain("SSH_OUTPUT_SECRET");

		const failedCollapsed = clean(
			sshToolRenderer
				.renderResult(
					{ ...result, isError: true },
					{ expanded: false, isPartial: false, displayMode: "concise", intent: "Running hidden remote" },
					theme,
					args,
				)
				.render(120),
		);

		expect(failedCollapsed).toContain("Failed");
		expect(failedCollapsed).not.toContain("SSH_OUTPUT_SECRET");
		const expanded = clean(
			sshToolRenderer
				.renderResult(
					result,
					{ expanded: true, isPartial: false, displayMode: "concise", intent: "Running hidden remote" },
					theme,
					args,
				)
				.render(120),
		);

		expect(expanded).toContain("SSH_COMMAND_SECRET");
		expect(expanded).toContain("SSH_OUTPUT_SECRET");
	});

	it("keeps eval concise when collapsed and reveals code/output when expanded", () => {
		const result = {
			content: [{ type: "text", text: "EVAL_OUTPUT_SECRET" }],
			details: {
				language: "python" as const,
				languages: ["python" as const],
				cells: [
					{
						index: 0,
						code: "print('EVAL_CODE_SECRET')",
						language: "python" as const,
						output: "EVAL_OUTPUT_SECRET",
						status: "complete" as const,
						statusEvents: [],
					},
				],
			},
		};
		const args = { cells: [{ language: "py" as const, code: "print('EVAL_CODE_SECRET')" }] };

		const collapsed = clean(
			evalToolRenderer
				.renderResult(
					result,
					{ expanded: false, isPartial: false, displayMode: "concise", intent: "Running hidden cells" },
					theme,
					args,
				)
				.render(120),
		);

		expect(collapsed).toContain("Eval");
		expect(collapsed).toContain("Running hidden cells");
		expect(collapsed).not.toContain("EVAL_CODE_SECRET");
		expect(collapsed).not.toContain("EVAL_OUTPUT_SECRET");

		const expanded = clean(
			evalToolRenderer
				.renderResult(
					result,
					{ expanded: true, isPartial: false, displayMode: "concise", intent: "Running hidden cells" },
					theme,
					args,
				)
				.render(120),
		);

		expect(expanded).toContain("EVAL_CODE_SECRET");
		expect(expanded).toContain("EVAL_OUTPUT_SECRET");
	});

	it("keeps web search concise when collapsed and reveals query/answer/sources when expanded", async () => {
		const response: SearchResponse = {
			provider: "perplexity",
			answer: "WEB_ANSWER_SECRET",
			sources: [
				{ title: "WEB_SOURCE_TITLE_SECRET", url: "https://example.com/secret", snippet: "hidden snippet" },
				{ title: "Second hidden source", url: "https://example.com/second", snippet: "second snippet" },
			],
		};
		const details: SearchRenderDetails = { response };
		const result = { content: [{ type: "text", text: "WEB_ANSWER_SECRET" }], details };
		const args = { query: "WEB_QUERY_SECRET" };

		const collapsed = clean(
			renderSearchResult(
				result,
				{ expanded: false, isPartial: false, displayMode: "concise", intent: "Searching hidden web" },
				theme,
				args,
			).render(120),
		);

		expect(collapsed).toContain("Web Search");
		expect(collapsed).toContain("2 sources");
		expect(collapsed).toContain("Searching hidden web");
		expect(collapsed).not.toContain("WEB_QUERY_SECRET");
		expect(collapsed).not.toContain("WEB_ANSWER_SECRET");
		expect(collapsed).not.toContain("WEB_SOURCE_TITLE_SECRET");

		const expanded = clean(
			renderSearchResult(
				result,
				{ expanded: true, isPartial: false, displayMode: "concise", intent: "Searching hidden web" },
				theme,
				args,
			).render(120),
		);

		expect(expanded).toContain("WEB_QUERY_SECRET");
		expect(expanded).toContain("WEB_ANSWER_SECRET");
		expect(expanded).toContain("WEB_SOURCE_TITLE_SECRET");

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd(), overrides: { "tools.displayMode": "concise" } });
		const ui = { requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"web_search",
			{ _i: "Searching hidden web", query: "WEB_QUERY_SECRET" },
			{},
			webSearchCustomTool as never,
			ui,
			process.cwd(),
		);
		component.updateResult(result, false);

		const customToolCollapsed = clean(component.render(120));
		expect(customToolCollapsed).toContain("Web Search");
		expect(customToolCollapsed).toContain("2 sources");
		expect(customToolCollapsed).not.toContain("Provider: pending");
		expect(customToolCollapsed).not.toContain("Sources: pending");
		expect(customToolCollapsed).not.toContain("WEB_QUERY_SECRET");
		expect(customToolCollapsed).not.toContain("WEB_ANSWER_SECRET");
	});
});
