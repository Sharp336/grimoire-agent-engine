import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

/**
 * Cleanup-phase wording contract: the standing system prompt must never
 * categorize tests as post-implementation housekeeping. Tests may precede
 * implementation when project conventions or TDD call for it, while
 * changelog/docs/scaffolding removal remain the gated final phase and
 * behavioral verification stays required before yielding.
 */
describe("system prompt cleanup-phase wording", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-cleanup-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-cleanup-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		return systemPrompt.join("\n\n");
	}

	it("permits tests before implementation instead of deferring them to cleanup", async () => {
		const rendered = await render();

		// Tests must never be lumped into the deferred housekeeping list.
		expect(rendered).not.toMatch(/changelog, tests/i);
		expect(rendered).toContain("Tests are NOT housekeeping");
		expect(rendered).toContain("before implementation when project conventions or TDD call for it");
	});

	it("keeps housekeeping gated last and verification mandatory", async () => {
		const rendered = await render();

		expect(rendered).toContain("Changelog, docs, and removing scaffolding are the LAST phase");
		expect(rendered).toContain("NEVER yield non-trivial work without proof");
	});
});
