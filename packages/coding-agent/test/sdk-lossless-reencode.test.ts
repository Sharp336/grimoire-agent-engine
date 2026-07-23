import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function structuredJson(): string {
	return JSON.stringify(
		Array.from({ length: 180 }, (_, id) => ({
			id,
			endpoint: "/api/v1/orders",
			status: id % 7 === 0 ? 201 : 200,
			region: `region_${id % 4}`,
			latency_ms: 40 + (id % 9),
			ok: true,
		})),
	);
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function resultText(message: Message): string {
	if (message.role !== "toolResult" || message.content[0]?.type !== "text") throw new Error("Expected text result");
	return message.content[0].text;
}

describe("createAgentSession lossless re-encode wiring", () => {
	const tempDir = path.join(os.tmpdir(), `pi-sdk-lossless-reencode-${Snowflake.next()}`);
	const model = getBundledModel("openai", "gpt-4o-mini");
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await discoverAuthStorage(tempDir);
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function options(settings: Settings): CreateAgentSessionOptions {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
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
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
	}

	it("leaves structured history verbatim when the opt-in setting is disabled", async () => {
		const original = structuredJson();
		const { session } = await createAgentSession(options(Settings.isolated()));
		try {
			const context = await session.agent.buildSideRequestContext([
				{ role: "user", content: "go", timestamp: 0 },
				toolResult("candidate", original),
				toolResult("tail", "tail"),
			]);

			expect(resultText(context.messages[1])).toBe(original);
		} finally {
			await session.dispose();
		}
	});

	it("remains inert when the boolean is enabled but the allowlist is empty", async () => {
		const original = structuredJson();
		const settings = Settings.isolated({ "reencode.losslessToolResults": true });
		const { session } = await createAgentSession(options(settings));
		try {
			const context = await session.agent.buildSideRequestContext([
				{ role: "user", content: "go", timestamp: 0 },
				toolResult("candidate", original),
				toolResult("tail", "tail"),
			]);

			expect(resultText(context.messages[1])).toBe(original);
		} finally {
			await session.dispose();
		}
	});

	it("fails closed when the allowlist setting is not an array", async () => {
		const original = structuredJson();
		const settings = Settings.isolated({
			"reencode.losslessToolResults": true,
			"reencode.toolResultAllowlist": "read",
		});
		const { session } = await createAgentSession(options(settings));
		try {
			const context = await session.agent.buildSideRequestContext([
				{ role: "user", content: "go", timestamp: 0 },
				toolResult("candidate", original),
				toolResult("tail", "tail"),
			]);

			expect(resultText(context.messages[1])).toBe(original);
		} finally {
			await session.dispose();
		}
	});

	it("runs re-encoding before snapcompact so sub-3k output remains text", async () => {
		const settings = Settings.isolated({
			"reencode.losslessToolResults": true,
			"reencode.toolResultAllowlist": ["read"],
			"snapcompact.toolResults": true,
			"snapcompact.shape": "6x12-dim",
		});
		const { session } = await createAgentSession(options(settings));
		try {
			const context = await session.agent.buildSideRequestContext([
				{ role: "user", content: "go", timestamp: 0 },
				toolResult("candidate", structuredJson()),
				toolResult("tail", "tail"),
			]);
			const candidate = context.messages[1];

			expect(resultText(candidate)).toMatch(
				/^\[lossless-reencode v1 schema\+csv; values exact, formatting\/key-order normalized; original=\d+B]\n/,
			);
			if (candidate.role !== "toolResult") throw new Error("Expected tool result");
			expect(candidate.content.some(block => block.type === "image")).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
