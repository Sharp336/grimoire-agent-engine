import { describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { MCPTool, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { type } from "arktype";
import { createMockConnection, createMockTransport } from "../mcp-test-utils";

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

async function expectParentMCPOutboundMatchesDirect(
	definition: MCPToolDefinition,
	parentArgs: Record<string, unknown>,
	expectedArgs: Record<string, unknown>,
): Promise<void> {
	const directCalls: CapturedRequest[] = [];
	const directTool = new MCPTool(createCapturedConnection(directCalls), definition);
	await directTool.execute(
		"direct-mcp-call",
		{ ...parentArgs, [INTENT_FIELD]: "js prelude" },
		undefined,
		{} as CustomToolContext,
	);

	const parentCalls: CapturedRequest[] = [];
	const parentTool = new MCPTool(createCapturedConnection(parentCalls), definition);
	await callSessionTool(parentTool.name, parentArgs, {
		session: createSession([parentTool as unknown as AgentTool]),
	});

	expect(parentCalls).toEqual(directCalls);
	expect(parentCalls).toEqual([
		{
			method: "tools/call",
			params: { name: definition.name, arguments: expectedArgs },
		},
	]);
}

describe("callSessionTool", () => {
	it("injects js intent and summarizes text results", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "js prelude" },
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("matches direct MCP outbound arguments for parent JS sparse issue comments", async () => {
		await expectParentMCPOutboundMatchesDirect(
			{
				name: "save_comment",
				description: "Save a comment on an issue",
				inputSchema: {
					type: "object",
					properties: { body: { type: "string" }, issueId: { type: "string" } },
					required: ["body", "issueId"],
				},
			},
			{ body: "x", issueId: "ENG-1" },
			{ body: "x", issueId: "ENG-1" },
		);
	});

	it("preserves parent JS status update pairs at the MCP boundary", async () => {
		await expectParentMCPOutboundMatchesDirect(
			{
				name: "save_comment",
				description: "Save a comment on an issue",
				inputSchema: {
					type: "object",
					properties: {
						body: { type: "string" },
						issueId: { type: "string" },
						statusUpdateId: { type: "string" },
						statusUpdateType: { type: "string" },
					},
					required: ["body", "issueId"],
				},
			},
			{ body: "x", issueId: "ENG-1", statusUpdateId: "update-1", statusUpdateType: "progress" },
			{ body: "x", issueId: "ENG-1", statusUpdateId: "update-1", statusUpdateType: "progress" },
		);
	});

	it("preserves a schema-declared parent JS intent at the MCP boundary", async () => {
		await expectParentMCPOutboundMatchesDirect(
			{
				name: "echo",
				description: "Echo an intent",
				inputSchema: {
					type: "object",
					properties: { i: { type: "string" } },
					required: ["i"],
				},
			},
			{},
			{ i: "js prelude" },
		);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});
});
