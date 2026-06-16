import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CONCEPT_TYPE,
	deriveDescription,
	ensureConformance,
	isValid,
	OkfDocumentError,
	parse,
	RESERVED_FILENAMES,
	serialize,
	validate,
} from "../../src/okf/document";

describe("okf/document.parse", () => {
	it("parses frontmatter + body", () => {
		const text = `---
type: Playbook
title: Incident Response
description: freshness alert, oncall, orders pipeline
tags: [oncall, incident]
---

# Steps

1. Check the dashboard.`;

		const doc = parse(text);
		expect(doc.frontmatter.type).toBe("Playbook");
		expect(doc.frontmatter.title).toBe("Incident Response");
		expect(doc.frontmatter.tags).toEqual(["oncall", "incident"]);
		expect(doc.body).toContain("# Steps");
		expect(doc.body).toContain("Check the dashboard.");
	});

	it("preserves extension keys", () => {
		const text = `---
type: Table
okf_version: "0.1"
custom_key: custom value
---

Body.`;
		const doc = parse(text, "tables/orders.md");
		expect(doc.frontmatter.okf_version).toBe("0.1");
		expect(doc.frontmatter.custom_key).toBe("custom value");
	});

	it("returns empty frontmatter when no block present", () => {
		const doc = parse("Just a body, no frontmatter.");
		expect(Object.keys(doc.frontmatter)).toHaveLength(0);
		expect(doc.body).toBe("Just a body, no frontmatter.");
	});

	it("throws on unterminated frontmatter", () => {
		expect(() => parse("---\ntype: Foo\n\nbody without closing delim")).toThrow(OkfDocumentError);
	});

	it("throws on invalid YAML", () => {
		expect(() => parse("---\ntype: [unclosed\n---\nbody")).toThrow(OkfDocumentError);
	});
});

describe("okf/document.serialize", () => {
	it("produces deterministic key order (recommended first, then extras)", () => {
		const doc = {
			frontmatter: {
				type: "Metric",
				tags: ["revenue"],
				title: "Weekly Revenue",
				zebra_key: "last",
				apple_key: "first",
			},
			body: "Body.",
		};
		const out = serialize(doc);
		const fmBlock = out.slice(0, out.indexOf("\n---"));
		// type should come before title (recommended order)
		expect(fmBlock.indexOf("type:")).toBeLessThan(fmBlock.indexOf("title:"));
		// extras should be alphabetical: apple_key before zebra_key
		expect(fmBlock.indexOf("apple_key")).toBeLessThan(fmBlock.indexOf("zebra_key"));
	});

	it("serializes frontmatter in block YAML style", () => {
		const out = serialize({
			frontmatter: {
				type: "Table",
				description: "orders, schema",
				tags: ["orders", "schema"],
			},
			body: "Body.",
		});
		const fmBlock = out.slice(0, out.indexOf("\n---", 4));
		expect(fmBlock).toContain("\ntype: Table");
		expect(fmBlock).toContain('\ndescription: "orders, schema"');
		expect(fmBlock).toContain("tags: \n  - orders\n  - schema");
		expect(fmBlock).not.toContain("{type:");
	});

	it("round-trips parse → serialize → parse", () => {
		const original = `---
type: Reference
title: Test
description: a, b, c
---

# Heading

Content here.`;
		const parsed = parse(original);
		const serialised = serialize(parsed);
		const reparsed = parse(serialised);
		expect(reparsed.frontmatter.type).toBe("Reference");
		expect(reparsed.frontmatter.title).toBe("Test");
		expect(reparsed.body).toContain("# Heading");
	});

	it("ends with a trailing newline", () => {
		const out = serialize({ frontmatter: { type: "T" }, body: "body" });
		expect(out.endsWith("\n")).toBe(true);
	});
});

describe("okf/document.validate", () => {
	it("passes with a non-empty type", () => {
		validate({ frontmatter: { type: "Playbook" }, body: "" });
	});

	it("throws when type is missing", () => {
		expect(() => validate({ frontmatter: { type: "" } as never, body: "" })).toThrow(OkfDocumentError);
	});

	it("throws when type is empty", () => {
		expect(() => validate({ frontmatter: { type: "   " }, body: "" })).toThrow(OkfDocumentError);
	});

	it("isValid returns false for missing type", () => {
		expect(isValid({ frontmatter: { type: "" } as never, body: "" })).toBe(false);
		expect(isValid({ frontmatter: { type: "X" }, body: "" })).toBe(true);
	});
});

describe("okf/document.ensureConformance", () => {
	it("adds default type when missing", () => {
		const text = "Some body content without frontmatter.";
		const result = ensureConformance("cat/topic.md", text);
		expect(result.type).toBe(DEFAULT_CONCEPT_TYPE);
		expect(result.changed).toBe(true);
		const reparsed = parse(result.content);
		expect(reparsed.frontmatter.type).toBe(DEFAULT_CONCEPT_TYPE);
	});

	it("derives a tag-based description when missing", () => {
		const text = `---
type: Reference
---

# LSP Configuration
- The LSP client manages language servers
- Config lives in lsp/defaults.json`;
		const result = ensureConformance("coding-agent/lsp-config.md", text);
		const reparsed = parse(result.content);
		expect(reparsed.frontmatter.description).toBeDefined();
		expect(reparsed.frontmatter.description as string).toContain("lsp");
	});

	it("preserves an existing tag-based description", () => {
		const text = `---
type: Reference
description: lsp, defaults, language servers, config
---

# LSP`;
		const result = ensureConformance("coding-agent/lsp.md", text);
		const reparsed = parse(result.content);
		expect(reparsed.frontmatter.description).toBe("lsp, defaults, language servers, config");
	});

	it("reports unchanged when already conformant", () => {
		const text = `---
type: Reference
description: tags, here
---

Body.
`;
		const result = ensureConformance("cat/topic.md", text);
		expect(result.changed).toBe(false);
	});
});

describe("okf/document.deriveDescription", () => {
	it("includes category and topic as tags", () => {
		const desc = deriveDescription("coding-agent/session-mgmt.md", "# Heading\nBody text.");
		expect(desc).toContain("coding");
		expect(desc).toContain("session");
	});

	it("extracts tags from headings", () => {
		const desc = deriveDescription("cat/topic.md", "# Incident Response\n## Freshness Alert");
		expect(desc.toLowerCase()).toContain("incident response");
	});

	it("falls back to humanised topic when body is empty", () => {
		const desc = deriveDescription("cat/my-topic-name.md", "");
		expect(desc.length).toBeGreaterThan(0);
	});
});

describe("okf/document.RESERVED_FILENAMES", () => {
	it("includes index.md and log.md", () => {
		expect(RESERVED_FILENAMES.has("index.md")).toBe(true);
		expect(RESERVED_FILENAMES.has("log.md")).toBe(true);
	});

	it("does not include regular concept files", () => {
		expect(RESERVED_FILENAMES.has("orders.md")).toBe(false);
	});
});
