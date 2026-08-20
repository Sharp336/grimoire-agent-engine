import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "../src/mcp/types";

const TOOL: MCPToolDefinition = {
	name: "probe",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	},
};

function fakeConnection(): MCPServerConnection {
	return { name: "server", transport: {}, capabilities: {} } as MCPServerConnection;
}

describe("MCP tool activity boundaries", () => {
	let localRoot: string;

	beforeEach(() => {
		localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-tool-activity-"));
	});

	afterEach(() => {
		fs.rmSync(localRoot, { recursive: true, force: true });
	});

	for (const kind of ["connected", "deferred"] as const) {
		it(`begins activity before preparing ${kind} tool arguments and ends after preparation`, async () => {
			const events: string[] = [];
			const activity = {
				begin: () => events.push("begin"),
				end: () => events.push("end"),
			};
			const context = {
				localProtocolOptions: {
					getArtifactsDir: () => {
						events.push("prepare");
						return localRoot;
					},
					getSessionId: () => "activity-test",
				},
			};
			const tool =
				kind === "connected"
					? new MCPTool(fakeConnection(), TOOL, undefined, activity)
					: new DeferredMCPTool(
							"server",
							TOOL,
							async () => {
								throw new Error("connection should not be reached before preparation");
							},
							undefined,
							undefined,
							activity,
						);

			await expect(
				tool.execute(
					"call",
					{ path: "local://missing.txt" },
					undefined,
					context as Parameters<typeof tool.execute>[3],
					undefined,
				),
			).rejects.toThrow();

			expect(events).toEqual(["begin", "prepare", "end"]);
		});
	}
});
