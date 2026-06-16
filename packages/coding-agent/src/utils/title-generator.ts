/**
 * Generate session titles using a smol, fast model.
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleMarkerInstruction from "../prompts/system/title-marker-instruction.md" with { type: "text" };
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import titleMarkerSystemPrompt from "../prompts/system/title-system-marker.md" with { type: "text" };
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { formatTitleUserMessage, isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);
const TITLE_MARKER_SYSTEM_PROMPT = prompt.render(titleMarkerSystemPrompt);
const TITLE_MARKER_INSTRUCTION = prompt.render(titleMarkerInstruction);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export const TITLE_LOCAL_FALLBACK_DELAY_MS = 10_000;
const TITLE_MAX_TOKENS = 30;
const REASONING_SAFE_MAX_TOKENS = 1024;
const SET_TITLE_TOOL_NAME = "set_title";

const setTitleTool: Tool = {
	name: SET_TITLE_TOOL_NAME,
	description: "Set the generated session title.",
	parameters: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description:
					'The generated session title, or exactly "none" when the message carries no concrete task yet.',
			},
		},
		required: ["title"],
		additionalProperties: false,
	},
};

/** Matches the title a tool-choice-less model wraps in `<title>...</title>`. */
const TITLE_MARKER_RE = /<title>([\s\S]*?)<\/title>/i;

/**
 * Whether the model honors a forced `tool_choice` so the `set_title` tool can be
 * required. Providers/models that reject forced tool calls (chat-completions
 * hosts without `tool_choice` support, Claude Fable/Mythos) can't be made to
 * emit a structured call, so the caller falls back to marker-wrapped text.
 */
function modelSupportsForcedToolChoice(model: Model<Api>): boolean {
	// `compat` is a union across APIs and `supportsToolChoice` lives only on the
	// OpenAI-completions variant, so read both flags through a structural view.
	const compat = model.compat as { supportsToolChoice?: boolean; supportsForcedToolChoice?: boolean } | undefined;
	if (!compat) return true;
	// A forced tool call first requires sending `tool_choice` at all. Hosts that
	// drop the parameter entirely (`supportsToolChoice: false`, e.g. direct
	// DeepSeek reasoning) can never be forced even when they otherwise accept
	// forced values, so this veto wins over `supportsForcedToolChoice`.
	if (compat.supportsToolChoice === false) return false;
	if (typeof compat.supportsForcedToolChoice === "boolean") return compat.supportsForcedToolChoice;
	if (typeof compat.supportsToolChoice === "boolean") return compat.supportsToolChoice;
	return true;
}

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["title", "commit", "smol"], settings, availableModels, registry)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

export async function raceFirstNonNull<T>(
	primary: Promise<T | null>,
	startFallback: () => Promise<T | null>,
	delayMs: number = TITLE_LOCAL_FALLBACK_DELAY_MS,
	onPrimaryWinAfterFallback?: () => void,
): Promise<T | null> {
	const { promise, resolve } = Promise.withResolvers<T | null>();
	let resolved = false;
	let primarySettled = false;
	let fallbackStarted = false;
	let fallbackSettled = false;

	const resolveOnce = (value: T | null): void => {
		if (resolved) return;
		resolved = true;
		resolve(value);
	};
	const maybeResolveNull = (): void => {
		if (primarySettled && fallbackStarted && fallbackSettled) resolveOnce(null);
	};
	const startFallbackOnce = (): void => {
		if (fallbackStarted || resolved) return;
		fallbackStarted = true;
		let fallback: Promise<T | null>;
		try {
			fallback = startFallback();
		} catch {
			fallbackSettled = true;
			maybeResolveNull();
			return;
		}
		void fallback.then(
			value => {
				fallbackSettled = true;
				if (value !== null) resolveOnce(value);
				else maybeResolveNull();
			},
			() => {
				fallbackSettled = true;
				maybeResolveNull();
			},
		);
	};

	const timer = setTimeout(startFallbackOnce, delayMs);
	void primary.then(
		value => {
			primarySettled = true;
			clearTimeout(timer);
			if (value !== null) {
				if (fallbackStarted) onPrimaryWinAfterFallback?.();
				resolveOnce(value);
				return;
			}
			startFallbackOnce();
			maybeResolveNull();
		},
		() => {
			primarySettled = true;
			clearTimeout(timer);
			startFallbackOnce();
			maybeResolveNull();
		},
	);

	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
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
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
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
			undefined,
			titleSystemPrompt,
		);
	}

	const onlineAbortController = new AbortController();
	const localTitlePromise = titleSystemPrompt
		? tinyTitleClient.generate(tinyModel, firstMessage, { systemPrompt: titleSystemPrompt })
		: tinyTitleClient.generate(tinyModel, firstMessage);
	const localTitle = localTitlePromise.then(
		title => title || null,
		err => {
			logger.warn("title-generator: local model error", {
				sessionId,
				model: tinyModel,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		},
	);
	const startOnline = (): Promise<string | null> =>
		generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			onlineAbortController.signal,
			titleSystemPrompt,
		);

	return raceFirstNonNull(localTitle, startOnline, TITLE_LOCAL_FALLBACK_DELAY_MS, () => {
		onlineAbortController.abort();
	});
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
	// Some providers can't be forced to call a tool — chat-completions hosts
	// without `tool_choice` support, Claude Fable/Mythos — so a required
	// `set_title` call never arrives. For those, ask the model to wrap the title
	// in `<title>...</title>` markers and parse it from text instead.
	const useForcedTool = modelSupportsForcedToolChoice(model);
	const systemPrompt = useForcedTool
		? [titleSystemPrompt ?? TITLE_SYSTEM_PROMPT]
		: titleSystemPrompt
			? [titleSystemPrompt, TITLE_MARKER_INSTRUCTION]
			: [TITLE_MARKER_SYSTEM_PROMPT];
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

		// Title generation is a 3-7 word task, but some reasoning backends ignore
		// disableReasoning. Keep the normal cheap budget for non-reasoning models
		// while reserving enough output room for reasoning models to still emit
		// the forced tool call after any unavoidable thinking tokens.
		const maxTokens = model.reasoning ? Math.max(TITLE_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : TITLE_MAX_TOKENS;
		logger.debug("title-generator: request", { ...modelContext, maxTokens });

		const response = await completeSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				tools: useForcedTool ? [setTitleTool] : undefined,
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens,
				disableReasoning: true,
				toolChoice: useForcedTool ? { type: "tool", name: SET_TITLE_TOOL_NAME } : undefined,
				metadata,
				signal,
			},
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

		const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content));

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
		if (content.type === "toolCall" && content.name === SET_TITLE_TOOL_NAME) {
			const args = content.arguments as Record<string, unknown>;
			const title = args.title;
			return typeof title === "string" ? title.trim() : "";
		}
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	// Tool-choice-less models are asked to wrap the title in <title>...</title>,
	// but stay lenient: prefer the marker when the model closed it, otherwise
	// accept a plain sentence after stripping any stray/unclosed tag fragment
	// (e.g. output truncated before the closing tag).
	const marker = TITLE_MARKER_RE.exec(textTitle);
	if (marker) return marker[1].trim();
	return textTitle.replace(/<\/?title>/gi, "").trim();
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
 * Set the terminal title using OSC 0 (sets both tab and window title). Unsupported terminals ignore it.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd));
	setTerminalWorkingDirectory(cwd);
}

/**
 * Build the OSC escape(s) that report `cwd` to the host terminal so new
 * tabs/panes — and Windows Terminal's persisted-layout restore — reuse it.
 *
 * - OSC 7 (`file://host/path`) is the cross-platform standard, honored by the
 *   xterm/VTE family and recent Windows Terminal builds.
 * - OSC 9;9 (`"<native path>"`) is the ConEmu / Windows Terminal convention and
 *   the only form stable Windows Terminal understands. It is gated on
 *   `WT_SESSION` because OSC 9 is iTerm2's notification sequence — emitting it
 *   unconditionally would spam notifications there. The payload must be a
 *   *Windows* path: native on Win32, and `wslpath -w`-translated under WSL
 *   (where `WT_SESSION` is inherited but `cwd` is a POSIX path Windows Terminal
 *   can't restore into). When no Windows path is available it is omitted — OSC 7
 *   already covers the cross-platform case, and a raw POSIX path would send the
 *   layout restore to the wrong directory.
 *
 * Returns "" when no cwd is given.
 */
export function buildCwdReportSequence(
	cwd: string | undefined,
	opts?: { hostname?: string; wtSession?: boolean; osc99Path?: (resolved: string) => string | undefined },
): string {
	if (!cwd) return "";
	const resolved = path.resolve(cwd);
	const host = opts?.hostname ?? os.hostname();
	let seq = `\x1b]7;file://${host}${pathToFileURL(resolved).pathname}\x1b\\`;
	const wtSession = opts?.wtSession ?? Boolean(Bun.env.WT_SESSION);
	if (wtSession) {
		const native = (opts?.osc99Path ?? resolveOsc99WindowsPath)(resolved);
		// A Windows path can't contain `"`, but a translated/edge value might —
		// dropping it beats emitting an unescaped payload that truncates the OSC.
		if (native && !native.includes('"')) seq += `\x1b]9;9;"${native}"\x1b\\`;
	}
	return seq;
}

/**
 * Resolve the OSC 9;9 native-path payload for {@link buildCwdReportSequence}.
 * Win32 reports the resolved path verbatim; WSL translates it to its Windows
 * form via `wslpath -w` (omitting OSC 9;9 if interop is unavailable); any other
 * host has no Windows path to report.
 */
function resolveOsc99WindowsPath(resolved: string): string | undefined {
	if (process.platform === "win32") return resolved;
	if (process.platform !== "linux" || !(Bun.env.WSL_DISTRO_NAME || Bun.env.WSL_INTEROP)) return undefined;
	const result = Bun.spawnSync(["wslpath", "-w", resolved], { stdout: "pipe", stderr: "pipe", windowsHide: true });
	if (result.exitCode !== 0) return undefined;
	const win = new TextDecoder().decode(result.stdout).trim();
	return win.length > 0 ? win : undefined;
}

/**
 * Report the working directory to the host terminal via
 * {@link buildCwdReportSequence}. No-op when stdout is not a TTY (print/RPC
 * modes, pipes) — matching {@link setTerminalTitle}.
 *
 * Like the OSC 0 title write, this is gated only by TTY, NOT by `--no-title`
 * (`PI_NO_TITLE`): that flag disables AI title *auto-generation* only (see its
 * description and the single gate in `input-controller.ts`), and the terminal
 * title is still asserted under it. Suppressing cwd on `--no-title` would be
 * inconsistent — title written, cwd withheld. The rpc/acp/protocol modes that
 * also set `PI_NO_TITLE` are already silenced here by the non-TTY check.
 */
export function setTerminalWorkingDirectory(cwd: string | undefined): void {
	if (!process.stdout.isTTY) return;
	const seq = buildCwdReportSequence(cwd);
	if (seq) process.stdout.write(seq);
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[23;2t");
}
