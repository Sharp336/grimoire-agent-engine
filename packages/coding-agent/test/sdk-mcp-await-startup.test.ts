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
import { SERVER_INSTRUCTIONS, TOOL_NAME } from "./fixtures/instructions-mcp";

// Contract: with `mcp.awaitStartupMs` > 0, an interactive (`hasUI`) session
// waits (bounded) for MCP discovery BEFORE assembling its tool registry and
// system prompt. Connected/cached tools mount into the INITIAL xd://
// inventory, so they appear in the prompt immediately and no xd:// mount
// notice is ever queued for them (an initial mount produces no delta).
// The default (0) keeps deferred background discovery; that path's
// first-paint behavior is covered by sdk-mcp-instructions.test.ts.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const MCP_TOOL_NAME = `mcp__instr_${TOOL_NAME}`;

describe("createAgentSession with mcp.awaitStartupMs (interactive UI)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config from `os.homedir()`; redirect it
	// to an empty dir so the test connects ONLY to the fixture server and never
	// spawns the developer's real MCP servers.
	let isolatedHome: string;
	let savedHomeEnv: string | undefined;
	let savedXdgEnv: string | undefined;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-await-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-await-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-await-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		// The os.homedir() mock alone does not isolate discovery: parts of the
		// config stack resolve the user dir through env vars, which let the
		// developer's real MCP servers leak into these tests. Scoped per test
		// (not beforeAll) so sibling test files never see the redirect.
		savedHomeEnv = process.env.HOME;
		savedXdgEnv = process.env.XDG_CONFIG_HOME;
		process.env.HOME = isolatedHome;
		process.env.XDG_CONFIG_HOME = isolatedHome;
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
		if (savedHomeEnv === undefined) delete process.env.HOME;
		else process.env.HOME = savedHomeEnv;
		if (savedXdgEnv === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdgEnv;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("mounts MCP tools into the initial prompt when startup await is enabled", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.awaitStartupMs": 5000 }),
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
			// No polling: discovery must have completed before createAgentSession
			// returned, so the server's instructions and tool menu line are
			// already in the very first prompt build.
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			expect(prompt).toContain("MCP Server Instructions");
			expect(session.getEnabledToolNames()).toContain(MCP_TOOL_NAME);
			// Mounted under xd:// (xdev default) and catalogued in the prompt.
			expect(prompt).toContain(`xd://${MCP_TOOL_NAME}`);
			// Note: full ambient isolation is not achievable here — the native
			// user-level MCP dir resolves via getAgentDir(), which is frozen at
			// module import (PI_CODING_AGENT_DIR), before test mocks install.
			// Assertions therefore target only the fixture server.
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps MCP tools out of the first prompt when startup await is disabled", async () => {
		// Negative control: identical setup with the default (0) must NOT have
		// the server at first paint — otherwise the positive test above could be
		// passing because the fixture merely beat the prompt build on its own.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.awaitStartupMs": 0 }),
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
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(session.getEnabledToolNames()).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("starts cleanly when a configured server fails to connect", async () => {
		// The robustness contract of the awaited path: a dead server is a
		// per-server error, never a session-startup failure. (The fixture config
		// from beforeEach is replaced with one pointing at a missing binary.)
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					badserver: { type: "stdio", command: "/nonexistent/omp-test-mcp-server-xyz" },
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.awaitStartupMs": 5000 }),
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
			const badTools = session.getEnabledToolNames().filter(name => name.startsWith("mcp__badserver_"));
			expect(badTools).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
