import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

/** Escape hatch for deliberate test fakes that are not structurally comparable to their target types. */
function cast<T>(value: unknown): T {
	return value as T;
}

/** TUI fake runtime — same shape as `btw.test.ts`, extended with session wiring. */
function createTuiRuntime(options?: { sessionManager?: SessionManager }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const sessionManager = options?.sessionManager ?? SessionManager.inMemory();

	return {
		setText,
		showStatus,
		sessionManager,
		runtime: {
			ctx: cast<InteractiveModeContext>({
				editor: { setText },
				showStatus,
				sessionManager,
			}),
		},
	};
}

/** ACP fake runtime — minimal `SlashCommandRuntime` for `handle` branches. */
function createAcpRuntime(options?: { sessionManager?: SessionManager }) {
	const output = vi.fn();
	const sessionManager = options?.sessionManager ?? SessionManager.inMemory();

	return {
		output,
		sessionManager,
		runtime: cast<SlashCommandRuntime>({
			sessionManager,
			cwd: sessionManager.getCwd(),
			output,
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		}),
	};
}

/**
 * Narrow a slash-command result to its prompt text. A real check rather than an
 * inline cast, so a handler that stops returning a prompt fails here loudly
 * instead of reading `undefined` off a shape nobody verified.
 */
function promptTextOf(result: unknown): string {
	if (!result || typeof result !== "object" || !("prompt" in result) || typeof result.prompt !== "string") {
		throw new Error(`expected a { prompt: string } result, got ${JSON.stringify(result)}`);
	}
	return result.prompt;
}

describe("/qa slash command", () => {
	it("returns a prompt carrying the request", async () => {
		const harness = createAcpRuntime();
		const request = "verify the login form submits and surfaces errors";

		const result = await executeAcpBuiltinSlashCommand(`/qa ${request}`, harness.runtime);

		expect(result).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		const prompt = promptTextOf(result);
		expect(prompt).toContain(request);
	});

	it("with an empty request still returns a non-empty prompt", async () => {
		const harness = createAcpRuntime();

		const result = await executeAcpBuiltinSlashCommand("/qa", harness.runtime);

		expect(result).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		expect(promptTextOf(result)).not.toHaveLength(0);
	});

	it("ACP and TUI dispatchers submit the same rendered prompt for the same input", async () => {
		const request = "check the slash-command wiring for /qa";
		const acp = createAcpRuntime();
		const tui = createTuiRuntime();

		const acpResult = await executeAcpBuiltinSlashCommand(`/qa ${request}`, acp.runtime);
		const tuiResult = await executeBuiltinSlashCommand(`/qa ${request}`, tui.runtime);

		expect(acpResult).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		if (typeof tuiResult !== "string") {
			throw new Error(`expected TUI dispatch to return prompt text, got ${typeof tuiResult}`);
		}
		expect(tuiResult).not.toHaveLength(0);
		expect(tuiResult).toContain(request);
		expect(promptTextOf(acpResult)).toBe(tuiResult);
		expect(tui.setText).toHaveBeenCalledWith("");
	});
});
