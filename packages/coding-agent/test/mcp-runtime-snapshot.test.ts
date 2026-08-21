import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	formatMcpHealthLabel,
	formatMcpListHint,
	inferMcpTransport,
	isDiscoveredMcpServer,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
	visibleMcpTools,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";

const source: SourceMeta = {
	provider: "native",
	providerName: "OMP (User)",
	path: "/home/sf/.omp/agent/mcp.json",
	level: "user",
};

function server(overrides: Partial<MCPServer> = {}): MCPServer {
	return {
		name: "github",
		command: "/usr/bin/github-mcp-server",
		args: ["stdio"],
		transport: "stdio",
		_source: source,
		...overrides,
	};
}

function transport(): MCPTransport {
	return {
		connected: true,
		request() {
			return Promise.reject(new Error("unused"));
		},
		notify() {
			return Promise.resolve();
		},
		close() {
			return Promise.resolve();
		},
	};
}

function connection(overrides: Partial<MCPServerConnection> = {}): MCPServerConnection {
	return {
		name: "github",
		config: { command: "/usr/bin/github-mcp-server", args: ["stdio"] },
		transport: transport(),
		serverInfo: {
			name: "github-mcp-server",
			title: "GitHub MCP Server",
			version: "0.19.0",
			description: "Access GitHub repositories, issues, and pull requests.",
		},
		capabilities: { tools: {}, resources: {}, prompts: {} },
		tools: [
			{
				name: "search_code",
				description: "Search code across GitHub repositories.",
				inputSchema: { type: "object" },
			},
			{ name: "get_pull_request", description: "Get pull request details.", inputSchema: { type: "object" } },
		],
		resources: [{ uri: "github://repo", name: "repo" }],
		prompts: [{ name: "review_pr", description: "Review a pull request" }],
		instructions: "Prefer search_code over cloning.",
		...overrides,
	};
}

function sourceFor(status: "connected" | "connecting" | "disconnected", conn?: MCPServerConnection): MCPRuntimeSource {
	return {
		getConnectionStatus: () => status,
		getConnection: () => conn,
		getTools: () =>
			(conn?.tools ?? []).map(tool => ({
				mcpServerName: conn?.name,
				mcpToolName: tool.name,
				description: tool.description,
			})),
		getServerResources: () =>
			conn ? { resources: conn.resources ?? [], templates: conn.resourceTemplates ?? [] } : undefined,
		getServerPrompts: () => conn?.prompts,
	};
}

describe("snapshotMcpRuntime", () => {
	test("does not treat command/url as a description", () => {
		const snap = snapshotMcpRuntime(server(), undefined);
		expect(snap.description).toBeUndefined();
		expect(snap.command).toBe("/usr/bin/github-mcp-server");
		expect(snap.health).toBe("disconnected");
		expect(snap.transport).toBe("stdio");
	});

	test("joins live connection identity, tools, and instructions", () => {
		const conn = connection();
		const snap = snapshotMcpRuntime(server(), sourceFor("connected", conn));
		expect(snap.health).toBe("connected");
		expect(snap.title).toBe("GitHub MCP Server");
		expect(snap.description).toBe("Access GitHub repositories, issues, and pull requests.");
		expect(snap.implementationName).toBe("github-mcp-server");
		expect(snap.implementationVersion).toBe("0.19.0");
		expect(snap.tools.map(t => t.name)).toEqual(["search_code", "get_pull_request"]);
		expect(snap.tools[0]?.description).toBe("Search code across GitHub repositories.");
		expect(snap.resources).toHaveLength(1);
		expect(snap.prompts).toHaveLength(1);
		expect(snap.instructions).toBe("Prefer search_code over cloning.");
		expect(formatMcpListHint(snap)).toBe("2 tools · 1 resource · 1 prompt");
	});

	test("maps connecting and inactive separately from enabled-in-config", () => {
		expect(snapshotMcpRuntime(server(), sourceFor("connecting")).health).toBe("connecting");
		expect(snapshotMcpRuntime(server(), sourceFor("disconnected")).health).toBe("disconnected");
		expect(snapshotMcpRuntime(server({ enabled: false }), sourceFor("connected", connection())).health).toBe(
			"inactive",
		);
		expect(snapshotMcpRuntime(server(), sourceFor("connected", connection()), { enabled: false }).health).toBe(
			"inactive",
		);
	});

	test("does not join a shadowed same-name config against the winner", () => {
		const winner = connection();
		const snap = snapshotMcpRuntime(server({ command: "/usr/bin/shadowed-github" }), sourceFor("connected", winner), {
			shadowed: true,
		});
		expect(snap.health).toBe("disconnected");
		expect(snap.title).toBeUndefined();
		expect(snap.description).toBeUndefined();
		expect(snap.tools).toEqual([]);
		expect(snap.instructions).toBeUndefined();
		expect(snap.command).toBe("/usr/bin/shadowed-github");
	});

	test("infers http from url when transport is omitted", () => {
		expect(inferMcpTransport({ name: "remote", url: "https://example.test/mcp", _source: source })).toBe("http");
		expect(inferMcpTransport({ type: "sse", url: "https://example.test/sse" })).toBe("sse");
		expect(isDiscoveredMcpServer(server())).toBe(true);
		expect(isDiscoveredMcpServer({ command: "echo" })).toBe(false);
	});

	test("visibleMcpTools truncates with a leftover count", () => {
		const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` }));
		const { shown, hidden } = visibleMcpTools(tools, 8);
		expect(shown).toHaveLength(8);
		expect(hidden).toBe(4);
		expect(formatMcpHealthLabel("disconnected")).toBe("Not connected");
	});
});
