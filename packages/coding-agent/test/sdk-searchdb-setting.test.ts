import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SearchDb } from "@oh-my-pi/pi-natives";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("createAgentSession SearchDb setting", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-searchdb-setting-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function buildSessionOptions(settings: Settings) {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		return {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};
	}

	test("does not create SearchDb when the setting is disabled", async () => {
		const { session } = await createAgentSession(
			buildSessionOptions(Settings.isolated({ "searchDb.enabled": false })),
		);

		try {
			expect(session.searchDb).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("keeps an explicitly provided SearchDb when the setting is disabled", async () => {
		const providedSearchDb = new SearchDb(path.join(tempDir, "provided-searchdb"));
		const { session } = await createAgentSession({
			...buildSessionOptions(Settings.isolated({ "searchDb.enabled": false })),
			searchDb: providedSearchDb,
		});

		try {
			expect(session.searchDb).toBe(providedSearchDb);
		} finally {
			await session.dispose();
		}
	});

	test("creates SearchDb by default", async () => {
		const { session } = await createAgentSession(buildSessionOptions(Settings.isolated()));

		try {
			expect(session.searchDb).toBeDefined();
		} finally {
			await session.dispose();
		}
	});
});
