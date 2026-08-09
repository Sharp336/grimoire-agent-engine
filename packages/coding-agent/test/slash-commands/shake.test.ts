import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const shake = vi.fn(async (mode: ShakeMode) => ({
		mode,
		toolResultsDropped: mode === "elide" ? 1 : 0,
		blocksDropped: 0,
		imagesDropped: mode === "images" ? 1 : undefined,
		tokensFreed: mode === "elide" ? 100 : 0,
	}));
	const output = vi.fn();
	const runtime = { session: { shake }, output } as unknown as SlashCommandRuntime;
	return { shake, output, runtime };
}

function tuiRuntime() {
	const handleShakeCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const showWarning = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handleShakeCommand,
			showWarning,
		} as unknown as InteractiveModeContext,
	};
	return { handleShakeCommand, setText, showWarning, runtime };
}

describe("/shake dispatch (ACP)", () => {
	it("defaults to elide with no subcommand", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/shake", h.runtime);
		expect(h.shake).toHaveBeenCalledWith("elide");
	});

	it("parses each explicit mode", async () => {
		for (const mode of ["elide", "images"] as const) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(`/shake ${mode}`, h.runtime);
			expect(h.shake).toHaveBeenCalledTimes(1);
			expect(h.shake).toHaveBeenCalledWith(mode);
		}
	});

	it("runs combined modes in the order given and reports one merged summary", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/shake elide images", h.runtime);
		expect(h.shake.mock.calls.map(c => c[0])).toEqual(["elide", "images"]);
		expect(h.output).toHaveBeenCalledWith("Shook 1 tool result + 1 image (~100 tokens freed).");
	});

	it("accepts the singular image alias and collapses duplicate modes", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/shake image images elide elide", h.runtime);
		expect(h.shake.mock.calls.map(c => c[0])).toEqual(["images", "elide"]);
	});

	it("rejects an unknown mode without invoking shake", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/shake bogus", h.runtime);
		expect(h.shake).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("bogus");
	});

	it("is advertised to ACP clients with the mode hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "shake");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[elide|images ...]");
	});

	it("advertises /shake images as the image-stripping path and no longer advertises /drop-images", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(c => c.name === "shake")).toBe(true);
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(c => c.name === "drop-images")).toBe(false);
	});
});

describe("/shake dispatch (TUI)", () => {
	it("routes the parsed modes to handleShakeCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/shake images", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handleShakeCommand).toHaveBeenCalledWith(["images"]);
	});

	it("routes combined modes as one call", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake elide images", h.runtime);
		expect(h.handleShakeCommand).toHaveBeenCalledWith(["elide", "images"]);
	});

	it("defaults to elide for a bare /shake", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake", h.runtime);
		expect(h.handleShakeCommand).toHaveBeenCalledWith(["elide"]);
	});

	it("warns on an unknown mode and does not run a shake", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake nope", h.runtime);
		expect(h.handleShakeCommand).not.toHaveBeenCalled();
		expect(h.showWarning).toHaveBeenCalled();
	});
});
