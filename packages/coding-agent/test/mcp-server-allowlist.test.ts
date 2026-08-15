import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { type MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/builtin";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

class CapturingMCPManager extends MCPManager {
	lastConfigNames: string[] = [];
	lastSourceNames: string[] = [];

	override async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
	): Promise<MCPLoadResult> {
		this.lastConfigNames = Object.keys(configs);
		this.lastSourceNames = Object.keys(sources);
		return {
			tools: [],
			errors: new Map(),
			connectedServers: [...this.lastConfigNames],
			exaApiKeys: [],
		};
	}
}

describe("MCP discovered-server allowlist", () => {
	let projectDir = "";
	let agentDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-allowlist-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-allowlist-agent-"));
		setAgentDir(agentDir);
		clearFsCache();
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					alpha: { type: "http", url: "https://alpha.example/mcp" },
					beta: { type: "http", url: "https://beta.example/mcp" },
				},
			}),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) setAgentDir(originalAgentDirEnv);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("preserves normal discovery when omitted", async () => {
		const manager = new CapturingMCPManager(projectDir);
		const result = await manager.discoverAndConnect({ filterExa: false });

		expect(result.connectedServers).toEqual(["alpha", "beta"]);
		expect(manager.lastSourceNames).toEqual(["alpha", "beta"]);
	});

	test("connects only exact selected names before connection", async () => {
		const manager = new CapturingMCPManager(projectDir);
		const result = await manager.discoverAndConnect({ filterExa: false, serverNames: ["beta"] });

		expect(result.connectedServers).toEqual(["beta"]);
		expect(manager.lastSourceNames).toEqual(["beta"]);
	});

	test("keeps a session policy across rediscovery and narrower requests", async () => {
		const manager = new CapturingMCPManager(projectDir, null, ["beta"]);

		expect((await manager.discoverAndConnect({ filterExa: false })).connectedServers).toEqual(["beta"]);
		expect(
			(await manager.discoverAndConnect({ filterExa: false, serverNames: ["alpha", "beta"] })).connectedServers,
		).toEqual(["beta"]);
	});

	test("treats empty and unknown selections as no connectors", async () => {
		for (const serverNames of [[], ["missing"]]) {
			const manager = new CapturingMCPManager(projectDir);
			const result = await manager.discoverAndConnect({ filterExa: false, serverNames });
			expect(result.connectedServers).toEqual([]);
			expect(manager.lastSourceNames).toEqual([]);
		}
	});
});
