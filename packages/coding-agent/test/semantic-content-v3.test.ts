import { describe, expect, test } from "bun:test";
import {
	adaptSemanticRenderResultToHost,
	getSemanticContentFallback,
	MAX_SEMANTIC_CONTENT_BYTES,
	type SemanticContent,
	validateSemanticContent,
} from "@oh-my-pi/pi-coding-agent/session/semantic-content";

describe("semantic content v3", () => {
	test("accepts the host-neutral content inventory", () => {
		const content: SemanticContent = {
			version: 1,
			fallback: { format: "plain", text: "Tool completed" },
			blocks: [
				{ kind: "text", format: "markdown", text: "**Complete**" },
				{ kind: "fields", fields: [{ label: "Status", value: "complete" }] },
				{
					kind: "table",
					columns: [{ id: "name", label: "Name" }],
					rows: [{ name: "README.md" }],
				},
				{
					kind: "tree",
					nodes: [{ id: "root", label: "src", children: [{ id: "child", label: "index.ts" }] }],
				},
				{ kind: "diff", files: [{ path: "src/index.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] },
				{ kind: "file", path: "src/index.ts", location: { line: 1, column: 1 } },
				{ kind: "progress", label: "Indexing", completed: 3, total: 5, state: "running" },
				{
					kind: "form",
					formId: "options",
					fields: [{ id: "scope", label: "Scope", control: "select", options: ["focused", "broad"] }],
				},
				{
					kind: "actions",
					actions: [{ id: "apply", label: "Apply", style: "primary" }],
				},
				{ kind: "artifact", artifactId: "artifact-1", label: "Full output", mediaType: "text/plain" },
				{
					kind: "tool",
					toolCallId: "tool-call-1",
					toolName: "write",
					state: "completed",
					arguments: { path: "src/index.ts" },
					result: { changed: true },
				},
			],
		};

		expect(validateSemanticContent(content)).toEqual({ ok: true, content });
	});

	test("rejects unknown elements, duplicate actions, excessive nesting, and oversized content", () => {
		expect(
			validateSemanticContent({
				version: 1,
				fallback: { format: "plain", text: "fallback" },
				blocks: [{ kind: "terminal_escape", text: "\u001b[31mred" }],
			}),
		).toMatchObject({ ok: false, code: "unknown_semantic_element" });
		expect(
			validateSemanticContent({
				version: 1,
				fallback: { format: "plain", text: "fallback" },
				blocks: [
					{
						kind: "actions",
						actions: [
							{ id: "same", label: "One" },
							{ id: "same", label: "Two" },
						],
					},
				],
			}),
		).toMatchObject({ ok: false, code: "invalid_semantic_content" });

		let node: Record<string, unknown> = { id: "leaf", label: "leaf" };
		for (let index = 0; index < 20; index++) node = { id: `node-${index}`, label: "node", children: [node] };
		expect(
			validateSemanticContent({
				version: 1,
				fallback: { format: "plain", text: "fallback" },
				blocks: [{ kind: "tree", nodes: [node] }],
			}),
		).toMatchObject({ ok: false, code: "semantic_depth_exceeded" });

		expect(
			validateSemanticContent({
				version: 1,
				fallback: { format: "plain", text: "x".repeat(MAX_SEMANTIC_CONTENT_BYTES) },
				blocks: [],
			}),
		).toMatchObject({ ok: false, code: "semantic_size_exceeded" });
	});

	test("lets clients fall back safely when they encounter a future element", () => {
		expect(
			getSemanticContentFallback({
				version: 1,
				fallback: { format: "markdown", text: "Use **plain fallback**" },
				blocks: [{ kind: "future-widget", payload: { unknown: true } }],
			}),
		).toEqual({ format: "markdown", text: "Use **plain fallback**" });
		expect(getSemanticContentFallback({ version: 1, blocks: [] })).toBeUndefined();
	});
	test("filters unnegotiated elements with an explicit fallback and removes unavailable actions", () => {
		const result = adaptSemanticRenderResultToHost(
			{
				content: {
					version: 1,
					fallback: { format: "plain", text: "Deploy" },
					blocks: [
						{ kind: "fields", fields: [{ label: "Target", value: "prod" }] },
						{ kind: "actions", actions: [{ id: "deploy", label: "Deploy" }] },
					],
				},
				actions: new Map([["deploy", async () => undefined]]),
			},
			new Set(["fields"]),
		);

		expect(result).toEqual({
			content: {
				version: 1,
				fallback: {
					format: "plain",
					text: "Deploy\nUnsupported semantic elements: actions",
				},
				blocks: [{ kind: "fields", fields: [{ label: "Target", value: "prod" }] }],
			},
		});
	});
});
