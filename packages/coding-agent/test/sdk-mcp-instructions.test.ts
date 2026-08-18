import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	BOUNDED_GUIDANCE_MODE,
	CONTEXT_MODE_NO_INSTRUCTIONS_MODE,
	LONG_INSTRUCTIONS_MODE,
	LONG_INSTRUCTIONS_PREFIX,
	SERVER_INSTRUCTIONS,
	TOOL_RESULT,
} from "./fixtures/instructions-mcp";

// Contract: deferred UI discovery advertises each mounted MCP server as one
// virtual xd:// service. Tool names, schemas, and optional server instructions
// load only when that service path is read. Explicitly top-level MCP tools keep
// their server instructions inline because they have no service device.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const MCP_TOOL_NAME = "mcp__instr_do_thing";
const MCP_SERVICE_PATH = "xd://mcp-service:instr";
const CONTEXT_MODE_SERVICE_PATH = "xd://mcp-service:context-mode";
const CONTEXT_MODE_MCP_TOOL_NAME = "mcp__context_mode_ctx_execute";

describe("createAgentSession MCP server instructions (deferred UI)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config through the process-global agent
	// directory. Redirect both that path and os.homedir() so the test connects
	// only to the fixture and never spawns the developer's real MCP servers.
	let originalAgentDir: string;
	let isolatedHome: string;
	let isolatedAgentDir: string;

	beforeAll(async () => {
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-instr-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		for (const dir of [isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("loads mounted server tools and instructions through one deferred service", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			let prompt = session.systemPrompt.join("\n");
			expect(prompt).not.toContain(MCP_SERVICE_PATH);
			// This integration spawns a real MCP subprocess and the deferred SDK
			// connection exposes no completion event. Poll the positive service
			// signal, exiting immediately when the registry rebuild lands.
			const deadline = Date.now() + 12_000;
			while (!prompt.includes(MCP_SERVICE_PATH) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(MCP_SERVICE_PATH);
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain(MCP_TOOL_NAME);
			expect(prompt).not.toContain("## MCP Tool Routes");

			const read = session.agent.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error("expected active read tool");
			const result = await read.execute("read-mcp-service", { path: MCP_SERVICE_PATH });
			const text = result.content.find(entry => entry.type === "text")?.text ?? "";
			expect(text).toContain(SERVER_INSTRUCTIONS);
			expect(text).toContain(`xd://${MCP_TOOL_NAME}`);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("marks lazy server instructions when the bounded page truncates them", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, LONG_INSTRUCTIONS_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			const deadline = Date.now() + 12_000;
			while (
				!session.getXdevToolEntries().some(entry => entry.name === "mcp-service:instr") &&
				Date.now() < deadline
			) {
				await Bun.sleep(10);
			}
			const read = session.agent.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error("expected active read tool");
			const result = await read.execute("read-long-mcp-service", { path: MCP_SERVICE_PATH });
			const text = result.content.find(entry => entry.type === "text")?.text ?? "";

			expect(text).toContain(LONG_INSTRUCTIONS_PREFIX);
			expect(text).toContain("\n[truncated]");
			expect(text).not.toContain("x".repeat(5_000));
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("advertises a mounted service when initialize omits instructions", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"context-mode": {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, CONTEXT_MODE_NO_INSTRUCTIONS_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			let prompt = session.systemPrompt.join("\n");
			expect(prompt).not.toContain(CONTEXT_MODE_SERVICE_PATH);
			const deadline = Date.now() + 12_000;
			while (!prompt.includes(CONTEXT_MODE_SERVICE_PATH) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(CONTEXT_MODE_SERVICE_PATH);
			expect(prompt).not.toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("mcp-service:context-mode");
			expect(session.getActiveToolNames()).not.toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain("## MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps a large mounted tool catalog behind its service page", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, BOUNDED_GUIDANCE_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(MCP_SERVICE_PATH) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain('MCP service "instr" (65 tools)');
			expect(prompt).not.toContain("mcp__instr_row_aa");
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);

			const read = session.agent.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error("expected active read tool");
			const result = await read.execute("read-large-mcp-service", { path: MCP_SERVICE_PATH });
			const text = result.content.find(entry => entry.type === "text")?.text ?? "";
			expect(text).toContain(SERVER_INSTRUCTIONS);
			expect(text).toContain("xd://mcp__instr_row_aa");
			expect(text).toContain("xd://mcp__instr_row_cm");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred MCP tools top-level when CLI tool filtering grants read but not write", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");

			// The xd:// transport rides BOTH halves: `read xd://` discovers and
			// `write xd://<tool>` executes. A session granted read but not write
			// never allocates xdev state, so deferred discovery must surface MCP
			// tools top-level instead of auto-granting the denied write transport.
			const deadline = Date.now() + 12_000;
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(10);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(activeNames).not.toContain("write");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
			const mcpTool = session.getToolByName(MCP_TOOL_NAME);
			expect(mcpTool).toBeDefined();
			const result = await mcpTool!.execute("deferred-mcp-call", {});
			expect(result.content.find(part => part.type === "text")?.text).toBe(TOOL_RESULT);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps an explicitly requested deferred MCP tool top-level after connection", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read", MCP_TOOL_NAME],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}
			const activeNames = session.getActiveToolNames();

			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
			expect(prompt).toContain("## MCP Server Instructions");
			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain(`xd://${MCP_TOOL_NAME}`);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred tools top-level when an explicit session omitted read", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["bash"],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(10);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).not.toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
