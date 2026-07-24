import { escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import sidekickAugmentationTemplate from "../prompts/context-manager/sidekick-augmentation.md" with { type: "text" };
import sidekickSystemPrompt from "../prompts/context-manager/sidekick-system.md" with { type: "text" };
import sidekickTurnTemplate from "../prompts/context-manager/sidekick-turn.md" with { type: "text" };
import type { ContextAgentRunner } from "./agent-runner";
import type { ContextPromptAugmentResult } from "./types";

const SIDEKICK_TOOL_NAMES = ["ctx_search", "ctx_expand", "read", "grep", "glob"] as const;
const EMPTY_RESULT = "NO_RELEVANT_CONTEXT";
const renderSidekickAugmentation = prompt.compile(sidekickAugmentationTemplate);

function cleanSidekickOutput(value: string): string {
	return value
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
		.trim();
}

function isEmptySidekickOutput(value: string): boolean {
	const normalized = value
		.trim()
		.toUpperCase()
		.replace(/[.!]+$/, "");
	return normalized === EMPTY_RESULT || normalized.length < 16;
}

/** Runs the optional read-only sidekick and fails open to the user's original prompt. */
export class ContextSidekick {
	readonly #settings: Settings;
	readonly #runner: ContextAgentRunner;

	constructor(settings: Settings, runner: ContextAgentRunner) {
		this.#settings = settings;
		this.#runner = runner;
	}

	async augment(userPrompt: string, signal?: AbortSignal): Promise<ContextPromptAugmentResult> {
		if (!this.#settings.get("contextManager.sidekick.enabled")) {
			return { status: "disabled", prompt: userPrompt };
		}
		const candidates = this.#runner.resolveCandidates("sidekick");
		if (candidates.length === 0) {
			return { status: "failed", prompt: userPrompt, warning: "No sidekick model is available" };
		}
		const turn = prompt.render(sidekickTurnTemplate, {
			prompt: escapeXmlText(userPrompt),
			language: this.#settings.get("contextManager.language"),
		});
		let lastError = "Sidekick candidates returned no usable output";
		for (const candidate of candidates) {
			try {
				const raw = await this.#runner.run({
					candidate,
					systemPrompt: sidekickSystemPrompt,
					userPrompt: turn,
					toolNames: SIDEKICK_TOOL_NAMES,
					timeoutMs: this.#settings.get("contextManager.sidekick.timeoutMs"),
					signal,
				});
				const augmentation = cleanSidekickOutput(raw);
				if (isEmptySidekickOutput(augmentation)) return { status: "no-context", prompt: userPrompt };
				return {
					status: "augmented",
					prompt: renderSidekickAugmentation({
						original: userPrompt,
						augmentation: escapeXmlText(augmentation),
					}).replace(/\n$/, ""),
					augmentation,
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error instanceof Error ? error.message : String(error);
				logger.debug("Managed-context sidekick candidate failed", {
					model: candidate.selector,
					error: lastError,
				});
			}
		}
		return { status: "failed", prompt: userPrompt, warning: lastError };
	}
}
