import { once } from "@oh-my-pi/pi-utils";
import { type CodexModelDiscoveryResult, fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import { Effort } from "../effort";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { resolveModelCacheProviderId } from "./cache-provider-id";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

/** One Codex OAuth account to fetch a catalog for. */
export interface OpenAICodexAccount {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id sent as the `chatgpt-account-id` header. */
	accountId?: string;
}

export interface OpenAICodexModelManagerConfig {
	/**
	 * Resolves every configured Codex OAuth account at discovery time. Codex
	 * discovery is account-scoped — a model can be available to one account and
	 * absent from another — so each account's `/models` endpoint is fetched
	 * independently and the results unioned by id. Without this, discovery would
	 * surface only the account it happened to resolve and, being authoritative,
	 * prune every model the other accounts expose (#6265).
	 *
	 * Returns `null` to abort discovery entirely (e.g. an account's credential
	 * failed to refresh): a partial account set would be cached as the complete
	 * authoritative catalog and hide the missing account's models, so the caller
	 * keeps the previous/bundled catalog instead.
	 */
	resolveAccounts?: () => Promise<readonly OpenAICodexAccount[] | null>;
	clientVersion?: string;
	fetch?: FetchImpl;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { resolveAccounts, clientVersion, fetch } = config;
	return {
		providerId: "openai-codex",
		dynamicModelsAuthoritative: true,
		...(resolveAccounts
			? {
					fetchDynamicModels: async () => {
						const accounts = await resolveAccounts();
						if (!accounts || accounts.length === 0) return null;
						const results = await Promise.all(
							accounts.map(account =>
								fetchCodexModels({
									accessToken: account.accessToken,
									accountId: account.accountId,
									clientVersion,
									fetchFn: fetch,
								}),
							),
						);
						return unionCodexModels(results);
					},
				}
			: undefined),
	};
}

/**
 * Merge complete per-account Codex catalogs into one authoritative list,
 * deduped by model id (first account to expose an id wins). Returns `null` when
 * any account's fetch failed, so a partial list cannot replace the previous or
 * bundled authoritative catalog.
 */
function unionCodexModels(
	results: readonly (CodexModelDiscoveryResult | null)[],
): ModelSpec<"openai-codex-responses">[] | null {
	const byId = new Map<string, ModelSpec<"openai-codex-responses">>();
	for (const result of results) {
		if (!result) return null;
		for (const model of result.models) {
			if (!byId.has(model.id)) byId.set(model.id, model);
		}
	}
	return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		cacheProviderId: resolveModelCacheProviderId("cursor"),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// GitLab Duo Workflow
// ---------------------------------------------------------------------------

export interface GitLabDuoWorkflowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	cwd?: string;
}

export function gitLabDuoWorkflowModelManagerOptions(
	config: GitLabDuoWorkflowModelManagerConfig = {},
): ModelManagerOptions<"gitlab-duo-agent"> {
	const apiKey = config.apiKey;
	return {
		providerId: "gitlab-duo-agent",
		// GitLab Duo discovery is credential- and namespace-specific
		// (`aiChatAvailableModels(rootNamespaceId:)` also surfaces namespace-pinned
		// models), so the default provider-id cache namespace would let a second
		// account/namespace load the first one's authoritative model list at startup
		// and skip refetching. Partition the cache by a non-reversible fingerprint of
		// the exact inputs `fetchGitLabDuoWorkflowModels` resolves the namespace from
		// (credential + base URL + namespace/project config + the same env vars + the
		// effective workspace cwd whose git remote drives auto-discovery). Built-in
		// discovery only passes apiKey/baseUrl/fetch, so the cwd/env terms — not the
		// empty config fields — are what actually separate workspace A from B here.
		// Falls back to the bare provider id when no credential is present.
		...(apiKey ? { cacheProviderId: gitLabDuoWorkflowModelCacheProviderId(apiKey, config) } : undefined),
		dynamicModelsAuthoritative: true,
		staticModels: [
			buildGitLabDuoWorkflowFallbackModel("claude_sonnet_4_6_vertex", "Claude Sonnet 4.6 - Vertex", config.baseUrl),
		],
		...(apiKey
			? {
					fetchDynamicModels: async () =>
						fetchGitLabDuoWorkflowModels({
							apiKey,
							baseUrl: config.baseUrl,
							fetch: config.fetch,
							namespaceId: config.namespaceId,
							projectId: config.projectId,
							cwd: config.cwd,
						}),
				}
			: undefined),
	};
}

function gitLabDuoWorkflowModelCacheProviderId(apiKey: string, config: GitLabDuoWorkflowModelManagerConfig): string {
	// Mirror the exact inputs `discoverGitLabDuoWorkflowNamespace` keys off: explicit
	// namespace/project config OR the same env vars, then the git remote at the
	// effective cwd. Built-in discovery leaves the config fields empty, so the env +
	// resolved cwd terms are what actually distinguish two workspaces sharing a token.
	const namespaceId = config.namespaceId ?? Bun.env.GITLAB_DUO_NAMESPACE_ID ?? "";
	const projectId = config.projectId ?? Bun.env.GITLAB_DUO_PROJECT_ID ?? Bun.env.GITLAB_DUO_PROJECT_PATH ?? "";
	const cwd = config.cwd ?? process.cwd();
	const scope = [config.baseUrl ?? "", namespaceId, projectId, cwd].join("\u0000");
	return `gitlab-duo-agent:${Bun.hash(`${apiKey}\u0000${scope}`).toString(36)}`;
}

// Devin (Codeium Cascade)
// ---------------------------------------------------------------------------

export interface DevinModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchDevinModels } = await devinDiscovery();
						return fetchDevinModels({ apiKey, baseUrl, fetch });
					},
				}
			: undefined),
	};
}

const devinDiscovery = once(() => import("../discovery/devin"));
// ---------------------------------------------------------------------------
// Command Code
// ---------------------------------------------------------------------------

const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
/** Wire default for `params.max_tokens`, matching the Command Code CLI. */
const COMMAND_CODE_MAX_TOKENS = 64_000;

export const COMMAND_CODE_STATIC_MODELS: readonly ModelSpec<"command-code">[] = [
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_050_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_050_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_050_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
	{
		id: "MiniMaxAI/MiniMax-M3-Free",
		name: "MiniMax M3",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	},
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	},
	{
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.7-Code",
		name: "Kimi K2.7 Code",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.7-Code-Highspeed",
		name: "Kimi K2.7 Code HighSpeed",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 262_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	},
	{
		id: "zai-org/GLM-5.2-Fast",
		name: "GLM-5.2 Fast",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 3, output: 10.25, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM-5.1",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5",
		name: "GLM-5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M3",
		name: "MiniMax M3",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M2.5",
		name: "MiniMax M2.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5",
		name: "MiMo V2.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.6-Max-Preview",
		name: "Qwen 3.6 Max Preview",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
	},
	{
		id: "Qwen/Qwen3.6-Plus",
		name: "Qwen 3.6 Plus",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.7-Max",
		name: "Qwen 3.7 Max",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
	},
	{
		id: "Qwen/Qwen3.7-Plus",
		name: "Qwen 3.7 Plus",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5 },
	},
	{
		id: "Qwen/Qwen3.7-Flash",
		name: "Qwen 3.7 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
	},
	{
		id: "stepfun/Step-3.7-Flash",
		name: "Step 3.7 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
	},
	{
		id: "stepfun/Step-3.5-Flash",
		name: "Step 3.5 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
	},
	{
		id: "tencent/Hy3",
		name: "Tencent Hy3 (Free)",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "tencent/hy3-paid",
		name: "Tencent Hy3",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
	{
		id: "google/gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
	{
		id: "google/gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
	{
		id: "google/gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
	{
		id: "sakana/fugu-ultra",
		name: "Fugu Ultra",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.High, Effort.XHigh] },
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b",
		name: "Nemotron 3 Ultra",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
	},
	{
		id: "thinkingmachines/inkling",
		name: "Inkling",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1, output: 4.05, cacheRead: 0.17, cacheWrite: 0 },
	},
	{
		id: "thinkingmachines/inkling-small",
		name: "Inkling Small",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0.5, output: 1.2, cacheRead: 0.1, cacheWrite: 0 },
	},
	{
		id: "poolside/laguna-s-2.1-free",
		name: "Laguna S 2.1",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "inclusionai/ling-3.0-flash-free",
		name: "Ling 3.0 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text"],
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.1",
		name: "Muse Spark 1.1",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
	},
	{
		id: "xai/grok-4.5",
		name: "Grok 4.5",
		api: "command-code",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 500_000,
		maxTokens: COMMAND_CODE_MAX_TOKENS,
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	},
];

export interface CommandCodeModelManagerConfig {}

export function commandCodeModelManagerOptions(
	_config: CommandCodeModelManagerConfig = {},
): ModelManagerOptions<"command-code"> {
	return { providerId: "command-code", staticModels: COMMAND_CODE_STATIC_MODELS };
}

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
