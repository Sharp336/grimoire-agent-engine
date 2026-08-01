import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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

// Contract: `mcpConfigPaths` (the `--mcp-config` flag) names exact files, so a
// file that cannot be read or does not have the expected shape must fail
// session creation instead of degrading into a session silently missing those
// servers. Both startup paths have to honour it:
//
// - `hasUI: false` discovers through `discoverAndLoadMCPTools`, which turns
//   discovery failures into a resolved result whose `errors` startup only logs;
// - `hasUI: true` defers discovery into a detached promise, where a rejection
//   can no longer abort startup at all.
//
// Neither could carry the error on its own, so the paths are validated before
// that branch is taken.
describe("createAgentSession explicit --mcp-config failures", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const baseOptions = () => ({
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
	});

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-config-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		if (registryDir && fs.existsSync(registryDir)) {
			removeSyncWithRetries(registryDir);
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-config-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	for (const hasUI of [false, true]) {
		it(`rejects an unreadable --mcp-config file (hasUI: ${hasUI})`, async () => {
			await expect(
				createAgentSession({
					...baseOptions(),
					hasUI,
					mcpConfigPaths: [path.join(tempDir, "does-not-exist.json")],
				}),
			).rejects.toThrow(/Cannot read MCP config/);
		});

		it(`rejects a wrong-shape --mcp-config file (hasUI: ${hasUI})`, async () => {
			const wrongShapePath = path.join(tempDir, "wrong-shape.json");
			fs.writeFileSync(wrongShapePath, JSON.stringify({ mcpServers: "not-a-map" }));

			await expect(
				createAgentSession({ ...baseOptions(), hasUI, mcpConfigPaths: [wrongShapePath] }),
			).rejects.toThrow(/"mcpServers" must be an object/);
		});

		it(`starts normally when the --mcp-config file is valid (hasUI: ${hasUI})`, async () => {
			const configPath = path.join(tempDir, "extra.json");
			fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

			const { session } = await createAgentSession({ ...baseOptions(), hasUI, mcpConfigPaths: [configPath] });
			try {
				expect(session.getActiveToolNames()).toContain("read");
			} finally {
				await session.dispose();
			}
		});
	}
});
