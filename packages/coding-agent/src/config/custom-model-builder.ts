import { execSync } from "node:child_process";
import type { Api, Model, ModelSpec, ThinkingConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModelReferenceIndex, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";
import type { ProviderAuthMode } from "./models-config-schema";

const commandValueCache = new Map<string, string>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	return !Array.isArray(value);
}

function resolveCommandConfig(command: string): string | undefined {
	const cached = commandValueCache.get(command);
	if (cached !== undefined) return cached;
	try {
		const stdout = execSync(command, { encoding: "utf8", timeout: 10_000, windowsHide: true });
		const trimmed = stdout.trim();
		if (trimmed.length === 0) return undefined;
		commandValueCache.set(command, trimmed);
		return trimmed;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a models.yml secret/config value to an actual value.
 * `!cmd` runs a shell command and returns trimmed stdout, otherwise env vars are
 * checked first and the input falls back to a literal value.
 */
export function resolveConfigValue(valueConfig: string): string | undefined {
	if (valueConfig.startsWith("!")) return resolveCommandConfig(valueConfig.slice(1).trim());
	const envValue = Bun.env[valueConfig];
	if (envValue) return envValue;
	return valueConfig;
}

export function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const next = resolveConfigValue(value);
		if (next) resolved[key] = next;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isPlainRecord(baseValue) && isPlainRecord(overrideValue)
				? mergeCompat(baseValue, overrideValue)
				: overrideValue;
	}
	return merged as TBase & TOverride;
}

/**
 * The patchable subset of `Model` fields shared by `modelOverrides` entries,
 * custom model definitions, and parsed custom-model overlays. `undefined`
 * always means "leave the base value alone".
 */
export interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
}

export interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
	requestModelId?: string;
}

export interface CustomModelBuildOptions {
	useDefaults: boolean;
}

export interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	requestModelId?: string;
	isOAuth?: boolean;
}

export function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const resolvedModelHeaders = resolveConfigHeaders(modelHeaders);
	return mergeAuthHeader({ ...providerHeaders, ...resolvedModelHeaders }, authHeader, apiKeyConfig);
}

function mergeAuthHeader(
	headers: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const nextHeaders = headers && Object.keys(headers).length > 0 ? { ...headers } : undefined;
	if (!authHeader || !apiKeyConfig) {
		return nextHeaders;
	}
	const resolvedKey = resolveConfigValue(apiKeyConfig);
	return resolvedKey ? { ...nextHeaders, Authorization: `Bearer ${resolvedKey}` } : nextHeaders;
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 * - Explicit `auth: apiKey` / `auth: none` → leave unset (auto-detect by key prefix).
 * - No `auth` specified and `api: anthropic-messages` → default on. Custom Anthropic
 *   endpoints are typically Claude-Code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
export function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

export function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		requestModelId: modelDef.requestModelId,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

export function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults
		? resolveModelReference(resolvedModel.id, getBundledModelReferenceIndex())
		: undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const supportsTools = resolvedModel.supportsTools ?? reference?.supportsTools;
	return buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		requestModelId: resolvedModel.requestModelId,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking ?? reference?.thinking,
		input: input as ("text" | "image")[],
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow: resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
}

export function looksLikeLiteralSecret(value: string): boolean {
	if (value.length < 16) return false;
	if (/^(sk-|sk_|Bearer |ghp_|gho_|xoxb-|xoxp-)/i.test(value)) return true;
	if (value.length > 32 && !/[\s/\\]/.test(value) && /^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
	return false;
}
