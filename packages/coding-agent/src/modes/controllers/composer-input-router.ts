import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { parseQueueShorthand } from "../../modes/queue-input";

export type ComposerSubmitMode = "primary" | "followUp";

export type ComposerInputDisposition =
	| "no_op"
	| "abort"
	| "focused_agent"
	| "continue"
	| "queue"
	| "builtin"
	| "skill"
	| "bash"
	| "python"
	| "loop"
	| "compaction"
	| "extension"
	| "steer"
	| "follow_up"
	| "prompt";

export interface ComposerDraft<Image> {
	text: string;
	images?: Image[];
	imageLinks?: (string | undefined)[];
}

export interface ComposerInputRouterState {
	readonly isFocusedAgent: boolean;
	readonly isStreaming: boolean;
	readonly queuedMessageCount: number;
	readonly isCompacting: boolean;
	readonly isCollabGuest: boolean;
	readonly isCollabReadOnly: boolean;
	readonly expandEmoticons: boolean;
}

export interface ComposerInputRouterHooks<Image> {
	focusedAgent?(draft: ComposerDraft<Image>, mode: ComposerSubmitMode): Promise<boolean>;
	abortQueued?(): Promise<void>;
	continue?(): Promise<boolean>;
	extensionInput?(draft: ComposerDraft<Image>): Promise<ComposerDraft<Image> | "handled">;
	queue?(body: string, draft: ComposerDraft<Image>): Promise<boolean>;
	builtin?(draft: ComposerDraft<Image>): Promise<"unmatched" | "consumed" | { prompt: string }>;
	collabGuest?(draft: ComposerDraft<Image>, mode: ComposerSubmitMode): Promise<boolean>;
	skill?(draft: ComposerDraft<Image>, mode: ComposerSubmitMode): Promise<boolean>;
	bash?(draft: ComposerDraft<Image>): Promise<boolean>;
	python?(draft: ComposerDraft<Image>): Promise<boolean>;
	loop?(draft: ComposerDraft<Image>): void;
	compaction?(draft: ComposerDraft<Image>, mode: ComposerSubmitMode): Promise<boolean>;
	extension?(draft: ComposerDraft<Image>): Promise<boolean>;
	dispatch(draft: ComposerDraft<Image>, mode: ComposerSubmitMode): Promise<ComposerInputDisposition>;
}

export interface ComposerInputRouterResult<Image> {
	readonly accepted: boolean;
	readonly disposition: ComposerInputDisposition;
	readonly draft: ComposerDraft<Image>;
}

const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return (
		SHELL_PROMPT_COMMAND_RE.test(firstLine) ||
		SHELL_PROMPT_OPERATOR_RE.test(firstLine) ||
		OMP_STATUS_LINE_RE.test(code)
	);
}

export function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0;
	if (trimmedText.charCodeAt(1) === 123 /* { */) return 0;

	const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

export function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
	const trimmed = text.trimStart();
	const prefixLength = pythonCommandPrefixLength(trimmed);
	if (prefixLength === 0) return undefined;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return undefined;
	return { code, isExcluded: prefixLength === 2 };
}

/**
 * Host-neutral TUI composer submission precedence. Effects remain callbacks so
 * native clients cannot manufacture TUI state; both hosts merely provide the
 * same authoritative session operations.
 */
export class ComposerInputRouter<Image> {
	constructor(
		private readonly state: ComposerInputRouterState,
		private readonly hooks: ComposerInputRouterHooks<Image>,
	) {}

	async submit(input: ComposerDraft<Image>, mode: ComposerSubmitMode = "primary"): Promise<ComposerInputRouterResult<Image>> {
		let draft: ComposerDraft<Image> = {
			...input,
			text: input.text.trim(),
			...(input.images?.length ? { images: [...input.images] } : {}),
			...(input.imageLinks?.length ? { imageLinks: [...input.imageLinks] } : {}),
		};
		if (this.state.expandEmoticons && draft.text) draft = { ...draft, text: expandEmoticons(draft.text) };
		const hasImages = (draft.images?.length ?? 0) > 0;

		if (this.state.isFocusedAgent) {
			const accepted = (await this.hooks.focusedAgent?.(draft, mode)) ?? false;
			return { accepted, disposition: "focused_agent", draft };
		}
		if (!draft.text && !hasImages) {
			if (this.state.isStreaming && this.state.queuedMessageCount > 0) {
				await this.hooks.abortQueued?.();
				return { accepted: true, disposition: "abort", draft };
			}
			return { accepted: true, disposition: "no_op", draft };
		}
		if (draft.text === "." || draft.text === "c") {
			const accepted = (await this.hooks.continue?.()) ?? false;
			return { accepted, disposition: "continue", draft };
		}
		const transformed = await this.hooks.extensionInput?.(draft);
		if (transformed === "handled") return { accepted: true, disposition: "extension", draft };
		if (transformed) draft = transformed;
		if (!draft.text && !(draft.images?.length ?? 0)) return { accepted: true, disposition: "no_op", draft };

		const queueBody = parseQueueShorthand(draft.text);
		if (queueBody !== undefined) {
			const accepted = (await this.hooks.queue?.(queueBody, draft)) ?? false;
			return { accepted, disposition: "queue", draft };
		}
		const builtin = await this.hooks.builtin?.(draft);
		if (builtin === "consumed") return { accepted: true, disposition: "builtin", draft };
		if (builtin && builtin !== "unmatched") draft = { ...draft, text: builtin.prompt };
		if (this.state.isCollabGuest) {
			const accepted = (await this.hooks.collabGuest?.(draft, mode)) ?? false;
			return { accepted, disposition: "focused_agent", draft };
		}
		if (await this.hooks.skill?.(draft, mode)) return { accepted: true, disposition: "skill", draft };
		if (await this.hooks.bash?.(draft)) return { accepted: true, disposition: "bash", draft };
		if (await this.hooks.python?.(draft)) return { accepted: true, disposition: "python", draft };
		this.hooks.loop?.(draft);
		if (this.state.isCompacting && (await this.hooks.compaction?.(draft, mode))) {
			return { accepted: true, disposition: "compaction", draft };
		}
		if (await this.hooks.extension?.(draft)) return { accepted: true, disposition: "extension", draft };
		const disposition = await this.hooks.dispatch(draft, mode);
		return { accepted: true, disposition, draft };
	}
}
