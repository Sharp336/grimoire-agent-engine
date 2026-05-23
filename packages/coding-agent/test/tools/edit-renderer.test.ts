import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("editToolRenderer", () => {
	it("shows the target path from partial JSON while edit args stream", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				edits: [{}],
				__partialJson: '{"edits":[{"path":"packages/coding-agent/src/edit/renderer.ts","old_text":"before',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("uses hashline input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				input: "§packages/coding-agent/src/edit/renderer.ts\n»EOF\n// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("shows hashline envelope input while preview diff is not computable yet", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{
				input: ["*** Begin Patch", "§crates/pi-natives/src/shell.rs", "»EOF", "pub fn streaming_preview() {"].join(
					"\n",
				),
			},
			{},
			hashlineTool,
			uiStub,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("crates/pi-natives/src/shell.rs");
		expect(rendered).toContain("»EOF");
		expect(rendered).toContain("pub fn streaming_preview() {");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactComponent = editToolRenderer.renderCall(
			{
				input: "§foo bar.ts\n»BOF\n// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const quotedComponent = editToolRenderer.renderCall(
			{
				input: "§'baz qux.ts'\n»BOF\n// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const compactRendered = Bun.stripANSI(compactComponent.render(160).join("\n"));
		const quotedRendered = Bun.stripANSI(quotedComponent.render(160).join("\n"));
		expect(compactRendered).toContain("foo bar.ts");
		expect(quotedRendered).toContain("baz qux.ts");
	});

	it("strips canonical `§` and longer `§` runs from hashline input headers", async () => {
		const uiTheme = await getUiTheme();

		// Canonical `§PATH` form — the parser strips the marker and the
		// renderer keeps the title clean.
		const canonical = editToolRenderer.renderCall(
			{
				input: "§packages/coding-agent/src/slash-commands/builtin-registry.ts\n»BOF\n// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		// Even longer runs should still produce the clean path.
		const triple = editToolRenderer.renderCall(
			{ input: "§§§a/b/c.ts\n»BOF\n// preview" },
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const canonicalRendered = Bun.stripANSI(canonical.render(160).join("\n"));
		const tripleRendered = Bun.stripANSI(triple.render(160).join("\n"));

		expect(canonicalRendered).toContain("packages/coding-agent/src/slash-commands/builtin-registry.ts");
		expect(canonicalRendered).not.toMatch(/§packages\/coding-agent/);
		expect(tripleRendered).toContain("a/b/c.ts");
		expect(tripleRendered).not.toMatch(/§+a\/b\/c\.ts/);
	});

	it("uses hashline input headers for completed single-file result path", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/renderer.ts" }],
				details: {
					diff: "+1|// preview",
					op: "update",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{
				input: "§packages/coding-agent/src/edit/renderer.ts\n»EOF\n// preview",
			},
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain(" …");
	});
	it("shows rejection text and suppresses preview diff when correctedInput is present", async () => {
		const uiTheme = await getUiTheme();

		// Simulate a stale-anchor rejection: non-error result with empty diff,
		// correctedInput set, and a precomputed preview diff in renderContext.
		const component = editToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: "Edit rejected: 1 line has changed since the last read (marked *).\nThe edit was NOT applied. Corrected anchors: 3xx → 3yz\nRe-read the file or use the corrected anchors in your next edit call.\n\nCorrected edit block:\n@@ a/b/c.ts\n= 3yz..3yz\n|// fixed content",
					},
				],
				details: {
					diff: "",
					path: "a/b/c.ts",
					op: "update",
					correctedInput: "@@ a/b/c.ts\n= 3yz..3yz\n|// fixed content",
				},
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: {
					editMode: "hashline",
					editDiffPreview: { diff: "+1|// preview diff that should NOT appear", firstChangedLine: undefined },
				},
			},
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		// Rejection message from content must appear
		expect(rendered).toContain("Edit rejected");
		expect(rendered).toContain("NOT applied");
		// Preview diff must NOT leak through
		expect(rendered).not.toContain("preview diff that should NOT appear");
	});
});
