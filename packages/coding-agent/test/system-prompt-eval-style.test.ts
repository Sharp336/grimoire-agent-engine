import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { evalPromptStyle } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("evalPromptStyle model mapping", () => {
	it("maps model families across namespaced, bare, and variant id shapes", () => {
		expect(evalPromptStyle("anthropic/claude-fable-5")).toBe("claude");
		expect(evalPromptStyle("claude-opus-4-8")).toBe("claude");
		expect(evalPromptStyle("openrouter/anthropic/claude-sonnet-4.5")).toBe("claude");
		expect(evalPromptStyle("zai/glm-5.2")).toBe("claude");
		expect(evalPromptStyle("openai/gpt-5.6")).toBe("codex");
		expect(evalPromptStyle("gpt-5.2-codex")).toBe("codex");
		expect(evalPromptStyle("o3-mini")).toBe("codex");
		expect(evalPromptStyle("moonshotai/kimi-k2.6")).toBe("kimi");
		expect(evalPromptStyle("kimi-k3-turbo")).toBe("kimi");
		expect(evalPromptStyle("google/gemini-3-pro")).toBe("default");
		expect(evalPromptStyle("deepseek/deepseek-v4")).toBe("default");
		expect(evalPromptStyle(undefined)).toBe("default");
	});
});

describe("system prompt eval-first batching section", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-eval-style-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-eval-style-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(model: string | undefined, toolNames: string[]): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model,
		});
		return systemPrompt.join("\n\n");
	}

	function evalSection(rendered: string): string {
		const start = rendered.indexOf("# Eval-First Batching");
		expect(start).toBeGreaterThanOrEqual(0);
		const end = rendered.indexOf("# Exploration", start);
		expect(end).toBeGreaterThan(start);
		return rendered.slice(start, end);
	}

	it("omits the section when the eval tool is not active", async () => {
		const rendered = await render("anthropic/claude-fable-5", ["read", "bash"]);
		expect(rendered).not.toContain("Eval-First Batching");
	});

	it("renders the XML-tagged claude dialect for Claude and GLM models", async () => {
		for (const model of ["anthropic/claude-fable-5", "zai/glm-5.2"]) {
			const rendered = await render(model, ["read", "bash", "eval"]);
			expect(rendered).toContain("<eval_first_batching>");
			expect(rendered).toContain("</eval_first_batching>");
			expect(rendered).toContain("your default execution surface");
		}
	});

	it("renders the terse codex dialect for OpenAI models", async () => {
		const rendered = await render("openai/gpt-5.6", ["read", "bash", "eval"]);
		expect(rendered).toContain("Route multi-call steps through");
		expect(rendered).not.toContain("<eval_first_batching>");
		expect(rendered).not.toContain("PRIMARY EXECUTION SURFACE");
	});

	it("renders the positive-constraint kimi dialect for Kimi models", async () => {
		const rendered = await render("moonshotai/kimi-k2.6", ["read", "bash", "eval"]);
		const section = evalSection(rendered);
		expect(section).toContain("as the standard way to execute");
		expect(section).not.toContain("NEVER");
		expect(section).not.toContain("MUST");
	});

	it("renders the maximum-emphasis default dialect for unmapped models and when no model is set", async () => {
		for (const model of ["google/gemini-3-pro", undefined]) {
			const rendered = await render(model, ["read", "bash", "eval"]);
			expect(rendered).toContain("PRIMARY EXECUTION SURFACE");
			expect(rendered).toContain("parallel([...])");
		}
	});
});
