import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	["read", { label: "Read", description: "Reads files.", parameters: { type: "object", properties: {} } }],
	[
		"fast_context",
		{
			label: "FastContext",
			description: "Delegates repository exploration.",
			parameters: { type: "object", properties: {} },
		},
	],
]);

describe("system prompt fast_context directive", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fc-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fc-prompt-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(toolNames: string[]): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		return systemPrompt.join("\n\n");
	}

	it("renders the fast_context-FIRST directive when fast_context is in the active tool set", async () => {
		const text = await render(["read", "fast_context"]);
		// The Exploration directive (forceful, first-action) must reach the model.
		expect(text).toContain("Broad retrieval FIRST");
		expect(text).toContain("fast_context");
	});

	it("omits the directive when fast_context is gated off (not active for this agent)", async () => {
		const text = await render(["read"]);
		// `has` must key off the active tool set — no directive for an agent without fast_context.
		expect(text).not.toContain("Broad retrieval FIRST");
	});
});
