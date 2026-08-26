/**
 * Generate session titles using a smol, fast model.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as path from "node:path";

import { type Api, type AssistantMessage, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { StreamMarkupHealing } from "@oh-my-pi/pi-ai/utils/stream-markup-healing";
import { isConPTYHosted, writeThroughActiveTerminal } from "@oh-my-pi/pi-tui";
import { isTerminalHeadless, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleMarkerInstruction from "../prompts/system/title-marker-instruction.md" with { type: "text" };
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { formatTitleUserMessage } from "../tiny/message-preproc";
import { isTinyTitleLocalModelKey, ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);
const TITLE_MARKER_INSTRUCTION = prompt.render(titleMarkerInstruction);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Emit a raw title escape sequence. While the TUI owns stdout its frames are
 * written by an off-thread pump, and a direct `process.stdout.write` can land
 * mid-frame — inside a torn escape sequence — making the terminal print the
 * title payload as text into the viewport. Route through the active terminal's
 * write path; fall back to stdout only when no TUI has the terminal.
 */
function writeTitleSequence(seq: string): void {
	if (!writeThroughActiveTerminal(seq)) process.stdout.write(seq);
}

interface WindowsConsoleTitleApi {
	set(title: string): boolean;
	close(): void;
}

let windowsConsoleTitleApi: WindowsConsoleTitleApi | null | undefined;
let lastTerminalTitle: string | undefined;

function getWindowsConsoleTitleApi(): WindowsConsoleTitleApi | null {
	if (process.platform !== "win32") return null;
	if (windowsConsoleTitleApi !== undefined) return windowsConsoleTitleApi;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			SetConsoleTitleW: { args: [FFIType.ptr], returns: FFIType.bool },
		});
		windowsConsoleTitleApi = {
			set(title) {
				const wideTitle = Buffer.from(`${title}\0`, "utf16le");
				return kernel32.symbols.SetConsoleTitleW(ptr(wideTitle));
			},
			close: () => kernel32.close(),
		};
	} catch {
		windowsConsoleTitleApi = null;
	}
	return windowsConsoleTitleApi;
}

function setWindowsConsoleTitle(title: string): boolean {
	const api = getWindowsConsoleTitleApi();
	if (!api) return false;
	try {
		return api.set(title);
	} catch {
		try {
			api.close();
		} catch {
			// Ignore cleanup failures after the native title path has already failed.
		}
		windowsConsoleTitleApi = null;
		return false;
	}
}

function disposeWindowsConsoleTitleApi(): void {
	try {
		windowsConsoleTitleApi?.close();
	} catch {
		// Terminal teardown must remain best-effort.
	}
	windowsConsoleTitleApi = undefined;
}

// Cover the "backend ignores `disableReasoning`" case unconditionally: the
// static `model.reasoning` catalog flag can't distinguish a thinking model that
// was declared with `reasoning: false` (e.g. Qwen3 served locally via llama.cpp,
// whose bundled jinja chat template forces `enable_thinking: true`) from one
// that never emits thinking. `maxTokens` is a hard cap, not a target — the
// happy-path completion still returns in a handful of tokens, so raising the
// ceiling costs nothing when thinking is genuinely suppressed and keeps the
// `<title>` marker output reachable when it isn't (issue #4355).
const TITLE_MAX_TOKENS = 1024;

/** Matches the title the model wraps in `<title>...</title>`. */
const TITLE_MARKER_GLOBAL_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>|<title>\s*$/gi;
const TITLE_VISIBILITY_SENTINEL = "\uE000omp-title-visible\uE000";
const THINKING_TAG_ENVELOPE_RE = /<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>/gi;
const THINKING_FENCE_ENVELOPE_RE = /```(?:thinking|reasoning)\b[\s\S]*?```/gi;
const LEADING_THINKING_TAG_RE = /^\s*<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>\s*/i;
const LEADING_THINKING_FENCE_RE = /^\s*```(?:thinking|reasoning)\b[\s\S]*?```\s*/i;
const LEADING_PROSE_THINKING_PREAMBLE_RE =
	/^[ \t]*(?:(?:here(?:['’]s| is)[ \t]+(?:a|the|my)[ \t]+)|my[ \t]+)?(?:thinking|thought|reasoning)[ \t]+process[ \t]*:?[ \t]*(?:\r?\n|$)/i;

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["tiny", "commit", "smol"], settings, availableModels)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used to derive title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 * @param customSystemPrompt Optional title-specific system prompt override
 * @param signal Session-lifecycle cancellation for background title requests
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	// Defer titling for greetings / acknowledgements / empty input. The default
	// tiny title model can't reliably decline trivial input, so this happens
	// deterministically before any model is invoked; the caller retries on the
	// next user message while the session stays unnamed.
	if (isLowSignalTitleInput(firstMessage)) {
		logger.debug("title-generator: skipped low-signal input", { sessionId, reason: "low-signal" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	const tinyModel = settings.get("providers.tinyModel");
	if (tinyModel === ONLINE_TINY_TITLE_MODEL_KEY) {
		return generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			signal,
			titleSystemPrompt,
		);
	}

	// User explicitly picked a local tiny model. NEVER fall back to the online
	// smol path (issue #3187): the smol role resolves through priority.json and
	// silently bills whatever provider holds the resolved API key — OpenRouter
	// in the reporter's case, leaking real credits without consent. If the
	// local worker fails (unknown key, download missing, transformers.js
	// crash, abort), leave the session untitled; the next user turn retries.
	if (!isTinyTitleLocalModelKey(tinyModel)) {
		logger.warn("title-generator: unknown local tiny model; skipping title (will not fall back to online)", {
			sessionId,
			model: tinyModel,
			reason: "unknown-local-model",
		});
		return null;
	}
	try {
		let localTitle: string | null;
		if (signal) {
			localTitle = await tinyTitleClient.generate(
				tinyModel,
				firstMessage,
				titleSystemPrompt ? { signal, systemPrompt: titleSystemPrompt } : { signal },
			);
		} else if (titleSystemPrompt) {
			localTitle = await tinyTitleClient.generate(tinyModel, firstMessage, { systemPrompt: titleSystemPrompt });
		} else {
			localTitle = await tinyTitleClient.generate(tinyModel, firstMessage);
		}
		if (!localTitle) {
			logger.warn("title-generator: local tiny model produced no title; skipping (no online fallback)", {
				sessionId,
				model: tinyModel,
				reason: "local-no-output",
			});
			return null;
		}
		return localTitle;
	} catch (err) {
		logger.warn("title-generator: local tiny model errored; skipping (no online fallback)", {
			sessionId,
			model: tinyModel,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export async function generateTitleOnline(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	// The model is always asked to wrap the title in `<title>...</title>` and
	// the title is parsed from text. A forced `set_title` tool call was the old
	// scheme, but hosts that ignore or reject forced `tool_choice` then echoed
	// the prompt's `{"title": ...}` JSON example verbatim as the session title;
	// markers work uniformly everywhere.
	const systemPrompt = titleSystemPrompt ? [titleSystemPrompt, TITLE_MARKER_INSTRUCTION] : [TITLE_SYSTEM_PROMPT];
	const userMessage = formatTitleUserMessage(firstMessage);
	const modelName = `${model.provider}/${model.id}`;
	const modelContext = {
		sessionId,
		provider: model.provider,
		id: model.id,
		model: modelName,
	};
	logger.debug("title-generator: start", modelContext);

	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.warn("title-generator: no API key", { ...modelContext, reason: "missing-api-key" });
			return null;
		}
		// Resolve metadata after getApiKey so the session-sticky credential for this
		// request is already recorded; metadataResolver can then return the correct
		// account_uuid rather than the snapshot-at-call-site value.
		const metadata = metadataResolver?.(model.provider);

		// Title generation is a 3-7 word task, but the ceiling has to survive
		// backends that ignore `disableReasoning` (see TITLE_MAX_TOKENS above).
		const maxTokens = TITLE_MAX_TOKENS;
		logger.debug("title-generator: request", { ...modelContext, maxTokens });

		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{
						systemPrompt,
						messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
					},
					{
						apiKey: registry.resolver(model, sessionId),
						maxTokens,
						disableReasoning: true,
						// Greedy decode: titling is extraction, not generation. Backends that
						// default temperature high (e.g. Ollama's 0.8) otherwise garble names
						// from the message ("hashline" → "HasHroshi"). Providers whose models
						// reject sampling params drop this via `supportsSamplingParams`.
						temperature: 0,
						metadata,
						signal,
					},
				),
			{ signal },
		);

		if (response.stopReason === "error") {
			logger.warn("title-generator: response error", {
				...modelContext,
				reason: "provider-response-error",
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content), firstMessage);

		if (!title) {
			logger.debug("title-generator: no title returned", {
				...modelContext,
				reason: "model-returned-none",
				usage: response.usage,
				stopReason: response.stopReason,
			});
			return null;
		}

		logger.debug("title-generator: success", {
			...modelContext,
			title,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		return title;
	} catch (err) {
		logger.warn("title-generator: error", {
			...modelContext,
			reason: "exception",
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	// Stay lenient: prefer the first closed title marker in visible text, then
	// fall back to a plain sentence after stripping only known leading leaked
	// thinking envelopes plus any stray/unclosed title tag fragment. Reject a
	// prose thinking preamble only on the markerless path: a later marked title
	// remains authoritative.
	const markedTitle = extractVisibleMarkedTitle(textTitle);
	if (markedTitle !== undefined) return unwrapJsonTitle(markedTitle);
	const cleanedTextTitle = stripLeadingLeakedThinkingMarkup(textTitle)
		.replace(/<\/?title>/gi, "")
		.trim();
	if (LEADING_PROSE_THINKING_PREAMBLE_RE.test(cleanedTextTitle)) return "";
	return unwrapJsonTitle(cleanedTextTitle);
}

function extractVisibleMarkedTitle(text: string): string | undefined {
	TITLE_MARKER_GLOBAL_RE.lastIndex = 0;
	let marker: RegExpExecArray | null = TITLE_MARKER_GLOBAL_RE.exec(text);
	while (marker !== null) {
		const content = marker[1];
		if (isVisibleTitleMarker(text, marker.index)) return content?.trim() ?? "";
		marker = TITLE_MARKER_GLOBAL_RE.exec(text);
	}
	return undefined;
}

function isVisibleTitleMarker(text: string, markerIndex: number): boolean {
	if (isInsideKnownThinkingEnvelope(text, markerIndex)) return false;
	return stripLeakedThinkingMarkup(`${text.slice(0, markerIndex)}${TITLE_VISIBILITY_SENTINEL}`).endsWith(
		TITLE_VISIBILITY_SENTINEL,
	);
}

function isInsideKnownThinkingEnvelope(text: string, index: number): boolean {
	return (
		isInsideEnvelopeMatchedBy(THINKING_TAG_ENVELOPE_RE, text, index) ||
		isInsideEnvelopeMatchedBy(THINKING_FENCE_ENVELOPE_RE, text, index)
	);
}

function isInsideEnvelopeMatchedBy(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = 0;
	let marker = pattern.exec(text);
	while (marker !== null) {
		const start = marker.index;
		const end = start + marker[0].length;
		if (index > start && index < end) return true;
		if (start > index) return false;
		marker = pattern.exec(text);
	}
	return false;
}

function stripLeadingLeakedThinkingMarkup(text: string): string {
	let current = text;
	while (true) {
		const withoutTag = current.replace(LEADING_THINKING_TAG_RE, "");
		const withoutFence = withoutTag.replace(LEADING_THINKING_FENCE_RE, "");
		if (withoutFence === current) return current;
		current = withoutFence;
	}
}

function stripLeakedThinkingMarkup(text: string): string {
	const healer = new StreamMarkupHealing({ pattern: "thinking" });
	return healer.feed(text) + healer.flushPending();
}

/**
 * Unwrap a JSON-shaped response (`{"title": "..."}`, optionally code-fenced)
 * into the bare title. Models occasionally emit the structured shape they were
 * trained on for title tasks instead of plain text; without this the raw JSON
 * became the session title.
 */
function unwrapJsonTitle(candidate: string): string {
	const text = candidate
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/, "")
		.trim();
	if (!text.startsWith("{")) return candidate;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
			return parsed.title.trim();
		}
	} catch {
		// Truncated/malformed JSON: salvage the quoted title value if present.
		const quoted = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
		if (quoted) {
			const salvaged: unknown = JSON.parse(quoted[1]);
			if (typeof salvaged === "string") return salvaged.trim();
		}
	}
	return candidate;
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function formatSessionTerminalTitle(sessionName: string | undefined, cwd?: string): string {
	const label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
}

/**
 * Set the terminal title through the native Win32 API or OSC 0.
 *
 * Repeating the same sanitized title is a no-op on every platform.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const next = sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE;
	if (next === lastTerminalTitle) return;
	if (!setWindowsConsoleTitle(next)) writeTitleSequence(`\x1b]0;${next}\x07`);
	lastTerminalTitle = next;
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	// An authoritative session title (rename, new session, focus swap) supersedes
	// any extension override so the base title tracks the real session again.
	terminalTitleRuntime.extensionOverride = undefined;
	terminalTitleRuntime.label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	emitTerminalTitle();
}

/**
 * Set a terminal title from an extension's `setTitle()`. Unlike the session base
 * title, this owns the terminal verbatim: periodic and run-state updates will not
 * rewrite it. Cleared when the app next sets an authoritative session title via
 * {@link setSessionTerminalTitle}.
 */
export function setExtensionTerminalTitle(title: string): void {
	terminalTitleRuntime.extensionOverride = title;
	emitTerminalTitle();
}

export type TerminalTitleState = "idle" | "working" | "attention" | "notify";

/** Windows uses a static working separator instead of scheduling title animation. */
const WINDOWS_TITLE_WORKING_SEPARATOR = ":";
const TITLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLE_SPINNER_INTERVAL_MS = 80;
/** The user's turn: the title reads like a shell prompt awaiting input. */
const TITLE_IDLE_SEPARATOR = ">";
/** Agent blocked on the user (ask / approval prompt). */
const TITLE_ATTENTION_SEPARATOR = "!";
/** A finished turn whose result the user hasn't read: the title carries the
 *  static `:>` separator (working's `:` + your-turn's `>`). */
const TITLE_NOTIFY_SEPARATOR = ":>";
/** Windows Terminal tab tint per needing-user state (DECAC palette indices —
 *  they follow the user's terminal scheme): red while the agent is blocked on
 *  the user, yellow when a finished turn's result is unread. Working/idle
 *  never paint: they restore the default tab color. */
const TAB_COLOR_STATE_INDEX: Record<Extract<TerminalTitleState, "attention" | "notify">, number> = {
	attention: 1,
	notify: 3,
};
/** DECAC foreground index. Windows Terminal ignores it and auto-picks a
 *  contrasting tab-text color. */
const TAB_COLOR_FG_INDEX = 15;
/** Restore the default tab color via the VT default fg/bg sentinels (263/264,
 *  outside the 256-color table). Empirically, only this exact sequence resets
 *  the tab — omitted-param forms and DECSTR do not. */
const TAB_COLOR_RESET_SEQUENCE = "\x1b[2;263;264,|";
/** CSI ?1004 focus state: true while the terminal tab is active. Launching
 *  implies presence; a later focus-out report flips it. */
let terminalFocus = true;

const terminalTitleRuntime: {
	label: string | undefined;
	state: TerminalTitleState;
	frame: number;
	enabled: boolean;
	timer: NodeJS.Timeout | undefined;
	/** DECAC palette index of the tint currently applied to the WT tab, or
	 *  `undefined` when the tab shows its default color. Gates both lazy paint
	 *  (idle-only sessions never paint) and dedup (skip repainting the same
	 *  tint; reset only when a tint is actually applied). */
	tabColorIndex: number | undefined;
	/** A title an extension set via `setTitle()`. While set, it owns the terminal
	 *  title verbatim: the run-state separator never rewrites it. Cleared when the
	 *  app next establishes an authoritative session title (rename, new session,
	 *  focus swap) via `setSessionTerminalTitle`. */
	extensionOverride: string | undefined;
} = {
	label: undefined,
	state: "idle",
	frame: 0,
	enabled: true,
	timer: undefined,
	extensionOverride: undefined,
	tabColorIndex: undefined,
};

/**
 * Compose the terminal title from the `π` brand, a state-carrying separator, and
 * the session label. Pure (no I/O) so the state→separator contract is testable:
 *   - `idle` (user's turn):  `π > label`;
 *   - `working`:             `π ⠋ label` (`π : label` on Windows);
 *   - `attention`:           `π ! label`;
 *   - `notify`:              `π :> label` (static on all platforms);
 *   - disabled:              `π: label`.
 * Without a label the separator trails the brand (`π >`) so the state stays visible.
 */
export function buildTerminalTitleWithState(
	label: string | undefined,
	state: TerminalTitleState,
	frame: number,
	enabled: boolean,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!enabled) return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
	if (state === "notify") {
		const base = `${DEFAULT_TERMINAL_TITLE} ${TITLE_NOTIFY_SEPARATOR}`;
		return label ? `${base} ${label}` : base;
	}
	const separator =
		state === "working"
			? platform === "win32"
				? WINDOWS_TITLE_WORKING_SEPARATOR
				: TITLE_SPINNER_FRAMES[frame % TITLE_SPINNER_FRAMES.length]
			: state === "attention"
				? TITLE_ATTENTION_SEPARATOR
				: TITLE_IDLE_SEPARATOR;
	return label ? `${DEFAULT_TERMINAL_TITLE} ${separator} ${label}` : `${DEFAULT_TERMINAL_TITLE} ${separator}`;
}

function emitTerminalTitle(): void {
	// An extension override owns the terminal verbatim; the terminal sink
	// deduplicates repeated state updates.
	const next =
		terminalTitleRuntime.extensionOverride ??
		buildTerminalTitleWithState(
			terminalTitleRuntime.label,
			terminalTitleRuntime.state,
			terminalTitleRuntime.frame,
			terminalTitleRuntime.enabled,
			isConPTYHosted() ? "win32" : process.platform,
		);
	setTerminalTitle(next);
}
/**
 * Build the DECAC sequence for a run state: the tint (`CSI 2;15;<bg-index>,|`)
 * for attention/notify, or the reset restoring the default tab color (`CSI
 * 2;263;264,|`) for working/idle. Pure so the wire bytes are testable; Windows
 * Terminal is the only known implementor of the frame color item, so callers
 * must gate on it.
 */
export function buildTabColorSequence(state: TerminalTitleState): string {
	if (state === "attention" || state === "notify") {
		return `\x1b[2;${TAB_COLOR_FG_INDEX};${TAB_COLOR_STATE_INDEX[state]},|`;
	}
	return TAB_COLOR_RESET_SEQUENCE;
}

/** Tint the Windows Terminal tab for `state`. No-op anywhere else, in headless
 *  mode, while the `tui.titleState` signal is off, and — lazily — until the
 *  agent first needs the user, so a quiet session never clobbers a tab color
 *  the user set by hand. Repaints only when the applied tint changes. The
 *  notify tint is bell-semantics: painted only while the tab is inactive. */
function paintTabColorState(state: TerminalTitleState): void {
	if (!terminalTitleRuntime.enabled) return;
	if (isTerminalHeadless()) return;
	if (process.platform !== "win32" || process.env.WT_SESSION === undefined) return;
	if (state === "attention" || state === "notify") {
		if (state === "notify" && terminalFocus) {
			// A focused agent_end is already visible to the user: no bell tint,
			// but clear any tint a prior state left applied so red never
			// lingers until a later transition.
			if (terminalTitleRuntime.tabColorIndex === undefined) return;
			terminalTitleRuntime.tabColorIndex = undefined;
			writeTitleSequence(buildTabColorSequence("idle"));
			return;
		}
		const index = TAB_COLOR_STATE_INDEX[state];
		if (terminalTitleRuntime.tabColorIndex === index) return;
		terminalTitleRuntime.tabColorIndex = index;
	} else if (terminalTitleRuntime.tabColorIndex === undefined) {
		return;
	} else {
		terminalTitleRuntime.tabColorIndex = undefined;
	}
	writeTitleSequence(buildTabColorSequence(state));
}

/** Clear any tab tint this process applied: repaint the default tab color and
 *  return to the lazy (never-painted) state. No-op unless we actually painted. */
function resetTabColorToIdle(): void {
	if (terminalTitleRuntime.tabColorIndex === undefined) return;
	terminalTitleRuntime.tabColorIndex = undefined;
	writeTitleSequence(buildTabColorSequence("idle"));
}

function stopTerminalTitleSpinner(): void {
	clearInterval(terminalTitleRuntime.timer);
	terminalTitleRuntime.timer = undefined;
}

function startTerminalTitleSpinner(): void {
	if (isConPTYHosted() || terminalTitleRuntime.timer || !process.stdout.isTTY) return;
	terminalTitleRuntime.timer = setInterval(() => {
		terminalTitleRuntime.frame = (terminalTitleRuntime.frame + 1) % TITLE_SPINNER_FRAMES.length;
		emitTerminalTitle();
	}, TITLE_SPINNER_INTERVAL_MS);
	// Never keep the event loop alive for a cosmetic animation.
	terminalTitleRuntime.timer.unref?.();
}

/**
 * Reflect the agent run state in the terminal title's separator: `working`
 * animates outside Windows and stays `:` on Windows, `idle` shows `>` (your
 * turn), `attention` shows `!` (agent blocked on you), and `notify` shows `:>`
 * (a finished turn's result is unread). Gated off by `tui.titleState`.
 */
export function setTerminalTitleState(state: TerminalTitleState): void {
	terminalTitleRuntime.state = state;
	paintTabColorState(state);
	if (state === "working" && terminalTitleRuntime.enabled) startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

/**
 * Track terminal focus (CSI ?1004 reports wired through the TUI). Defaults to
 * focused — launching implies presence; a later departure emits focus-out.
 * Focus-in while a finished-turn yellow tint is showing clears it (bell
 * semantics); the title state is untouched.
 */
export function setTerminalFocus(focused: boolean): void {
	terminalFocus = focused;
	if (
		focused &&
		terminalTitleRuntime.state === "notify" &&
		terminalTitleRuntime.tabColorIndex === TAB_COLOR_STATE_INDEX.notify
	) {
		terminalTitleRuntime.tabColorIndex = undefined;
		writeTitleSequence(buildTabColorSequence("idle"));
	}
}

/** Enable/disable the run-state separator (driven by the `tui.titleState` setting). */
export function setTerminalTitleStateEnabled(enabled: boolean): void {
	terminalTitleRuntime.enabled = enabled;
	if (!enabled) resetTabColorToIdle();
	if (enabled && terminalTitleRuntime.state === "working") startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

/** Release terminal-title runtime resources. */
export function disposeTerminalTitleState(): void {
	stopTerminalTitleSpinner();
	resetTabColorToIdle();
	disposeWindowsConsoleTitleApi();
	lastTerminalTitle = undefined;
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[23;2t");
}
