import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { prompt } from "@oh-my-pi/pi-utils";
import bashPrompt from "../src/prompts/tools/bash.md" with { type: "text" };
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

// Windows hosts run the bash tool through the embedded POSIX shell, so the
// model must be told to keep emitting bash syntax (not cmd.exe/PowerShell)
// even though the workstation block reports a win32 OS.
describe("system prompt Windows guidance", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-windows-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-windows-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function renderedPrompt(): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["bash"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		return systemPrompt.join("\n\n");
	}

	it("renders the <windows> host block on win32", async () => {
		spyOn(os, "platform").mockReturnValue("win32");

		const rendered = await renderedPrompt();
		expect(rendered).toContain("<windows>");
		expect(rendered).toContain("embedded POSIX bash");
		expect(rendered).toContain('cmd.exe /c "…"');
		expect(rendered).toContain('powershell -NoProfile -Command "…"');
	});

	it("omits the <windows> host block on other platforms", async () => {
		spyOn(os, "platform").mockReturnValue("linux");

		expect(await renderedPrompt()).not.toContain("<windows>");
	});
});

describe("bash tool description Windows guidance", () => {
	function renderBash(isWindows: boolean): string {
		return prompt.render(bashPrompt, { isWindows });
	}

	it("tells the model the tool stays a POSIX bash on Windows", () => {
		const rendered = renderBash(true);
		expect(rendered).toContain("embedded POSIX bash");
		expect(rendered).toContain('cmd.exe /c "…"');
		expect(rendered).toContain('powershell -NoProfile -Command "…"');
	});

	it("carries no Windows guidance elsewhere", () => {
		expect(renderBash(false)).not.toContain("Windows");
	});
});
