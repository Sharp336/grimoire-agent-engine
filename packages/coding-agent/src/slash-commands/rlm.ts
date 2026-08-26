import { prompt } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import rlmTemplate from "../prompts/rlm.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
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
	// RLM's whole workflow runs inside the eval sandbox (context/metadata/chunk/
	// llm_query), and only the Python and JS preludes implement those helpers
	// (rb/jl do not). Without py or js enabled, the strategy prompt below would
	// hand the model instructions it has no tool to execute.
	const backends = resolveEvalBackends({ settings: runtime.settings } as ToolSession);
	if (!backends.python && !backends.js) {
		await runtime.output(
			"RLM mode requires the Python or JavaScript eval backend (the RLM helpers are not implemented for Ruby/Julia), but neither is enabled in this session (eval.py/eval.js are off or PI_PY/PI_JS disable them). Enable one before using /rlm.",
		);
		return commandConsumed();
	}
	const args = command.args.trim();
	if (!args) {
		return { prompt: prompt.render(rlmTemplate, { request: "(no request text provided)" }).trim() };
	}
	// Externalize the inline payload into a session-local file instead of
	// interpolating it into the prompt: the whole point of RLM is to keep
	// oversized input out of the model's context, so the prompt must carry
	// only a reference the model loads from inside the eval sandbox. The
	// load-instruction prose itself lives in rlm.md (never build prompts in
	// code), rendered with the externalized-payload variables below.
	const localProtocolOptions = {
		getArtifactsDir: () => runtime.sessionManager.getArtifactsDir(),
		getSessionId: () => runtime.sessionManager.getSessionId(),
	};
	const inputUrl = `local://rlm-input-${Date.now()}.txt`;
	const inputPath = resolveLocalUrlToPath(inputUrl, localProtocolOptions);
	await Bun.write(inputPath, args);
	return {
		prompt: prompt.render(rlmTemplate, { externalized: true, inputUrl, charCount: args.length }).trim(),
	};
}
