import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "ast_edit: edit foo.ts",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://resolve");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders xd://reject discard cards with reject semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "not right" },
							inner: { action: "discard", reason: "not right", sourceToolName: "edit" },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://reject");
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("defaults a running xd://reject to discard before details arrive", () => {
		const html = renderToStaticMarkup(
			<ToolView name="reject" defaultOpen running args={{ reason: "" }} />,
		);

		expect(html).toContain("proposed → rejected");
	});

	it("renders xd://propose plan metadata from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "ship it" },
							inner: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://propose");
		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});

	it("routes the hub-family alias irc through the messaging renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="irc" defaultOpen args={{ op: "send", to: "Main", message: "hi" }} result={{ content: [] }} />,
		);

		expect(html).toContain("→ Main");
		// Not the generic JSON dump of the args.
		expect(html).not.toContain("tv-out-title");
	});

	it("routes the hub-family alias job through the job renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="job" defaultOpen args={{ poll: ["a1b2"] }} result={{ content: [] }} />,
		);

		expect(html).toContain("poll a1b2");
		expect(html).not.toContain("tv-out-title");
	});
});

describe("ToolView browser URLs", () => {
	it("renders browser tool URLs intact without path-shortening", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="browser"
				defaultOpen
				args={{ action: "open", url: "https://example.com/a/b/c" }}
				result={{ content: [] }}
			/>,
		);

		// Scheme + host must survive — shortenPath would have produced "https:/…/b/c".
		expect(html).toContain("https://example.com");
		expect(html).not.toContain("…/b/c");
	});
});

describe("ToolView glob scopes", () => {
	it("renders semicolon-delimited glob scopes intact without middle-eliding", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "src/**/*.ts; test/**/*.ts" }}
				result={{ content: [] }}
			/>,
		);

		// Both scopes must survive — shortenPath would have produced "src/…/**/*.ts".
		expect(html).toContain("src/**/*.ts; test/**/*.ts");
		expect(html).not.toContain("…");
	});

	it("renders scheme-bearing glob scopes intact without corrupting the scheme", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "memory://root/skills/**/*.md" }}
				result={{ content: [] }}
			/>,
		);

		// Scheme + path must survive — shortenPath would have produced "memory:/…/**/*.md".
		expect(html).toContain("memory://root/skills/**/*.md");
		expect(html).not.toContain("…");
	});

	it("renders brace-glob scopes with their alternatives intact", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "src/features/{admin,user}/pages/index.tsx" }}
				result={{ content: [] }}
			/>,
		);

		// `{` is a glob metacharacter — elision would hide which alternatives
		// were searched ("src/…/pages/index.tsx").
		expect(html).toContain("src/features/{admin,user}/pages/index.tsx");
		expect(html).not.toContain("…");
	});

	it("renders a multi-pattern glob result scope badge with every pattern intact", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "src/**/*.ts" }}
				result={{ content: [], details: { scopePath: "src/**/*.ts, test/**/*.ts" } }}
			/>,
		);

		// The comma-joined display has >4 segments — shortenPath would have
		// produced "src/…/**/*.ts", hiding the second pattern.
		expect(html).toContain("in src/**/*.ts, test/**/*.ts");
		expect(html).not.toContain("…");
	});
});

describe("ToolView grep scopes", () => {
	it("renders deep and scheme-bearing grep scopes intact", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="grep"
				defaultOpen
				args={{ pattern: "foo", path: ["src/deep/nested/path/**/*.ts", "memory://root/skills/**/*.md"] }}
				result={{ content: [] }}
			/>,
		);

		// Both scopes must survive — shortenPath would have produced
		// "src/…/**/*.ts" and corrupted the scheme to "memory:/…/**/*.md".
		expect(html).toContain("src/deep/nested/path/**/*.ts");
		expect(html).toContain("memory://root/skills/**/*.md");
		expect(html).not.toContain("…");
	});
});

describe("ToolView home redaction", () => {
	it("renders a glob scope under a home directory home-relative without leaking the username", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "/home/alice/project/src/**/*.ts" }}
				result={{ content: [] }}
			/>,
		);

		// Home prefix is redacted to ~ even though the value carries glob
		// metacharacters (the early return used to skip redaction entirely).
		expect(html).toContain("~/project/src/**/*.ts");
		expect(html).not.toContain("/home/alice");
		expect(html).not.toContain("alice/");
		// The glob pattern itself stays intact.
		expect(html).toContain("**/*.ts");
	});

	it("renders a bracketed literal path under a home directory home-relative", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "/home/alice/project/apps/[id]/page.tsx" }}
				result={{ content: [] }}
			/>,
		);

		// The `[id]` bracket is a glob metacharacter, so elision is skipped —
		// but home redaction still applies.
		expect(html).toContain("~/project/apps/[id]/page.tsx");
		expect(html).not.toContain("/home/alice");
		expect(html).not.toContain("alice/");
	});

	it("redacts the username from a scheme-prefixed home path", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="glob"
				defaultOpen
				args={{ path: "file:///home/alice/project/**/*.ts" }}
				result={{ content: [] }}
			/>,
		);

		// The `://` early return must not skip home redaction.
		expect(html).toContain("file://~/project/**/*.ts");
		expect(html).not.toContain("/home/alice");
		expect(html).not.toContain("alice/");
	});
});

describe("ToolView UNC paths", () => {
	it("retains the server/share root of a UNC path through elision", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="inspect_image"
				defaultOpen
				args={{ path: "//server/share/file.ts" }}
				result={{ content: [] }}
			/>,
		);

		// The server name must survive — the old elision produced "/…/share/file.ts".
		expect(html).toContain("server");
		expect(html).toContain("share");
		expect(html).toContain("//server/share/file.ts");
	});
});
