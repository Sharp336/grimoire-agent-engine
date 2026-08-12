import type { ImageContent } from "@oh-my-pi/pi-ai";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { parseQueueShorthand, splitQueuedMessages } from "../../modes/queue-input";
import { parseSkillInvocation } from "../../extensibility/skills";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };

const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return SHELL_PROMPT_COMMAND_RE.test(firstLine) || SHELL_PROMPT_OPERATOR_RE.test(code) || OMP_STATUS_LINE_RE.test(code);
}

function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0;
	if (trimmedText.charCodeAt(1) === 123 /* { */) return 0;
	const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

/** Parse `$ <python>` and `$$ <python>` without treating shell variables as eval input. */
export function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
	const trimmed = text.trimStart();
	const prefixLength = pythonCommandPrefixLength(trimmed);
	if (prefixLength === 0) return undefined;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return undefined;
	return { code, isExcluded: prefixLength === 2 };
}

export type ComposerSubmitMode = "primary" | "followUp";
export type ComposerStreamingBehavior = "steer" | "followUp";

export type ComposerInputDisposition =
	| { readonly kind: "noop"; readonly text: string; readonly images?: readonly ImageContent[] }
	| { readonly kind: "abort-on-empty-running-input" }
	| {
		readonly kind: "focused-agent-chat";
		readonly text: string;
		readonly images?: readonly ImageContent[];
		readonly streamingBehavior: ComposerStreamingBehavior;
	}
	| { readonly kind: "continue"; readonly text: string; readonly images?: readonly ImageContent[] }
	| {
		readonly kind: "queued-messages";
		readonly messages: readonly string[];
		readonly historyText: string;
		readonly images?: readonly ImageContent[];
		readonly streamingBehavior: "followUp";
	}
	| {
		readonly kind: "builtin";
		readonly text: string;
		readonly prompt?: string;
		readonly consumed: boolean;
	}
	| {
		readonly kind: "skill";
		readonly text: string;
		readonly images?: readonly ImageContent[];
		readonly streamingBehavior: ComposerStreamingBehavior;
	}
	| { readonly kind: "bash"; readonly command: string; readonly excludeFromContext: boolean }
	| { readonly kind: "python"; readonly code: string; readonly excludeFromContext: boolean }
	| { readonly kind: "loop"; readonly text: string }
	| { readonly kind: "compaction"; readonly text: string; readonly streamingBehavior: ComposerStreamingBehavior }
	| {
		readonly kind: "extension";
		readonly text: string;
		readonly images?: readonly ImageContent[];
		readonly streamingBehavior: ComposerStreamingBehavior;
	}
	| { readonly kind: "collaboration"; readonly text: string; readonly images?: readonly ImageContent[]; readonly reason: "host-only" | "read-only" }
	| { readonly kind: "steer"; readonly text: string; readonly images?: readonly ImageContent[] }
	| { readonly kind: "follow-up"; readonly text: string; readonly images?: readonly ImageContent[] }
	| { readonly kind: "prompt"; readonly text: string; readonly images?: readonly ImageContent[] };

export interface ComposerInputHookResult {
	readonly handled?: boolean;
	readonly text?: string;
	readonly images?: readonly ImageContent[];
}

export interface ComposerInputRouterOptions {
	readonly focusedAgentId?: string;
	readonly isStreaming: boolean;
	readonly queuedMessageCount: number;
	readonly isCompacting: boolean;
	readonly collabGuest?: { readonly readOnly: boolean };
	readonly expandEmoticons?: boolean;
	readonly expandText?: (text: string) => string;
	readonly inputHook?: (text: string, images: readonly ImageContent[] | undefined) => Promise<ComposerInputHookResult | undefined>;
	readonly builtin?: (text: string) => Promise<{ readonly consumed?: boolean; readonly prompt?: string } | undefined>;
	readonly isKnownSkillCommand?: (text: string) => boolean;
	readonly isLocalExtensionCommand?: (text: string) => boolean;
}

/**
 * Host-neutral implementation of the TUI's composer precedence rules.
 *
 * This class only classifies input and invokes narrow command/input hooks. It
 * never imports a terminal editor, session controller, or webview type, so RPC
 * and TUI callers share the same edge-case behavior.
 */
export class ComposerInputRouter {
	readonly #options: ComposerInputRouterOptions;

	constructor(options: ComposerInputRouterOptions) {
		this.#options = options;
	}

	async route(
		text: string,
		images: readonly ImageContent[] | undefined = undefined,
		mode: ComposerSubmitMode = "primary",
	): Promise<ComposerInputDisposition> {
		let normalizedText = text.trim();
		let inputImages = images && images.length > 0 ? [...images] : undefined;
		if (this.#options.expandEmoticons && normalizedText) {
			normalizedText = (this.#options.expandText ?? expandEmoticons)(normalizedText);
		}

		const streamingBehavior: ComposerStreamingBehavior = mode === "followUp" ? "followUp" : "steer";
		if (this.#options.focusedAgentId) {
			if (!normalizedText && !inputImages?.length) {
				return this.#options.isStreaming && this.#options.queuedMessageCount > 0
					? { kind: "abort-on-empty-running-input" }
					: { kind: "noop", text: normalizedText };
			}
			return { kind: "focused-agent-chat", text: normalizedText, images: inputImages, streamingBehavior };
		}

		if (!normalizedText && !inputImages?.length) {
			return this.#options.isStreaming && this.#options.queuedMessageCount > 0
				? { kind: "abort-on-empty-running-input" }
				: { kind: "noop", text: normalizedText };
		}

		if (normalizedText === "." || normalizedText === "c") {
			return { kind: "continue", text: manualContinuePrompt, images: inputImages };
		}

		if (this.#options.inputHook) {
			const hooked = await this.#options.inputHook(normalizedText, inputImages);
			if (hooked?.handled) return { kind: "extension", text: normalizedText, images: inputImages, streamingBehavior };
			if (hooked?.text !== undefined) normalizedText = hooked.text.trim();
			if (hooked?.images !== undefined) inputImages = hooked.images.length > 0 ? [...hooked.images] : undefined;
			if (!normalizedText && !inputImages?.length) return { kind: "noop", text: normalizedText };
		}

		const queueBody = parseQueueShorthand(normalizedText);
		if (queueBody !== undefined) {
			const messages = splitQueuedMessages(queueBody);
			if (messages.length === 0 && !inputImages?.length) return { kind: "noop", text: normalizedText };
			return {
				kind: "queued-messages",
				messages: messages.length > 0 ? messages : [""],
				historyText: normalizedText,
				images: inputImages,
				streamingBehavior: "followUp",
			};
		}

		if (normalizedText) {
			const builtinResult = await this.#options.builtin?.(normalizedText);
			if (builtinResult) {
				if (builtinResult.consumed) {
					return { kind: "builtin", text: normalizedText, consumed: true };
				}
				if (builtinResult.prompt !== undefined) normalizedText = builtinResult.prompt.trim();
				else return { kind: "builtin", text: normalizedText, consumed: false };
			}
		}

		if (this.#options.collabGuest) {
			if (normalizedText.startsWith("/") || normalizedText.startsWith("!") || parsePythonCommandInput(normalizedText)) {
				return { kind: "collaboration", text: normalizedText, images: inputImages, reason: "host-only" };
			}
			if (this.#options.collabGuest.readOnly) {
				return { kind: "collaboration", text: normalizedText, images: inputImages, reason: "read-only" };
			}
		}

		if (normalizedText && this.#options.isKnownSkillCommand?.(normalizedText)) {
			return { kind: "skill", text: normalizedText, images: inputImages, streamingBehavior };
		}

		if (normalizedText.startsWith("!")) {
			const excludeFromContext = normalizedText.startsWith("!!");
			const command = normalizedText.slice(excludeFromContext ? 2 : 1).trim();
			if (command) return { kind: "bash", command, excludeFromContext };
		}

		const pythonCommand = parsePythonCommandInput(normalizedText);
		if (pythonCommand?.code) {
			return { kind: "python", code: pythonCommand.code, excludeFromContext: pythonCommand.isExcluded };
		}

		if (this.#options.isCompacting) {
			return { kind: "compaction", text: normalizedText, streamingBehavior };
		}
		if (this.#options.isLocalExtensionCommand?.(normalizedText)) {
			return { kind: "extension", text: normalizedText, images: inputImages, streamingBehavior };
		}
		if (this.#options.isStreaming) {
			return streamingBehavior === "steer"
				? { kind: "steer", text: normalizedText, images: inputImages }
				: { kind: "follow-up", text: normalizedText, images: inputImages };
		}
		return { kind: "prompt", text: normalizedText, images: inputImages };
	}
}

export function routeComposerInput(
	options: ComposerInputRouterOptions,
	text: string,
	images?: readonly ImageContent[],
	mode: ComposerSubmitMode = "primary",
): Promise<ComposerInputDisposition> {
	return new ComposerInputRouter(options).route(text, images, mode);
}