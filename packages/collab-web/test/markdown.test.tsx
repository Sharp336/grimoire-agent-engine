import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/transcript/Markdown";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}

describe("Transcript Markdown", () => {
	it("preserves assistant soft line breaks for tree-shaped prose", () => {
		const html = renderMarkdown("요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임");

		expect(html).toContain("요청 요지<br>");
		expect(html).toContain("있음<br>");
		expect(html).toContain("├── 현재 collab guest는");
		expect(html).toContain("└── 빠진 것은 guest → host 방향");
	});

	it("preserves soft line breaks inside tight list items", () => {
		const html = renderMarkdown("- Decision:\n  │   └── detail");

		expect(html).toContain("<li>Decision:<br>│   └── detail</li>");
	});

	it("continues escaping raw HTML", () => {
		const html = renderMarkdown("safe\n<img src=x onerror=alert(1)>");

		expect(html).toContain("safe<br>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
	});

	it("strips span and text HTML tags but preserves their contents and inline text rendering", () => {
		const html = renderMarkdown("<span></span><text>▃</text>");

		expect(html).toContain("▃");
		expect(html).not.toContain("&lt;span&gt;");
		expect(html).not.toContain("&lt;text&gt;");
	});

	it("unescapes HTML entities inside span and text HTML tags safely", () => {
		const html = renderMarkdown("<span>&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;</span>");

		expect(html).toContain("&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;");
	});
	it("strips advisory wrapper tags but renders their content", () => {
		const html = renderMarkdown('<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>');

		expect(html).toContain("Keep this advice.");
		expect(html).not.toContain("&lt;advisory");
		expect(html).not.toContain("&lt;/advisory&gt;");
	});

	it("renders dollar and bracket math delimiters through KaTeX", () => {
		const html = renderMarkdown("Inline $x^2$ and \\(y^2\\).\n\n$$\na^2\n$$\n\n\\[\nb^2\n\\]");

		expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
		expect(html).toContain('<annotation encoding="application/x-tex">y^2</annotation>');
		expect(html).toContain('<annotation encoding="application/x-tex">a^2</annotation>');
		expect(html).toContain('<annotation encoding="application/x-tex">b^2</annotation>');
		expect(html.match(/class="katex-display"/g)).toHaveLength(2);
	});

	it("renders a multiline matrix product as one display equation", () => {
		const html = renderMarkdown(
			"A matrix product:\n$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n\\begin{pmatrix} x \\\\ y \\end{pmatrix}\n=\n\\begin{pmatrix} ax + by \\\\ cx + dy \\end{pmatrix}\n$$",
		);

		expect(html).toContain('class="katex-display"');
		expect(html).toContain("\\begin{pmatrix} ax + by");
		expect(html).not.toContain("<p>$$");
	});

	it("leaves currency, escaped dollars, code, and unfinished math literal", () => {
		const html = renderMarkdown(
			"Prices are $20 and $30. Escaped: \\$5. Code: `$x$`. Streaming: $x. Paren: \\(x. Bracket: \\[y.",
		);

		expect(html).toContain("Prices are $20 and $30.");
		expect(html).toContain("Escaped: $5.");
		expect(html).toContain("Code: <code>$x$</code>.");
		expect(html).toContain("Streaming: $x");
		expect(html).toContain("Paren: \\(x");
		expect(html).toContain("Bracket: \\[y");
		expect(html).not.toContain('class="katex"');
	});

	it("renders valid dollar math after rejected dollar openers", () => {
		const html = renderMarkdown("Cost $20; formula $x^2$. Streaming $unfinished then $y^2$.");

		expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
		expect(html).toContain('<annotation encoding="application/x-tex">y^2</annotation>');
		expect(html.match(/class="katex"/g)).toHaveLength(2);
	});

	it("keeps a false-positive display opener in one paragraph", () => {
		const html = renderMarkdown("before\n\\[\nx");

		expect(html.match(/<p>/g)).toHaveLength(1);
		expect(html).toContain("before<br>\\[<br>x");
	});

	it("bounds user-controlled KaTeX dimensions", () => {
		const html = renderMarkdown("$\\rule{1em}{1000000em}$");

		expect(html).toContain("height:20em");
		expect(html).not.toContain("height:1000000em");
	});

	it("does not grant KaTeX trusted-link commands", () => {
		const html = renderMarkdown("$\\href{javascript:alert(1)}{click}$");

		expect(html).toContain('class="katex"');
		expect(html).not.toContain('href="javascript:');
	});

});
