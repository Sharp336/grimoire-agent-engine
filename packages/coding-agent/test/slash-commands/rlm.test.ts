import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const DISABLE_MESSAGE =
	"RLM mode is disabled. Enable it via the rlm.enabled setting (e.g. omp config set rlm.enabled true).";

function acpRuntime(options?: { enabled?: boolean; backends?: Record<string, boolean> }) {
	const store: Record<string, unknown> = {
		"rlm.enabled": options?.enabled ?? false,
		...options?.backends,
	};
	const settings = {
		get: (path: string) => store[path],
	} as unknown as SlashCommandRuntime["settings"];
	const get = vi.spyOn(settings, "get");
	const output = vi.fn();
	const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-test-"));
	const sessionManager = {
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
	} as unknown as SlashCommandRuntime["sessionManager"];
	const runtime = { settings, output, sessionManager } as unknown as SlashCommandRuntime;
	return { get, output, runtime, artifactsDir };
}

function promptOf(result: AcpBuiltinSlashCommandResult): string {
	if (!result || !("prompt" in result)) throw new Error("expected a { prompt } result");
	return result.prompt;
}

describe("/rlm slash command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("outputs the enable hint and consumes the command when rlm.enabled is false", async () => {
		const h = acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/rlm analyze this input", h.runtime);

		expect(h.get).toHaveBeenCalledWith("rlm.enabled");
		expect(h.output).toHaveBeenCalledWith(DISABLE_MESSAGE);
		expect(result).toEqual({ consumed: true });
	});

	it("does not leak a prompt when the gate is disabled", async () => {
		const h = acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize", h.runtime);

		expect(result).not.toHaveProperty("prompt");
		expect(h.output).toHaveBeenCalledTimes(1);
	});

	it("externalizes the inline request to a local:// file instead of inlining it", async () => {
		const h = acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(h.get).toHaveBeenCalledWith("rlm.enabled");
		expect(h.output).not.toHaveBeenCalled();
		expect(result).not.toEqual({ consumed: true });
		const prompt = promptOf(result);
		// The raw request text must NOT be inlined into the prompt — only a
		// local:// reference the model loads from inside the eval sandbox.
		expect(prompt).not.toContain("summarize the report");
		expect(prompt).toContain("local://rlm-input-");
		expect(prompt).toContain("llm_query");
		expect(prompt).toContain("rlm_query");
		expect(prompt).toContain("task.maxRecursionDepth");

		const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
		expect(match).not.toBeNull();
		const writtenPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
		expect(fs.readFileSync(writtenPath, "utf-8")).toBe("summarize the report");
	});

	it("rejects with an actionable message when no eval backend is enabled", async () => {
		const h = acpRuntime({ enabled: true, backends: { "eval.py": false, "eval.js": false } });

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.output).toHaveBeenCalledWith(expect.stringContaining("requires an eval backend"));
	});

	it("still returns a prompt when invoked without arguments", async () => {
		const h = acpRuntime({ enabled: true });

		const result = await executeAcpBuiltinSlashCommand("/rlm", h.runtime);

		const prompt = promptOf(result);
		expect(prompt).toContain("RLM mode");
		expect(h.output).not.toHaveBeenCalled();
	});
});
