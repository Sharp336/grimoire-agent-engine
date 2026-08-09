import { describe, expect, it } from "bun:test";
import { type AsciiRenderOptions, renderMermaidAscii as renderRaw } from "../../src/vendor/mermaid-ascii/ascii/index";

// Pin colorMode so assertions stay deterministic even if a concurrent or leaked
// TTY override makes the renderer auto-detect ANSI color.
function renderMermaidAscii(text: string, opts: AsciiRenderOptions = {}): string {
	return renderRaw(text, { colorMode: "none", ...opts });
}

describe("ASCII edge labels with internal spaces", () => {
	it("renders horizontal labels with clean spaces (no line bleed-through)", () => {
		const ascii = renderMermaidAscii("graph LR\n  A[Agent] -->|on Mac| B[Server]\n  A -->|on Linux| C[Cluster]");

		// Spaces between label glyphs must cover the routed line...
		expect(ascii).toContain("on Mac");
		expect(ascii).toContain("on Linux");
		// ...and the line must not show through where the space was.
		expect(ascii).not.toContain("on─Mac");
		expect(ascii).not.toContain("on─Linux");
	});

	it("keeps the path and arrowheads intact around spaced labels", () => {
		const ascii = renderMermaidAscii("graph LR\n  A[Agent] -->|on Mac| B[Server]\n  A -->|on Linux| C[Cluster]");

		// The full label rows are unchanged except the pierced spaces:
		// previously rendered as `on─Mac` / `on─Linux`.
		expect(ascii.split("\n")).toContain("│ Agent │    ├──on Mac───►│  Server │");
		expect(ascii.split("\n")).toContain("    └──────on Linux──────►│ Cluster │");
	});

	it("renders vertical labels without the edge line piercing the space", () => {
		const ascii = renderMermaidAscii("graph TD\n  A -->|to c| C\n  B -->|to d| D");

		expect(ascii).toContain("to c");
		expect(ascii).toContain("to d");
		expect(ascii).not.toContain("to│c");
		expect(ascii).not.toContain("to│d");
	});

	it("keeps wide-glyph labels (CJK and emoji) opaque across their spaces", () => {
		const ascii = renderMermaidAscii('graph LR\n  C -->|"启动 服务"| D\n  A -->|🚀 起飞| B');

		expect(ascii).toContain("启动 服务");
		expect(ascii).not.toContain("启动─服务");
		expect(ascii).toContain("🚀 起飞");
		expect(ascii).not.toContain("🚀─起飞");
	});

	it("still renders multi-line edge labels", () => {
		const ascii = renderMermaidAscii("graph TD\n  A --> B\n  A -->|Line1<br>Line2| C");

		expect(ascii).toContain("Line1");
		expect(ascii).toContain("Line2");
	});

	it("keeps the first label (including its spaces) when labels collide", () => {
		const ascii = renderMermaidAscii(["flowchart LR", "  A -->|🚀 起飞| B", "  A -->|on Mac| B"].join("\n"));

		expect(ascii).toContain("🚀 起飞");
		expect(ascii).not.toContain("on Mac");
	});
});
