import { prompt } from "@oh-my-pi/pi-utils";
import rlmTemplate from "../prompts/rlm.md" with { type: "text" };
import { commandConsumed } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "./types";

/**
 * `/rlm` handler: flag-gated entry point into RLM (Recursive Language Model)
 * mode. When `rlm.enabled` is off, tells the operator how to enable it and
 * consumes the command. When on, renders the RLM strategy prompt combined
 * with the user's request and returns it as a `{ prompt }` so the model runs
 * the RLM strategy on that request.
 */
export async function handleRlmCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!runtime.settings.get("rlm.enabled")) {
		await runtime.output(
			"RLM mode is disabled. Enable it via the rlm.enabled setting (e.g. omp config set rlm.enabled true).",
		);
		return commandConsumed();
	}
	return { prompt: prompt.render(rlmTemplate, { request: command.args }).trim() };
}
