import { beforeAll, describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const HINT = "Install prettier for pretty formatting";

let theme: Theme;

function render(component: { render(width: number): readonly string[] }, width = 120): string {
	return sanitizeText(component.render(width).join("\n"));
}

function withThemeOptions(
	opts: RenderResultOptions & { sourceFormatterHint?: string },
): RenderResultOptions & { renderContext?: { sourceFormatterHint?: string } } {
	const { sourceFormatterHint, ...base } = opts;
	return {
		...base,
		renderContext: sourceFormatterHint === undefined ? undefined : { sourceFormatterHint },
	};
}

describe("formatter note in code-cell/eval top bars", () => {
	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
	});

	it("shows formatter hint in the pending code-cell call header", () => {
		const component = evalToolRenderer.renderCall(
			{
				cells: [{ language: "py", code: "print(42)", title: "Cell 0" }],
			},
			withThemeOptions({ expanded: false, isPartial: true, sourceFormatterHint: HINT }),
			theme,
		);
		expect(render(component)).toContain(HINT);
		expect(render(component)).toContain("Cell 0");
		expect(render(component)).toContain("print(42)");
	});

	it("omits formatter hint in pending code-cell call when context is missing", () => {
		const component = evalToolRenderer.renderCall(
			{
				cells: [{ language: "py", code: "print(42)", title: "Cell 0" }],
			},
			withThemeOptions({ expanded: false, isPartial: true }),
			theme,
		);
		expect(render(component)).not.toContain(HINT);
		expect(render(component)).toContain("Cell 0");
	});

	it("shows formatter hint in completed eval cell result headers", () => {
		const component = evalToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [
						{ index: 0, title: "Cell 0", code: "print(42)", language: "python", output: "", status: "complete" },
					],
				},
			},
			withThemeOptions({ expanded: false, isPartial: false, sourceFormatterHint: HINT }),
			theme,
			{ language: "py", code: "print(42)", title: "Cell 0" },
		);
		expect(render(component)).toContain(HINT);
		expect(render(component)).toContain("Cell 0");
	});

	it("omits formatter hint in completed eval cell result headers", () => {
		const component = evalToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [
						{ index: 0, title: "Cell 0", code: "print(42)", language: "python", output: "", status: "complete" },
					],
				},
			},
			withThemeOptions({ expanded: false, isPartial: false }),
			theme,
			{ language: "py", code: "print(42)", title: "Cell 0" },
		);
		expect(render(component)).not.toContain(HINT);
		expect(render(component)).toContain("Cell 0");
	});
});

describe("formatter note in bash call and result top bars", () => {
	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
	});

	it("shows formatter hint in the pending bash header and keeps the command text", () => {
		const component = bashToolRenderer.renderCall(
			{ command: "echo hello-world" },
			withThemeOptions({ expanded: false, isPartial: true, sourceFormatterHint: HINT }),
			theme,
		);
		expect(render(component)).toContain(HINT);
		expect(render(component)).toContain("Bash");
		expect(render(component)).toContain("echo hello-world");
	});

	it("omits formatter note in pending bash when context is missing", () => {
		const component = bashToolRenderer.renderCall(
			{ command: "echo hello-world" },
			withThemeOptions({ expanded: false, isPartial: true }),
			theme,
		);
		expect(render(component)).not.toContain(HINT);
		expect(render(component)).toContain("echo hello-world");
	});

	it("shows formatter hint in completed bash result header and keeps title", () => {
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "ok" }], details: { timeoutSeconds: 1 }, isError: false },
			withThemeOptions({ expanded: false, isPartial: false, sourceFormatterHint: HINT }),
			theme,
			{ command: "echo hello-world" },
		);
		expect(render(component)).toContain(HINT);
		expect(render(component)).toContain("Bash");
		expect(render(component)).toContain("echo hello-world");
	});

	it("omits formatter note in completed bash result header when context is missing", () => {
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "ok" }], details: { timeoutSeconds: 1 }, isError: false },
			withThemeOptions({ expanded: false, isPartial: false }),
			theme,
			{ command: "echo hello-world" },
		);
		expect(render(component)).not.toContain(HINT);
		expect(render(component)).toContain("echo hello-world");
	});
});

describe("formatter note in write top bars", () => {
	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
	});

	it("shows formatter hint in the pending write header and retains path text", () => {
		const component = writeToolRenderer.renderCall(
			{ file_path: "README.md", content: "hello" },
			withThemeOptions({ expanded: false, isPartial: true, sourceFormatterHint: HINT }),
			theme,
		);
		expect(component).toBeDefined();
		expect(render(component!)).toContain(HINT);
		expect(render(component!)).toContain("README.md");
		expect(render(component!)).toContain("hello");
	});

	it("omits formatter hint in the pending write header without context", () => {
		const component = writeToolRenderer.renderCall(
			{ file_path: "README.md", content: "hello" },
			withThemeOptions({ expanded: false, isPartial: true }),
			theme,
		);
		expect(component).toBeDefined();
		expect(render(component!)).not.toContain(HINT);
		expect(render(component!)).toContain("README.md");
	});

	it("shows formatter hint in completed write header and retains path text", () => {
		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { resolvedPath: "/tmp/project/README.md" },
				isError: false,
			},
			withThemeOptions({ expanded: false, isPartial: false, sourceFormatterHint: HINT }),
			theme,
			{ file_path: "README.md", content: "hello" },
		);
		expect(render(component)).toContain(HINT);
		expect(render(component)).toContain("README.md");
	});

	it("omits formatter hint in completed write header without context", () => {
		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { resolvedPath: "/tmp/project/README.md" },
				isError: false,
			},
			withThemeOptions({ expanded: false, isPartial: false }),
			theme,
			{ file_path: "README.md", content: "hello" },
		);
		expect(render(component)).not.toContain(HINT);
		expect(render(component)).toContain("README.md");
	});
});
