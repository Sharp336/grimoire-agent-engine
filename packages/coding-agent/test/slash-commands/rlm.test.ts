import { afterEach, describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const DISABLE_MESSAGE =
	"RLM mode is disabled. Enable it via the rlm.enabled setting (e.g. omp config set rlm.enabled true).";

function acpRuntime(options?: { enabled?: boolean }) {
	const store: Record<string, unknown> = { "rlm.enabled": options?.enabled ?? false };
	const settings = {
		get: (path: string) => store[path],
	} as unknown as SlashCommandRuntime["settings"];
	const get = vi.spyOn(settings, "get");
	const output = vi.fn();
	const runtime = { settings, output } as unknown as SlashCommandRuntime;
	return { get, output, runtime };
}

describe("/rlm slash command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
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

	it("returns a prompt containing the request when rlm.enabled is true", async () => {
		const h = acpRuntime({ enabled: true });

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(h.get).toHaveBeenCalledWith("rlm.enabled");
		expect(h.output).not.toHaveBeenCalled();
		expect(result).not.toEqual({ consumed: true });
		const prompt = (result as { prompt: string }).prompt;
		expect(prompt).toContain("summarize the report");
		expect(prompt).toContain("llm_query");
		expect(prompt).toContain("rlm_query");
		expect(prompt).toContain("task.maxRecursionDepth");
	});

	it("still returns a prompt when invoked without arguments", async () => {
		const h = acpRuntime({ enabled: true });

		const result = await executeAcpBuiltinSlashCommand("/rlm", h.runtime);

		const prompt = (result as { prompt: string }).prompt;
		expect(prompt).toContain("RLM mode");
		expect(h.output).not.toHaveBeenCalled();
	});
});
