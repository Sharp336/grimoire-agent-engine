import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import { getTranscriptDbPath } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TranscriptIndex } from "@oh-my-pi/pi-coding-agent/session/transcript-index";
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

function expectQaPhaseObligations(prompt: string) {
	expect(prompt).toMatch(/inventory/i);
	expect(prompt).toMatch(/scout/i);
	expect(prompt).toMatch(/exercise/i);
	expect(prompt).toMatch(/evidence/i);
	expect(prompt).toMatch(/report/i);
	expect(prompt).toMatch(/verdict/i);
	expect(prompt).toMatch(/no code edits/i);
}

describe("/qa slash command", () => {
	it("returns a prompt carrying the request and each phase obligation", async () => {
		const harness = createAcpRuntime();
		const request = "verify the login form submits and surfaces errors";

		const result = await executeAcpBuiltinSlashCommand(`/qa ${request}`, harness.runtime);

		expect(result).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		const prompt = promptTextOf(result);
		expect(prompt).toContain(request);
		expectQaPhaseObligations(prompt);
	});

	it("with an empty request still returns a prompt that infers scope from the working tree", async () => {
		const harness = createAcpRuntime();

		const result = await executeAcpBuiltinSlashCommand("/qa", harness.runtime);

		expect(result).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		const prompt = promptTextOf(result);
		expect(prompt.length).toBeGreaterThan(0);
		expect(prompt).toMatch(/working tree|git status|recent diff/i);
		expectQaPhaseObligations(prompt);
	});

	it("ACP handle and TUI handleTui return the same prompt text for the same input", async () => {
		const request = "check the slash-command wiring for /qa";
		const acp = createAcpRuntime();
		const tui = createTuiRuntime();

		const acpResult = await executeAcpBuiltinSlashCommand(`/qa ${request}`, acp.runtime);
		const tuiResult = await executeBuiltinSlashCommand(`/qa ${request}`, tui.runtime);

		expect(acpResult).toEqual(expect.objectContaining({ prompt: expect.any(String) }));
		if (typeof tuiResult !== "string") {
			throw new Error(`expected handleTui to return prompt text, got ${typeof tuiResult}`);
		}
		expect(promptTextOf(acpResult)).toBe(tuiResult);
		expect(tui.setText).toHaveBeenCalledWith("");
	});
});

describe("/session tag subcommands", () => {
	it("tag then tags reports the tag; untag then tags no longer reports it", async () => {
		const sessionManager = SessionManager.inMemory();
		const harness = createAcpRuntime({ sessionManager });

		expect(await executeAcpBuiltinSlashCommand("/session tag foo", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith("Tagged session: foo");
		harness.output.mockClear();

		expect(await executeAcpBuiltinSlashCommand("/session tags", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith("Tags: foo");
		harness.output.mockClear();

		expect(await executeAcpBuiltinSlashCommand("/session untag foo", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith("Untagged session: foo");
		harness.output.mockClear();

		expect(await executeAcpBuiltinSlashCommand("/session tags", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith("No tags on this session.");
		expect(sessionManager.sessionTags()).toEqual([]);
	});

	it("tag with no name is consumed and reports usage without appending an empty tag", async () => {
		const sessionManager = SessionManager.inMemory();
		const harness = createAcpRuntime({ sessionManager });

		expect(await executeAcpBuiltinSlashCommand("/session tag", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith("Usage: /session tag <name>");
		expect(sessionManager.sessionTags()).toEqual([]);

		const tui = createTuiRuntime({ sessionManager });
		expect(await executeBuiltinSlashCommand("/session tag", tui.runtime)).toBe(true);
		expect(tui.showStatus).toHaveBeenCalledWith("Usage: /session tag <name>");
	});
});

describe("/session search", () => {
	afterEach(() => {
		spyOn(TranscriptIndex, "open").mockRestore();
	});

	it("with no question reports usage and does not create the transcript database", async () => {
		const dbPath = getTranscriptDbPath();
		const existedBefore = fs.existsSync(dbPath);
		const openSpy = spyOn(TranscriptIndex, "open");
		const acp = createAcpRuntime();

		expect(await executeAcpBuiltinSlashCommand("/session search", acp.runtime)).toEqual({ consumed: true });
		expect(acp.output).toHaveBeenCalledWith("Usage: /session search <question>");

		const tui = createTuiRuntime();
		expect(await executeBuiltinSlashCommand("/session search", tui.runtime)).toBe(true);
		expect(tui.showStatus).toHaveBeenCalledWith("Usage: /session search <question>");
		expect(tui.setText).toHaveBeenCalledWith("");
		expect(openSpy).not.toHaveBeenCalled();
		if (!existedBefore) expect(fs.existsSync(dbPath)).toBe(false);
	});
});
