/**
 * LLM classification of which folded user messages are worth preserving
 * across compaction. Used by the `"llm"` value of
 * `compaction.keepUserMessagesFilter`.
 *
 * Each message receives one durable verdict when it first enters a folded
 * region. Requests are batched only when the complete candidate set cannot
 * fit the selected tiny model; individual messages are never clipped for
 * classification. A message too large for one request is preserved
 * mechanically rather than risking a false-negative verdict.
 */

import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type completeSimple, retryTransientCompletion, type UserMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import preservedUserMessagesClassifierPrompt from "../prompts/system/preserve-user-messages-classifier.md" with {
	type: "text",
};
import preservedUserMessagesClassifierInput from "../prompts/system/preserved-user-messages-classifier-input.md" with {
	type: "text",
};
import type { UserMessageCandidate } from "./preserve-user-messages";

const CLASSIFIER_SYSTEM_PROMPT = prompt.render(preservedUserMessagesClassifierPrompt);
const CLASSIFIER_INPUT_TEMPLATE = preservedUserMessagesClassifierInput;

/** Reasoning-safe output budget for the JSON index list returned by one classifier batch. */
const CLASSIFIER_MAX_TOKENS = 4096;

/** Cap keeps the JSON index list comfortably inside the response budget. */
const CLASSIFIER_MAX_BATCH_MESSAGES = 200;

/** Provider framing and tokenizer-estimate slack outside system/input/output. */
const CLASSIFIER_CONTEXT_SLACK = 1024;

export interface ClassifyPreservedUserMessagesDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Session-owned completion transport, including provider request limits and routing settings. */
	completeImpl: typeof completeSimple;
	/** The owning session's shared secret-obfuscation boundary. */
	obfuscateTextForProvider(text: string): string | undefined;
	signal?: AbortSignal;
}

/** A folded user message to classify: its session entry id and plain text. */
export type PreservedUserMessageCandidate = UserMessageCandidate;

/**
 * Classify which folded user messages carry a lasting instruction, rule, or
 * correction worth preserving across compaction. Returns the preserved
 * message ids, or `undefined` when no model is available or the request
 * fails (the caller then falls back to the heuristic verdict).
 */
export async function classifyPreservedUserMessages(
	candidates: readonly PreservedUserMessageCandidate[],
	deps: ClassifyPreservedUserMessagesDeps,
): Promise<string[] | undefined> {
	if (candidates.length === 0) return [];
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
	const model = resolved?.model;
	if (!model) return undefined;

	const tokenizer = new Tokenizer(model);
	const contextWindow = model.contextWindow ?? 32_768;
	const inputBudget = Math.max(
		1,
		contextWindow -
			tokenizer.countTokens(CLASSIFIER_SYSTEM_PROMPT, "strict") -
			CLASSIFIER_MAX_TOKENS -
			CLASSIFIER_CONTEXT_SLACK,
	);
	const renderBatch = (batch: readonly PreservedUserMessageCandidate[]): string => {
		const rendered = prompt.render(CLASSIFIER_INPUT_TEMPLATE, {
			candidatesJson: JSON.stringify(batch.map((candidate, index) => ({ index, text: candidate.text }))),
		});
		return deps.obfuscateTextForProvider(rendered) ?? "";
	};
	const preserved = new Set<string>();
	let oversized = 0;

	const classifyBatch = async (batch: readonly PreservedUserMessageCandidate[]): Promise<boolean> => {
		const content = renderBatch(batch);
		const messages: UserMessage[] = [{ role: "user", content, timestamp: Date.now() }];
		const response = await retryTransientCompletion(
			() =>
				deps.completeImpl(
					model,
					{
						systemPrompt: [CLASSIFIER_SYSTEM_PROMPT],
						messages,
					},
					{
						apiKey: deps.registry.resolver(model, deps.sessionId),
						maxTokens: CLASSIFIER_MAX_TOKENS,
						disableReasoning: true,
						signal: deps.signal,
					},
				),
			{ signal: deps.signal },
		);
		if (!response) return false;
		const outputText = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("");
		const indices = parsePreservedIndices(outputText, batch.length);
		if (!indices) return false;
		for (const index of indices) {
			const id = batch[index]?.id;
			if (id) preserved.add(id);
		}
		return true;
	};

	let batch: PreservedUserMessageCandidate[] = [];
	for (const candidate of candidates) {
		const singleton = renderBatch([candidate]);
		if (!tokenizer.checkTokenBudget(singleton, inputBudget).fits) {
			preserved.add(candidate.id);
			oversized++;
			continue;
		}
		const next = [...batch, candidate];
		if (
			batch.length > 0 &&
			(next.length > CLASSIFIER_MAX_BATCH_MESSAGES ||
				!tokenizer.checkTokenBudget(renderBatch(next), inputBudget).fits)
		) {
			if (!(await classifyBatch(batch))) {
				logger.warn("Preserved-user-messages classifier returned no usable index list", {
					sessionId: deps.sessionId,
				});
				return undefined;
			}
			batch = [candidate];
		} else {
			batch = next;
		}
	}
	if (batch.length > 0 && !(await classifyBatch(batch))) {
		logger.warn("Preserved-user-messages classifier returned no usable index list", {
			sessionId: deps.sessionId,
		});
		return undefined;
	}

	const ids = candidates.filter(candidate => preserved.has(candidate.id)).map(candidate => candidate.id);
	logger.debug("Preserved-user-messages classifier verdict", {
		sessionId: deps.sessionId,
		total: candidates.length,
		preserved: ids.length,
		oversized,
	});
	return ids;
}

/**
 * Parse the classifier's JSON array of indices, tolerating a fenced code block
 * or surrounding prose. Returns `undefined` when the output is not a usable
 * array of in-range integer indices.
 */
function parsePreservedIndices(output: string, count: number): number[] | undefined {
	const trimmed = output.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = (fenced ? fenced[1] : trimmed).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		const arrayMatch = candidate.match(/\[[\s\S]*\]/);
		if (!arrayMatch) return undefined;
		try {
			parsed = JSON.parse(arrayMatch[0]);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(parsed)) return undefined;
	if (!parsed.every((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < count)) {
		return undefined;
	}
	const indices = parsed;
	return [...new Set(indices)].sort((a, b) => a - b);
}
