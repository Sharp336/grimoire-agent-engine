/**
 * tool_selection sub-flow — runtime implementation.
 *
 * When the model calls the `tool_selection` node from a parent scope, a
 * new frame is pushed. Inside that frame the model sees five real tools
 * (search_tools, describe_tool, select_tool, drop_tool, ret) that the
 * strategy injects dynamically while the frame is on top of the stack.
 *
 * Selections are recorded on the PARENT frame's attachment set — a map
 * `parentFrameId → Set<string>` owned by the strategy. When the parent
 * resumes after `ret`, the strategy merges the attachment set into the
 * parent's resolved tool list. Attachments live only as long as the
 * parent frame, and disappear when it itself closes.
 *
 * Scratch messages inside the tool_selection frame (search results,
 * describe output) are pocket-only: they never survive past the ret.
 */

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

export const TOOL_SELECTION_NODE_ID = "tool_selection";

export const TOOL_SELECTION_TOOL_NAMES = [
	"search_tools",
	"describe_tool",
	"select_tool",
	"drop_tool",
	"ret",
] as const;

export type ToolSelectionToolName = (typeof TOOL_SELECTION_TOOL_NAMES)[number];

/** Strategy-side API the scene-local tools need to do their job. */
export interface ToolSelectionBackend {
	/** Full catalog: every tool name the agent could possibly expose. */
	listCatalog(): { name: string; description: string }[];
	/** Attach a tool to the parent frame's attachment set. */
	attach(name: string): { ok: boolean; reason?: string };
	/** Detach a tool from the parent frame's attachment set. */
	detach(name: string): { ok: boolean; reason?: string };
	/** Read the parent frame's current attachment set. */
	currentAttachments(): string[];
	/** Signal: the model wants to return from this frame now. */
	requestRet(value?: string): void;
}

// ──────────────────────────────────────────────────────────────────────────
// Tool factories
// ──────────────────────────────────────────────────────────────────────────

const searchSchema = Type.Object({
	query: Type.String({ description: "substring or simple glob to match against tool names" }),
});

const describeSchema = Type.Object({
	name: Type.String({ description: "exact tool name to describe" }),
});

const selectSchema = Type.Object({
	name: Type.String({ description: "exact tool name to attach to the parent scope" }),
});

const dropSchema = Type.Object({
	name: Type.String({ description: "exact tool name to detach from the parent scope" }),
});

const retSchema = Type.Object({
	value: Type.String({ minLength: 1, description: "REQUIRED — concrete summary of what you accomplished or selected. This is the only information the caller will see." }),
});

export function createToolSelectionTools(backend: ToolSelectionBackend): AgentTool<any>[] {
	return [
		{
			name: "search_tools",
			label: "SearchTools",
			description:
				"Search the tool catalog by substring. Returns matching tool names. The result is scratch — it dies when you `ret` from this frame, so any tool you want must be `select_tool`-ed before ret.",
			parameters: searchSchema,
			strict: true,
			concurrency: "shared",
			async execute(_id: string, params: Static<typeof searchSchema>): Promise<AgentToolResult> {
				const needle = params.query.toLowerCase();
				const hits = backend.listCatalog().filter(t => t.name.toLowerCase().includes(needle));
				const text = hits.length ? hits.map(t => t.name).join("\n") : "(no matches)";
				return { content: [{ type: "text", text }], details: { hits } };
			},
		},
		{
			name: "describe_tool",
			label: "DescribeTool",
			description: "Return the full description of a tool by exact name without attaching it.",
			parameters: describeSchema,
			strict: true,
			concurrency: "shared",
			async execute(_id: string, params: Static<typeof describeSchema>): Promise<AgentToolResult> {
				const entry = backend.listCatalog().find(t => t.name === params.name);
				if (!entry) {
					return {
						content: [{ type: "text", text: `describe_tool: unknown tool "${params.name}"` }],
						details: { found: false },
					};
				}
				return {
					content: [{ type: "text", text: `${entry.name}\n\n${entry.description}` }],
					details: { found: true, name: entry.name },
				};
			},
		},
		{
			name: "select_tool",
			label: "SelectTool",
			description:
				"Attach a tool to the PARENT frame. The tool becomes callable in the caller as soon as this frame rets. The attachment lives on the parent frame and disappears when the parent itself closes.",
			parameters: selectSchema,
			strict: true,
			concurrency: "exclusive",
			async execute(_id: string, params: Static<typeof selectSchema>): Promise<AgentToolResult> {
				const res = backend.attach(params.name);
				return {
					content: [
						{ type: "text", text: res.ok ? `Attached \`${params.name}\` to parent scope.` : `select_tool: ${res.reason ?? "failed"}` },
					],
					details: res,
				};
			},
		},
		{
			name: "drop_tool",
			label: "DropTool",
			description: "Remove a tool from the parent frame's attachment set.",
			parameters: dropSchema,
			strict: true,
			concurrency: "exclusive",
			async execute(_id: string, params: Static<typeof dropSchema>): Promise<AgentToolResult> {
				const res = backend.detach(params.name);
				return {
					content: [
						{ type: "text", text: res.ok ? `Detached \`${params.name}\`.` : `drop_tool: ${res.reason ?? "failed"}` },
					],
					details: res,
				};
			},
		},
		{
			name: "ret",
			label: "Ret",
			description:
				"Close the current frame and return control to the caller. `value` is REQUIRED — summarize which tools you attached and why. Any scratch in this frame is discarded; only the attached tools and your summary survive in the parent.",
			parameters: retSchema,
			strict: true,
			concurrency: "exclusive",
			async execute(_id: string, params: Static<typeof retSchema>): Promise<AgentToolResult> {
				const selected = backend.currentAttachments();
				backend.requestRet(params.value);
				return {
					content: [
						{
							type: "text",
							text: `Returning with ${selected.length} attached tool(s): ${selected.join(", ") || "(none)"}`,
						},
					],
					details: { attached: selected },
				};
			},
		},
	];
}
