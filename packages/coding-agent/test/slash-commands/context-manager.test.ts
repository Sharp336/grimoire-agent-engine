import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const CONTEXT_COMMANDS = [
	"ctx-status",
	"ctx-flush",
	"ctx-recomp",
	"ctx-wrapup",
	"ctx-aug",
	"ctx-embed",
	"ctx-session-upgrade",
	"ctx-dream",
] as const;

function runtimeWith(contextManager: object, settings = Settings.isolated()) {
	const output = vi.fn();
	const emitNotice = vi.fn();
	const freshSession = vi.fn(() => ({ refreshed: true }));
	const runtime = {
		session: {
			contextManager,
			emitNotice,
			freshSession,
			model: { provider: "test", id: "test" },
		},
		settings,
		output,
	} as unknown as SlashCommandRuntime;
	return { emitNotice, freshSession, output, runtime };
}

describe("managed-context slash commands", () => {
	it("advertises the complete cross-mode command surface", () => {
		const names = new Set(ACP_BUILTIN_SLASH_COMMANDS.map(command => command.name));
		for (const name of CONTEXT_COMMANDS) expect(names.has(name)).toBe(true);
	});

	it("runs enabled dream tasks by default and forces an explicitly named task", async () => {
		const runDreamTasks = vi.fn(async (tasks: readonly string[], _options: { readonly force?: boolean }) =>
			tasks.map(task => ({ task, status: "succeeded" as const, changed: 0, summary: `${task}: done` })),
		);
		const harness = runtimeWith({ runDreamTasks });

		await executeAcpBuiltinSlashCommand("/ctx-dream", harness.runtime);
		const defaultTasks = runDreamTasks.mock.calls[0]?.[0] ?? [];
		expect(defaultTasks).toContain("map-memories");
		expect(defaultTasks).not.toContain("maintain-docs");
		expect(runDreamTasks.mock.calls[0]?.[1]).toEqual({ force: false });

		await executeAcpBuiltinSlashCommand("/ctx-dream maintain-docs", harness.runtime);
		expect(runDreamTasks.mock.calls[1]).toEqual([["maintain-docs"], { force: true }]);
	});

	it("runs recompression in the background and reports completion as a notice", async () => {
		const pending = Promise.withResolvers<{
			status: "published";
			compartments: number;
			facts: number;
			startTag: number;
			endTag: number;
		}>();
		const harness = runtimeWith({ recomp: () => pending.promise });
		const noticed = Promise.withResolvers<void>();
		harness.emitNotice.mockImplementation(() => noticed.resolve());
		await executeAcpBuiltinSlashCommand("/ctx-recomp", harness.runtime);
		expect(harness.output).toHaveBeenCalledWith(
			"Context recomp started in the background; completion will arrive as a session notice.",
		);
		expect(harness.emitNotice).not.toHaveBeenCalled();
		pending.resolve({ status: "published", compartments: 1, facts: 0, startTag: 1, endTag: 10 });
		await noticed.promise;
		expect(harness.emitNotice).toHaveBeenCalledWith(
			"info",
			expect.stringContaining("Context recomp: published"),
			"context-manager",
		);
	});

	it("sends the original prompt when sidekick augmentation fails", async () => {
		const augmentPrompt = vi.fn(async (prompt: string) => ({
			status: "failed" as const,
			prompt,
			warning: "provider unavailable",
		}));
		const harness = runtimeWith({ augmentPrompt });
		const result = await executeAcpBuiltinSlashCommand("/ctx-aug explain this", harness.runtime);
		expect(result).toEqual({ prompt: "explain this" });
		expect(harness.output).toHaveBeenCalledWith("Sidekick failed open: provider unavailable");
	});

	it("refreshes provider state after a successful flush", async () => {
		const flush = vi.fn(async () => ({
			status: "ok" as const,
			activatedDrops: 1,
			activeDrops: 1,
			queuedDrops: 0,
			compartments: 0,
			facts: 0,
		}));
		const harness = runtimeWith({ flush });
		await executeAcpBuiltinSlashCommand("/ctx-flush", harness.runtime);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(harness.freshSession).toHaveBeenCalledTimes(1);
	});
});
