import { handleCouncilCommand } from "./helpers/council";
import { COUNCIL_GRAMMAR } from "./helpers/council-grammar";
import type { SlashCommandSpec } from "./types";

/**
 * Fork-local council command specs. Upstream split the builtin registry into
 * per-category modules (`builtin-{control,lifecycle,marketplace,modes,session}`);
 * the council workflow lives here so `builtin-registry.ts` composes it the same
 * way as the upstream modules.
 */
export const BUILTIN_COUNCIL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "council",
		description: "Run a multi-model planning council (spends on every configured council role)",
		acpInputHint: COUNCIL_GRAMMAR,
		inlineHint: COUNCIL_GRAMMAR,
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Show the active council run" },
			{ name: "cancel", description: "Cancel the active council run" },
			{ name: "resume", description: "Resume an interrupted council run", usage: "[run-id]" },
			{ name: "config", description: "Open council role configuration" },
		],
		handle: handleCouncilCommand,
	},
];
