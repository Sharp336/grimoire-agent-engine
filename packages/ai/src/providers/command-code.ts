/**
 * Command Code wire provider.
 *
 * Command Code is a gateway, not an OpenAI- or Anthropic-compatible endpoint.
 * Every model goes through `POST {base}/alpha/generate` with a proprietary
 * envelope (`config`/`memory`/`taste`/`skills`/`permissionMode`/`threadId`/
 * `mode`/`params`) and answers with newline-delimited JSON frames — despite
 * advertising `content-type: text/event-stream`, the body carries no `data:`
 * prefixes.
 *
 * The request shape here mirrors the official CLI byte-for-byte (envelope keys,
 * `input_schema` tools, `system` as one string, the `x-*` header set). oh-my-pi
 * adapts to that harness rather than normalizing it to its own conventions.
 */
import * as fs from "node:fs/promises";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { $env, readLines } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	Usage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";
import { getNamedToolChoiceName } from "../utils/tool-choice";
import { NO_AUTH_SENTINEL } from "./openai-shared";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

/** Production Command Code API base. */
export const COMMAND_CODE_API_URL = "https://api.commandcode.ai";
const COMMAND_CODE_STAGING_API_URL = "https://staging-api.commandcode.ai";
const COMMAND_CODE_LOCAL_API_URL = "http://localhost:9090";
/**
 * Endpoint path, relative on purpose: resolved against a base normalized to a
 * trailing slash so a path-prefixed proxy base (`https://host/cmd`) keeps its
 * prefix instead of being replaced by an absolute `/alpha/generate`.
 */
const GENERATE_PATH = "alpha/generate";
/** Semver reported to the Command Code API; required for generate requests. */
const COMMAND_CODE_CLIENT_VERSION = "1.9.0";
const DEFAULT_MAX_TOKENS = 64_000;
/**
 * `pause_turn` asks the client to re-send the whole request so the model can
 * keep going. The official CLI caps the chain at five continuations.
 */
const MAX_PAUSE_TURN_CONTINUATIONS = 5;
/**
 * The gateway only accepts a UUID for `threadId`. The official CLI's own guard
 * predates UUIDv7 and matches versions 1-5 only; oh-my-pi mints v7 session ids,
 * so a literal copy would drop `threadId` from every request. The gateway
 * accepts v7 (verified against the live API), so the version nibble is left
 * open and only the UUID shape is enforced.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Header names, mirroring `buildCommandAuthHeaders` in the Command Code CLI. */
const HEADER = {
	cliVersion: "x-command-code-version",
	cliEnvironment: "x-cli-environment",
	projectSlug: "x-project-slug",
	tasteLearning: "x-taste-learning",
	/** Internal team flag; the CLI sends it as the stringified OAuth-enforced bit. */
	coFlag: "x-co-flag",
	sessionId: "x-session-id",
	zdr: "x-cmd-zdr",
} as const;

/** True when `headers` already carries the named header under any casing. */
function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return true;
	}
	return false;
}

/**
 * Layer `source` onto `target`, overwriting any existing key that matches
 * case-insensitively so Fetch never joins duplicate Authorization casings.
 */
function assignHeadersCaseInsensitive(
	target: Record<string, string>,
	source: Record<string, string> | undefined,
): void {
	if (!source) return;
	for (const [key, value] of Object.entries(source)) {
		const lower = key.toLowerCase();
		for (const existing of Object.keys(target)) {
			if (existing.toLowerCase() === lower) delete target[existing];
		}
		target[key] = value;
	}
}

/** Directories the CLI hides from the `config.structure` listing. */
const STRUCTURE_IGNORED = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	".svn",
	".hg",
	"coverage",
	".nyc_output",
	".cache",
	"tmp",
	"temp",
	".next",
	".nuxt",
	"out",
]);

/** Repository snapshot the gateway expects in the envelope's `config` field. */
export interface CommandCodeServerConfig {
	workingDir: string;
	date: string;
	environment: string;
	structure: string[];
	isGitRepo: boolean;
	currentBranch: string;
	mainBranch: string;
	gitStatus: string;
	recentCommits: string[];
}

export interface CommandCodeOptions extends StreamOptions {
	/** Unified tool choice override; `"none"` omits `params.tools` (the gateway has no tool_choice field). */
	toolChoice?: ToolChoice;
	/** Server-side conversation key. Sent as body `threadId` when UUID-shaped. */
	conversationId?: string;
	/** Wire value for `params.reasoning_effort`. Omitted when the model has no thinking config. */
	reasoningEffort?: string;
	/** Wire value for body `permissionMode`. Defaults to `"standard"`. */
	permissionMode?: "standard" | "auto-accept" | "plan";
	/**
	 * Wire value for body `mode`. The official CLI omits it on the main agent
	 * loop and only sets it for side calls (`compact`, `title-gen`, `vision`, …),
	 * so the default here is to omit it too.
	 */
	mode?: string;
	/** Body `config` block. Built from the working directory when not supplied; `null` sends no snapshot. */
	config?: CommandCodeServerConfig | Record<string, unknown> | null;
	/** Working directory used for `config` and the project slug. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Value for `x-project-slug`. Defaults to the slugified working directory. */
	projectSlug?: string;
	/** Value for `x-taste-learning`. Defaults to `false` — oh-my-pi has no taste store. */
	tasteLearning?: boolean;
	/** Value for `x-co-flag`. Defaults to `false`. */
	oauthEnforced?: boolean;
	/** Value for `x-command-code-version`. */
	clientVersion?: string;
	/** Absolute override for the API base. Defaults to `model.baseUrl`. */
	baseUrl?: string;
}

type CommandCodePermissionMode = NonNullable<CommandCodeOptions["permissionMode"]>;

interface CommandCodeUsageDetails {
	noCacheTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	textTokens?: number;
}

interface CommandCodeTotalUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	inputTokenDetails?: CommandCodeUsageDetails;
	outputTokenDetails?: CommandCodeUsageDetails;
}

interface CommandCodeStreamEvent {
	type?: string;
	id?: string;
	text?: string;
	delta?: string;
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	args?: unknown;
	providerExecuted?: boolean;
	output?: unknown;
	result?: unknown;
	isError?: boolean;
	finishReason?: string;
	rawFinishReason?: string;
	totalUsage?: CommandCodeTotalUsage;
	systemPromptTokens?: number;
	error?: string | { type?: string; message?: string; statusCode?: number; isRetryable?: boolean };
}

/** Outcome of consuming one `/alpha/generate` response body. */
interface StreamPass {
	sawFinish: boolean;
	sawAbort: boolean;
	rawFinishReason: string | undefined;
}

function resolveCommandCodeBaseUrl(options: CommandCodeOptions | undefined, model: Model<"command-code">): string {
	if (options?.baseUrl) return options.baseUrl;
	if ($env.COMMANDCODE_SANDBOX === "true" && $env.COMMANDCODE_API_URL) {
		return $env.COMMANDCODE_API_URL;
	}
	if ($env.COMMANDCODE_API_ENV === "staging") return COMMAND_CODE_STAGING_API_URL;
	if ($env.COMMANDCODE_API_ENV === "local") return COMMAND_CODE_LOCAL_API_URL;
	return model.baseUrl || COMMAND_CODE_API_URL;
}

/** `x-cli-environment` value: the CLI reports `prod` as `production`. */
function resolveCliEnvironment(): string {
	const env = $env.COMMANDCODE_API_ENV;
	if (env === "staging" || env === "local") return env;
	return "production";
}

function toWireThreadId(value: string | undefined): string | undefined {
	return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
}

/**
 * Reproduce the `@sindresorhus/slugify` output the CLI uses for `x-project-slug`:
 * split camelCase, lowercase, and collapse every non-alphanumeric run into `-`.
 */
export function slugifyProjectPath(value: string): string {
	const decamelized = value.replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z\d]+)/g, "$1-$2");
	const slug = decamelized
		.toLowerCase()
		.replace(/[^a-z\d]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "root";
}

/** Run a git command in `cwd`, returning trimmed stdout or `""` on any failure. */
async function gitOutput(cwd: string, args: string[]): Promise<string> {
	try {
		const child = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return exitCode === 0 ? stdout.trim() : "";
	} catch {
		return "";
	}
}

async function readStructure(cwd: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(cwd);
		return entries.filter(entry => !entry.startsWith(".") && !STRUCTURE_IGNORED.has(entry)).sort();
	} catch {
		return [];
	}
}

async function resolveMainBranch(cwd: string): Promise<string> {
	const symbolic = await gitOutput(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (symbolic) return symbolic.replace(/^origin\//, "");
	const remotes = await gitOutput(cwd, ["branch", "-r"]);
	if (remotes.includes("origin/main")) return "main";
	if (remotes.includes("origin/master")) return "master";
	return "main";
}

/**
 * Build the envelope's `config` snapshot the way the CLI's `buildServerConfig`
 * does. Memoized per working directory: the official client resolves it once
 * per session and reuses it for every turn.
 */
const serverConfigCache = new Map<string, Promise<CommandCodeServerConfig>>();

export function buildCommandCodeServerConfig(cwd: string): Promise<CommandCodeServerConfig> {
	const cached = serverConfigCache.get(cwd);
	if (cached) return cached;
	const pending = (async (): Promise<CommandCodeServerConfig> => {
		const structure = await readStructure(cwd);
		const base = {
			workingDir: cwd,
			date: new Date().toISOString().slice(0, 10),
			environment: process.platform,
			structure,
		};
		if (!(await gitOutput(cwd, ["rev-parse", "--git-dir"]))) {
			return {
				...base,
				isGitRepo: false,
				currentBranch: "",
				mainBranch: "",
				gitStatus: "",
				recentCommits: [],
			};
		}
		const [currentBranch, mainBranch, gitStatus, recentCommits] = await Promise.all([
			gitOutput(cwd, ["branch", "--show-current"]),
			resolveMainBranch(cwd),
			gitOutput(cwd, ["status", "--porcelain"]),
			gitOutput(cwd, ["log", "--oneline", "-3"]),
		]);
		return {
			...base,
			isGitRepo: true,
			currentBranch,
			mainBranch,
			gitStatus: gitStatus || "Working tree clean",
			recentCommits: recentCommits ? recentCommits.split("\n") : [],
		};
	})();
	serverConfigCache.set(cwd, pending);
	return pending;
}

/** Drop the memoized `config` snapshots. Exported for tests. */
export function clearCommandCodeServerConfigCache(): void {
	serverConfigCache.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recover tool arguments from the shapes the gateway emits: a plain object, a
 * JSON string, or a single-element array wrapping either.
 */
export function coerceToolArguments(value: unknown): Record<string, unknown> {
	if (isPlainObject(value)) return value;
	if (Array.isArray(value) && value.length === 1) return coerceToolArguments(value[0]);
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return {};
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isPlainObject(parsed) || Array.isArray(parsed)) return coerceToolArguments(parsed);
		} catch {
			// Fall through to empty object — oh-my-pi validates args downstream.
		}
	}
	return {};
}

function stringifyProviderToolPayload(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function userContentBlocks(
	content: string | (TextContent | ImageContent)[],
	supportsImages: boolean,
): Array<Record<string, unknown>> {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const blocks: Array<Record<string, unknown>> = textBlocks.map(block => ({ type: "text", text: block.text }));
	if (omittedImages) {
		blocks.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
	}
	for (const block of imageBlocks) {
		blocks.push({
			type: "image",
			image: `data:${block.mimeType};base64,${block.data}`,
			mimeType: block.mimeType,
		});
	}
	return blocks;
}

function toWireToolResultValue(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * Map freeform custom-tool wire names back to the internal tool name so the
 * agent-loop dispatcher can match `Tool.name` while history carries the wire
 * alias via `ToolCall.customWireName` (e.g. `apply_patch` → `edit`).
 */
function buildCustomToolWireNameMap(tools: readonly Tool[] | undefined): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	if (!tools) return map;
	for (const tool of tools) {
		if (tool.customWireName) map.set(tool.customWireName, tool.name);
	}
	return map;
}

/** Resolve a gateway tool name to the local catalog name and wire alias. */
function resolveInboundToolName(
	wireName: string | undefined,
	wireNameMap: ReadonlyMap<string, string>,
): { name: string; customWireName?: string } {
	if (!wireName) return { name: "" };
	const local = wireNameMap.get(wireName);
	if (local !== undefined) return { name: local, customWireName: wireName };
	return { name: wireName };
}

/**
 * Convert oh-my-pi messages to the Command Code wire history shape. `toolName`
 * is left empty on tool results because the official client does the same — the
 * gateway matches results to calls by `toolCallId`.
 */
function toWireMessages(
	messages: Message[],
	supportsImages: boolean,
	wireNameByLocalName?: ReadonlyMap<string, string>,
): unknown[] {
	const out: unknown[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;

		if (message.role === "assistant") {
			const content: Array<Record<string, unknown>> = [];
			for (const block of message.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					content.push({ type: "reasoning", text: block.thinking });
				} else if (block.type === "toolCall") {
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						// Replay under the wire alias the gateway first saw (e.g.
						// apply_patch), falling back to the local name.
						toolName: block.customWireName ?? wireNameByLocalName?.get(block.name) ?? block.name,
						input: block.arguments,
					});
				}
			}
			out.push({ role: "assistant", content });
			continue;
		}

		if (message.role === "toolResult") {
			// Keep consecutive tool results contiguous (parallel tool calls). Buffer
			// any image payloads and hoist them once after the whole run.
			const pendingImages: ImageContent[] = [];
			let j = i;
			for (; j < messages.length && messages[j]!.role === "toolResult"; j++) {
				const toolMsg = messages[j]! as Extract<Message, { role: "toolResult" }>;
				const imageBlocks = toolMsg.content.filter((block): block is ImageContent => block.type === "image");
				const omittedImages = imageBlocks.length > 0 && !supportsImages;
				const textValue = joinTextWithImagePlaceholder(toWireToolResultValue(toolMsg.content), omittedImages);
				out.push({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: toolMsg.toolCallId,
							toolName: "",
							// Official CLI emits `error-text` for failed local results so the
							// model can correct/retry; dropping `isError` collapses failures
							// into empty success results.
							output: {
								type: toolMsg.isError ? "error-text" : "text",
								value: textValue,
							},
						},
					],
				});
				if (supportsImages && imageBlocks.length > 0) {
					pendingImages.push(...imageBlocks);
				}
			}
			i = j - 1;
			if (pendingImages.length > 0) {
				out.push({
					role: "user",
					content: [
						{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
						...userContentBlocks(pendingImages, true),
					],
				});
			}
			continue;
		}

		if (message.role === "user" || message.role === "developer") {
			const content = userContentBlocks(message.content, supportsImages);
			if (content.length > 0) {
				out.push({ role: "user", content });
			}
		}
	}
	return out;
}

/** Normalized view of an `{"type":"error"}` frame. */
interface CommandCodeStreamError {
	message: string;
	type: string | undefined;
	statusCode: number | undefined;
	isRetryable: boolean | undefined;
}

export function readStreamErrorEvent(error: CommandCodeStreamEvent["error"]): CommandCodeStreamError {
	if (typeof error === "string" && error.length > 0) {
		return { message: error, type: undefined, statusCode: undefined, isRetryable: undefined };
	}
	if (isPlainObject(error)) {
		const record = error as { type?: unknown; message?: unknown; statusCode?: unknown; isRetryable?: unknown };
		return {
			message:
				typeof record.message === "string" && record.message.length > 0
					? record.message
					: "Command Code stream error",
			type: typeof record.type === "string" ? record.type : undefined,
			statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
			isRetryable: typeof record.isRetryable === "boolean" ? record.isRetryable : undefined,
		};
	}
	return { message: "Command Code stream error", type: undefined, statusCode: undefined, isRetryable: undefined };
}

/**
 * Turn an error frame into the error oh-my-pi's retry layer can classify. The
 * gateway's `type` is kept in the message because `isProviderRetryableError`
 * treats `type=server_error` as transient — which is exactly what the official
 * client's retry loop does with these frames.
 */
function streamErrorToProviderError(parsed: CommandCodeStreamError, provider: string): Error {
	const label = parsed.type ? `Command Code stream error (type=${parsed.type})` : "Command Code stream error";
	const message = `${label}: ${parsed.message}`;
	if (parsed.statusCode !== undefined) {
		return new AIError.ProviderHttpError(message, parsed.statusCode, { code: parsed.type });
	}
	// No status: a retryable frame maps to a transient 503 so backoff applies.
	if (parsed.isRetryable === true) {
		return new AIError.ProviderHttpError(message, 503, { code: parsed.type });
	}
	return new AIError.ProviderResponseError(message, { provider, kind: "output" });
}

/** Accumulate a pass's usage into the running total (pause_turn continuations sum). */
function addUsage(target: Usage, total: CommandCodeTotalUsage | undefined): void {
	if (!total) return;
	const inputDetails = total.inputTokenDetails;
	const cacheRead = inputDetails?.cacheReadTokens ?? total.cachedInputTokens ?? 0;
	const cacheWrite = inputDetails?.cacheWriteTokens ?? 0;
	// `inputTokens` is the billed prompt total and already contains the cached
	// portion; oh-my-pi's `usage.input` is the non-cached bucket.
	const input = inputDetails?.noCacheTokens ?? Math.max(0, (total.inputTokens ?? 0) - cacheRead - cacheWrite);
	const output = total.outputTokens ?? 0;
	const reasoning = total.reasoningTokens ?? total.outputTokenDetails?.reasoningTokens;

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
	if (reasoning !== undefined) target.reasoningTokens = (target.reasoningTokens ?? 0) + reasoning;
}

export const streamCommandCode: StreamFunction<"command-code"> = (
	model: Model<"command-code">,
	context: Context,
	options?: CommandCodeOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "command-code" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		/** Tool calls opened by `tool-input-start`, keyed by the frame's `id`. */
		const openToolCalls = new Map<string, { block: ToolCall; buffer: string }>();

		const markFirstToken = () => {
			if (firstTokenTime === undefined) firstTokenTime = performance.now();
		};

		const endTextBlock = () => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = () => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		const ensureTextBlock = (): TextContent => {
			if (currentTextBlock) return currentTextBlock;
			endThinkingBlock();
			const block: TextContent = { type: "text", text: "" };
			currentTextBlock = block;
			output.content.push(block);
			stream.push({
				type: "text_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
			return block;
		};

		const ensureThinkingBlock = (): ThinkingContent => {
			if (currentThinkingBlock) return currentThinkingBlock;
			endTextBlock();
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			currentThinkingBlock = block;
			output.content.push(block);
			stream.push({
				type: "thinking_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
			return block;
		};

		/** Emit `toolcall_end` for a block that already sits in `output.content`. */
		const finishToolCall = (block: ToolCall, input: unknown): void => {
			block.arguments = coerceToolArguments(input);
			stream.push({
				type: "toolcall_end",
				contentIndex: output.content.indexOf(block),
				toolCall: block,
				partial: output,
			});
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(model.provider);
			}

			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = resolveCommandCodeBaseUrl(options, model);
			const url = new URL(GENERATE_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
			const cwd = options?.cwd ?? process.cwd();
			const threadId = toWireThreadId(options?.conversationId ?? options?.sessionId);
			// The CLI keeps one session id for the whole conversation. Reuse the
			// caller's id verbatim (it need not be UUID-shaped) so the gateway sees
			// a stable session across turns.
			const sessionId = options?.sessionId ?? threadId ?? crypto.randomUUID();
			const permissionMode: CommandCodePermissionMode = options?.permissionMode ?? "standard";
			const config =
				options !== undefined && "config" in options ? options.config : await buildCommandCodeServerConfig(cwd);

			const transformed = transformMessages(context.messages, model);
			// The gateway has no wire `tool_choice` field. `"none"` omits the
			// tools list entirely; a named choice approximates the force by
			// advertising only the pinned tool (same lever as the Ollama chat
			// transport's selectToolsForToolChoice). Soft-required `"required"` /
			// `"any"` cannot be approximated without inventing a force signal —
			// silently advertising the full list would let a text-only reply
			// satisfy plan-mode/soft-required turns, so reject them.
			if (options?.toolChoice === "required" || options?.toolChoice === "any") {
				throw new AIError.ConfigurationError(
					'Command Code has no wire tool_choice field; toolChoice "required"/"any" is unsupported. Pin a specific tool or use "auto"/"none".',
				);
			}
			const namedTool = getNamedToolChoiceName(options?.toolChoice);
			const wireTools =
				namedTool === undefined
					? (context.tools ?? [])
					: (context.tools ?? []).filter(tool => tool.name === namedTool || tool.customWireName === namedTool);
			// Wire name → local name for inbound tool-call frames (apply_patch → edit);
			// local name → wire name for history replay of assistant tool calls.
			const inboundWireNameMap = buildCustomToolWireNameMap(context.tools);
			const outboundWireNameByLocal = new Map<string, string>();
			for (const tool of wireTools) {
				if (tool.customWireName) outboundWireNameByLocal.set(tool.name, tool.customWireName);
			}
			const tools = wireTools.map(tool => ({
				// Advertise the wire alias so gateway tool calls come back under the
				// name the model was shown (e.g. apply_patch, not edit).
				name: tool.customWireName ?? tool.name,
				description: tool.description,
				input_schema: toolWireSchema(tool),
			}));

			const params: Record<string, unknown> = {
				// Wire id may be aliased away from the local catalog id.
				model: model.requestModelId ?? model.id,
				messages: toWireMessages(transformed, model.input.includes("image"), outboundWireNameByLocal),
				system: normalizeSystemPrompts(context.systemPrompt).join("\n\n"),
				max_tokens: options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
				stream: true,
			};
			// `toolChoice: "none"` (side-channel turns, handoff/compaction) must
			// not leave tools callable: the gateway has no `tool_choice` field, so
			// omitting `params.tools` is the only wire lever. Same rationale as the
			// openai-completions none-gate (openai-completions.ts:1656).
			if (tools.length > 0 && options?.toolChoice !== "none") params.tools = tools;
			if (options?.temperature !== undefined) params.temperature = options.temperature;
			if (options?.reasoningEffort !== undefined) params.reasoning_effort = options.reasoningEffort;

			let body: Record<string, unknown> = {
				config,
				memory: null,
				taste: null,
				skills: null,
				permissionMode,
				params,
			};
			if (threadId) body.threadId = threadId;
			if (options?.mode !== undefined) body.mode = options.mode;

			// Build defaults first, then layer model/caller headers case-insensitively.
			// Fetch joins duplicate Authorization casings (`authorization` +
			// `Authorization`) into a single comma-separated value, so a proxy
			// configured with its own auth header (or `auth: none` → `N/A`) would
			// otherwise receive `Bearer N/A, Bearer real` / dummy+real.
			const headers: Record<string, string> = {
				"content-type": "application/json",
				"user-agent": "cli",
				[HEADER.cliVersion]: options?.clientVersion ?? COMMAND_CODE_CLIENT_VERSION,
				[HEADER.cliEnvironment]: resolveCliEnvironment(),
				[HEADER.projectSlug]: options?.projectSlug ?? slugifyProjectPath(cwd),
				[HEADER.tasteLearning]: String(options?.tasteLearning ?? false),
				[HEADER.coFlag]: String(options?.oauthEnforced ?? false),
				[HEADER.sessionId]: sessionId,
				...($env.CMD_ZDR === "1" ? { [HEADER.zdr]: "1" } : {}),
			};
			assignHeadersCaseInsensitive(headers, model.headers);
			assignHeadersCaseInsensitive(headers, options?.headers);
			// Only inject the default bearer when the key is real and neither the
			// model nor the caller already supplied Authorization.
			if (apiKey !== NO_AUTH_SENTINEL && !hasHeaderCaseInsensitive(headers, "authorization")) {
				headers.Authorization = `Bearer ${apiKey}`;
			}

			// Request-capture/redaction hook, same contract as the other HTTP
			// providers: a returned value replaces the outgoing body.
			const replacementPayload = await options?.onPayload?.(body, model);
			if (replacementPayload !== undefined) {
				body = replacementPayload as Record<string, unknown>;
			}

			const payload = JSON.stringify(body);
			stream.push({ type: "start", partial: output });

			/** Send the request once and drain its frames into `output`. */
			const runPass = async (): Promise<StreamPass> => {
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body: payload,
					signal: options?.signal,
				});

				// Raw-SSE/debug buffer, extensions and session stats consume the
				// provider response via this hook (shared contract).
				await notifyProviderResponse(options, response, model);

				if (!response.ok) {
					const bodyText = await response.text();
					throw new AIError.ProviderHttpError(
						`Command Code request failed (${response.status}): ${bodyText}`,
						response.status,
						{ headers: response.headers },
					);
				}
				if (!response.body) {
					throw new AIError.ProviderResponseError("Command Code response body is empty", {
						provider: model.provider,
						kind: "empty-body",
					});
				}

				const pass: StreamPass = { sawFinish: false, sawAbort: false, rawFinishReason: undefined };
				const decoder = new TextDecoder();

				for await (const lineBytes of readLines(response.body, options?.signal)) {
					const line = decoder.decode(lineBytes).trim();
					if (!line) continue;

					let event: CommandCodeStreamEvent;
					try {
						event = JSON.parse(line) as CommandCodeStreamEvent;
					} catch {
						continue;
					}

					switch (event.type) {
						// Envelope framing carrying no assistant content.
						case "start":
						case "start-step":
						case "text-start":
						case "tool-input-end":
						case "finish-step":
						case "provider-metadata":
							break;
						case "text-delta": {
							markFirstToken();
							const block = ensureTextBlock();
							const delta = event.text ?? event.delta ?? "";
							block.text += delta;
							stream.push({
								type: "text_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
							break;
						}
						case "text-end": {
							endTextBlock();
							break;
						}
						case "reasoning-start": {
							markFirstToken();
							ensureThinkingBlock();
							break;
						}
						case "reasoning-delta": {
							markFirstToken();
							const block = ensureThinkingBlock();
							const delta = event.text ?? event.delta ?? "";
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
							break;
						}
						case "reasoning-end": {
							endThinkingBlock();
							break;
						}
						case "tool-input-start": {
							markFirstToken();
							if (event.providerExecuted === true) break;
							const id = event.id;
							if (id === undefined || openToolCalls.has(id)) break;
							endTextBlock();
							endThinkingBlock();
							// Keep the local name on `name` (dispatcher match) and the wire
							// alias on `customWireName` (history replay stays byte-compatible).
							const inboundToolName = resolveInboundToolName(event.toolName, inboundWireNameMap);
							const block: ToolCall = {
								type: "toolCall",
								id,
								name: inboundToolName.name,
								...(inboundToolName.customWireName ? { customWireName: inboundToolName.customWireName } : {}),
								arguments: {},
							};
							output.content.push(block);
							openToolCalls.set(id, { block, buffer: "" });
							stream.push({
								type: "toolcall_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
							break;
						}
						case "tool-input-delta": {
							markFirstToken();
							const open = event.id === undefined ? undefined : openToolCalls.get(event.id);
							if (!open) break;
							const delta = event.delta ?? event.text ?? "";
							open.buffer += delta;
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(open.block),
								delta,
								partial: output,
							});
							break;
						}
						case "tool-call": {
							markFirstToken();
							if (event.providerExecuted === true) break;
							const id = event.toolCallId ?? event.id;
							const open = id === undefined ? undefined : openToolCalls.get(id);
							if (open) {
								// Streamed in through tool-input-*; `input` is authoritative,
								// falling back to the accumulated argument JSON.
								openToolCalls.delete(id as string);
								if (event.toolName) {
									const resolved = resolveInboundToolName(event.toolName, inboundWireNameMap);
									open.block.name = resolved.name;
									if (resolved.customWireName) {
										open.block.customWireName = resolved.customWireName;
									} else {
										delete open.block.customWireName;
									}
								}
								finishToolCall(open.block, event.input ?? event.args ?? open.buffer);
								break;
							}
							endTextBlock();
							endThinkingBlock();
							const resolved = resolveInboundToolName(event.toolName, inboundWireNameMap);
							const block: ToolCall = {
								type: "toolCall",
								id: id ?? crypto.randomUUID(),
								name: resolved.name,
								...(resolved.customWireName ? { customWireName: resolved.customWireName } : {}),
								arguments: {},
							};
							output.content.push(block);
							stream.push({
								type: "toolcall_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
							finishToolCall(block, event.input ?? event.args);
							break;
						}
						case "tool-result": {
							markFirstToken();
							endTextBlock();
							endThinkingBlock();
							const toolName = event.toolName ?? "";
							const payloadText = stringifyProviderToolPayload(event.result ?? event.output);
							const text = `[${toolName}] ${payloadText}`;
							const block: TextContent = { type: "text", text };
							output.content.push(block);
							const contentIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex, partial: output });
							stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
							stream.push({ type: "text_end", contentIndex, content: text, partial: output });
							break;
						}
						case "finish": {
							pass.sawFinish = true;
							pass.rawFinishReason = event.rawFinishReason ?? event.finishReason;
							addUsage(output.usage, event.totalUsage);

							if (event.finishReason === "tool-calls") {
								output.stopReason = "toolUse";
							} else if (event.finishReason === "length") {
								output.stopReason = "length";
							} else {
								output.stopReason = "stop";
							}
							break;
						}
						case "error": {
							throw streamErrorToProviderError(readStreamErrorEvent(event.error), model.provider);
						}
						case "abort": {
							pass.sawAbort = true;
							output.stopReason = "aborted";
							break;
						}
						default:
							break;
					}

					if (pass.sawAbort) break;
				}

				return pass;
			};

			let pass = await runPass();
			for (
				let continuation = 0;
				pass.rawFinishReason === "pause_turn" && !pass.sawAbort && continuation < MAX_PAUSE_TURN_CONTINUATIONS;
				continuation++
			) {
				pass = await runPass();
			}

			if (!pass.sawFinish && !pass.sawAbort) {
				throw new AIError.ProviderResponseError("Command Code stream ended before finish", {
					provider: model.provider,
					kind: "incomplete-stream",
				});
			}

			// Any tool call left open never received its `tool-call` frame.
			for (const [, open] of openToolCalls) finishToolCall(open.block, open.buffer);
			openToolCalls.clear();
			endTextBlock();
			endThinkingBlock();
			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
				return;
			}

			const doneReason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end(output);
		} catch (error) {
			for (const [, open] of openToolCalls) finishToolCall(open.block, open.buffer);
			openToolCalls.clear();
			endTextBlock();
			endThinkingBlock();
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				signal: options?.signal,
			});
			output.stopReason = options?.signal?.aborted ? "aborted" : result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		}
	})();

	return stream;
};
