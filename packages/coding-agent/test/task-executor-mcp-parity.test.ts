import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { createMCPProxyTools } from "../src/task/executor";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const issueCommentDefinition: MCPToolDefinition = {
	name: "save_comment",
	description: "Save a comment on an issue",
	inputSchema: {
		type: "object",
		properties: {
			body: { type: "string" },
			issueId: { type: "string" },
			optionalString: { type: "string" },
			optionalObject: { type: "object" },
			optionalUndefined: { type: "string" },
			count: { type: "number" },
			enabled: { type: "boolean" },
			statusUpdateId: { type: "string" },
			statusUpdateType: { type: "string" },
		},
		required: ["body", "issueId"],
	},
};

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text" as const, text: "ok" }], isError: false }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

function createProxy(source: CustomTool, connection: MCPServerConnection): CustomTool {
	const manager = new MCPManager(process.cwd());
	vi.spyOn(manager, "getTools").mockReturnValue([source]);
	vi.spyOn(manager, "waitForConnection").mockResolvedValue(connection);
	const proxy = createMCPProxyTools(manager)[0];
	if (!proxy) throw new Error("Expected an MCP proxy tool");
	return proxy;
}

function mockTransport(requestFn: (...args: Parameters<MCPTransport["request"]>) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: requestFn as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
}

function makeConnection(transport: MCPTransport, name: string): MCPServerConnection {
	return {
		name,
		config: { type: "stdio", command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities: { tools: {} },
	};
}

function createFakeMCPTool(execute: CustomTool["execute"], strict: boolean): CustomTool {
	return {
		name: "mcp__test_server_save_comment",
		label: "test-server/save_comment",
		description: "Save a comment on an issue",
		strict,
		mcpToolName: "save_comment",
		mcpServerName: "test-server",
		parameters: { type: "object", properties: {} } as CustomTool["parameters"],
		execute,
	};
}

describe("task MCP proxy parity", () => {
	it("omits optional placeholders while preserving zero and false on task issue comments", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = new MCPTool(connection, issueCommentDefinition);
		const proxy = createProxy(source, connection);

		await proxy.execute(
			"task-call-1",
			{
				body: "x",
				issueId: "ENG-1",
				optionalString: "",
				optionalObject: {},
				optionalUndefined: undefined,
				count: 0,
				enabled: false,
				[INTENT_FIELD]: "js prelude",
			},
			undefined,
			{} as CustomToolContext,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "save_comment",
					arguments: { body: "x", issueId: "ENG-1", count: 0, enabled: false },
				},
			},
		]);
	});

	it("strips the harness intent from sparse task issue comments", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = new MCPTool(connection, issueCommentDefinition);
		const proxy = createProxy(source, connection);

		await proxy.execute(
			"task-call-2",
			{ body: "x", issueId: "ENG-1", [INTENT_FIELD]: "js prelude" },
			undefined,
			{} as CustomToolContext,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "save_comment", arguments: { body: "x", issueId: "ENG-1" } },
			},
		]);
	});

	it("preserves a nonempty task status update pair", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = new MCPTool(connection, issueCommentDefinition);
		const proxy = createProxy(source, connection);

		await proxy.execute(
			"task-call-3",
			{ body: "x", issueId: "ENG-1", statusUpdateId: "update-1", statusUpdateType: "progress" },
			undefined,
			{} as CustomToolContext,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "save_comment",
					arguments: {
						body: "x",
						issueId: "ENG-1",
						statusUpdateId: "update-1",
						statusUpdateType: "progress",
					},
				},
			},
		]);
	});

	it("preserves a schema-declared task i argument", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = new MCPTool(connection, {
			name: "echo",
			description: "Echo an intent",
			inputSchema: {
				type: "object",
				properties: { i: { type: "string" } },
				required: ["i"],
			},
		});
		const proxy = createProxy(source, connection);

		await proxy.execute("task-call-4", { i: "server intent" }, undefined, {} as CustomToolContext);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "server intent" } } }]);
	});

	it("delegates the original execution tuple with the task combined signal", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const sourceResult = { content: [{ type: "text" as const, text: "source result" }] };
		const sourceExecute = vi.fn<CustomTool["execute"]>(async () => sourceResult);
		const source = createFakeMCPTool(sourceExecute as CustomTool["execute"], false);
		const proxy = createProxy(source, connection);
		const toolCallId = "task-call-5";
		const params = { body: "x" };
		const onUpdate = () => {};
		const context = {} as CustomToolContext;
		const caller = new AbortController();

		await proxy.execute(toolCallId, params, onUpdate, context, caller.signal);

		expect(sourceExecute).toHaveBeenCalledTimes(1);
		const forwarded = sourceExecute.mock.calls[0];
		expect(forwarded?.[0]).toBe(toolCallId);
		expect(forwarded?.[1]).toBe(params);
		expect(forwarded?.[2]).toBe(onUpdate);
		expect(forwarded?.[3]).toBe(context);
		expect(forwarded?.[4]).toBeDefined();
		expect(forwarded?.[4]).not.toBe(caller.signal);
		expect((forwarded?.[4] as AbortSignal | undefined)?.aborted).toBe(false);
		caller.abort();
		expect((forwarded?.[4] as AbortSignal | undefined)?.aborted).toBe(true);
	});

	it("returns the complete source result unchanged", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const sourceResult = {
			content: [{ type: "text" as const, text: "source error" }],
			isError: true,
			details: {
				serverName: "test-server",
				mcpToolName: "save_comment",
				isError: true,
				rawContent: [
					{ type: "text" as const, text: "source error" },
					{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
				],
				provider: "source-provider",
				providerName: "Source Provider",
			},
		};
		const source = createFakeMCPTool(async () => sourceResult, false);
		const proxy = createProxy(source, connection);

		const result = await proxy.execute("task-call-6", {}, undefined, {} as CustomToolContext);

		expect(result).toBe(sourceResult);
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			serverName: "test-server",
			mcpToolName: "save_comment",
			isError: true,
			rawContent: [
				{ type: "text", text: "source error" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			provider: "source-provider",
			providerName: "Source Provider",
		});
	});

	it("resolves local URLs through the source task context", async () => {
		using tempDir = TempDir.createSync("@pi-task-mcp-local-");
		const artifactsDir = tempDir.join("artifacts");
		const writtenPath = path.join(artifactsDir, "local", "issue-attachment.txt");
		await Bun.write(writtenPath, "attachment");
		const expectedPath = await fs.realpath(writtenPath);
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = new MCPTool(connection, {
			name: "attach_file",
			description: "Attach a file",
			inputSchema: {
				type: "object",
				properties: { file: { type: "string" } },
				required: ["file"],
			},
		});
		const proxy = createProxy(source, connection);
		const context = {
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "task-session",
			},
		} as CustomToolContext;

		await proxy.execute("task-call-7", { file: "local://issue-attachment.txt" }, undefined, context);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "attach_file", arguments: { file: expectedPath } },
			},
		]);
	});

	it("reuses the source reconnect behavior after a task MCP transport failure", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const oldConnection = makeConnection(
			mockTransport(async () => {
				oldCalls++;
				throw new Error("ECONNREFUSED");
			}),
			"test-server",
		);
		const newConnection = makeConnection(
			mockTransport(async () => {
				newCalls++;
				return { content: [{ type: "text" as const, text: "reconnected" }], isError: false };
			}),
			"reconnected-server",
		);
		const source = new MCPTool(oldConnection, issueCommentDefinition, async () => {
			reconnects++;
			return newConnection;
		});
		const proxy = createProxy(source, oldConnection);

		const result = await proxy.execute(
			"task-call-8",
			{ body: "x", issueId: "ENG-1" },
			undefined,
			{} as CustomToolContext,
		);

		expect(reconnects).toBe(1);
		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: "reconnected" }]);
	});

	it("routes a pre-existing proxy to the replacement MCP source without reconnecting the stale source", async () => {
		let staleCalls = 0;
		let replacementCalls = 0;
		let staleReconnects = 0;
		let replacementTeardowns = 0;
		const replacementRequests: CapturedRequest[] = [];
		const staleConnection = makeConnection(
			mockTransport(async () => {
				staleCalls++;
				throw new Error("ECONNREFUSED stale connection");
			}),
			"test-server",
		);
		const replacementTransport = mockTransport(async (method, params) => {
			replacementCalls++;
			replacementRequests.push({ method, params });
			return { content: [{ type: "text" as const, text: "replacement result" }], isError: false };
		});
		const replacementConnection = makeConnection(replacementTransport, "test-server");
		replacementTransport.close = async () => {
			replacementTeardowns++;
		};
		const staleSource = new MCPTool(staleConnection, issueCommentDefinition, async () => {
			staleReconnects++;
			await replacementConnection.transport.close();
			return replacementConnection;
		});
		const replacementSource = new MCPTool(replacementConnection, issueCommentDefinition);
		const replacementExecute = vi.spyOn(replacementSource, "execute");
		const manager = new MCPManager(process.cwd());
		let currentTools: CustomTool[] = [staleSource];
		vi.spyOn(manager, "getTools").mockImplementation(() => currentTools);
		const proxy = createMCPProxyTools(manager)[0];
		if (!proxy) throw new Error("Expected an MCP proxy tool");

		currentTools = [replacementSource];
		const toolCallId = "task-call-after-reconnect";
		const params = { body: "replacement", issueId: "ENG-317" };
		const onUpdate = () => {};
		const context = {} as CustomToolContext;
		const caller = new AbortController();

		const result = await proxy.execute(toolCallId, params, onUpdate, context, caller.signal);

		expect({ staleCalls, staleReconnects, replacementTeardowns }).toEqual({
			staleCalls: 0,
			staleReconnects: 0,
			replacementTeardowns: 0,
		});
		expect(replacementCalls).toBe(1);
		expect(replacementRequests).toEqual([
			{
				method: "tools/call",
				params: { name: "save_comment", arguments: params },
			},
		]);
		expect(result.content).toEqual([{ type: "text", text: "replacement result" }]);
		const forwarded = replacementExecute.mock.calls[0];
		expect(forwarded?.[0]).toBe(toolCallId);
		expect(forwarded?.[1]).toBe(params);
		expect(forwarded?.[2]).toBe(onUpdate);
		expect(forwarded?.[3]).toBe(context);
		expect(forwarded?.[4]).toBeDefined();
		expect(forwarded?.[4]).not.toBe(caller.signal);
		expect((forwarded?.[4] as AbortSignal | undefined)?.aborted).toBe(false);
	});
	it("routes a pre-existing proxy by raw MCP server and tool identity when normalized names collide", async () => {
		const sourceARequests: CapturedRequest[] = [];
		const collidingBRequests: CapturedRequest[] = [];
		const sourceAConnection = makeConnection(
			mockTransport(async (method, params) => {
				sourceARequests.push({ method, params });
				return { content: [{ type: "text" as const, text: "source A result" }], isError: false };
			}),
			"linear-mcp",
		);
		const collidingBConnection = makeConnection(
			mockTransport(async (method, params) => {
				collidingBRequests.push({ method, params });
				return { content: [{ type: "text" as const, text: "colliding B result" }], isError: false };
			}),
			"linear_mcp",
		);
		const sourceA = new MCPTool(sourceAConnection, { ...issueCommentDefinition, name: "save-comment" });
		const collidingB = new MCPTool(collidingBConnection, { ...issueCommentDefinition, name: "save_comment" });
		expect(sourceA.name).toBe(collidingB.name);

		const manager = new MCPManager(process.cwd());
		let currentTools: CustomTool[] = [sourceA];
		vi.spyOn(manager, "getTools").mockImplementation(() => currentTools);
		const proxy = createMCPProxyTools(manager)[0];
		if (!proxy) throw new Error("Expected an MCP proxy tool");

		currentTools = [collidingB, sourceA];
		const params = { body: "identity-sensitive", issueId: "ENG-317" };
		const result = await proxy.execute(
			"task-call-normalized-name-collision",
			params,
			undefined,
			{} as CustomToolContext,
		);

		expect({ sourceARequests, collidingBRequests, result: result.content }).toEqual({
			sourceARequests: [
				{
					method: "tools/call",
					params: { name: "save-comment", arguments: params },
				},
			],
			collidingBRequests: [],
			result: [{ type: "text", text: "source A result" }],
		});
	});

	it("exposes an explicitly non-strict source MCP tool as non-strict to task models", () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const source = createFakeMCPTool(async () => ({ content: [] }), false);
		const proxy = createProxy(source, connection);

		expect(proxy.strict).toBe(false);
	});
});
