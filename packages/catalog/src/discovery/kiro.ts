import { isRecord } from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";

export const KIRO_DEFAULT_REGION = "us-east-1";
const KIRO_ORIGIN = "KIRO_CLI";
const KIRO_LIST_MODELS_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

/** Credentials required by Kiro's account-scoped runtime and management APIs. */
export interface KiroCredentials {
	accessToken: string;
	profileArn?: string;
}

/** Options for dynamically discovering the Kiro models available to one account. */
export interface KiroModelDiscoveryOptions {
	apiKey?: string;
	profileArn?: string;
	region?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/**
 * Decodes the structured OAuth credential emitted by the Kiro auth resolver.
 * A raw `KIRO_API_KEY` remains valid and is sent as-is.
 */
export function parseKiroCredentials(apiKey: string | undefined, profileArn?: string): KiroCredentials | undefined {
	const token = apiKey?.trim();
	if (!token) return undefined;
	try {
		const parsed: unknown = JSON.parse(token);
		if (isRecord(parsed) && typeof parsed.accessToken === "string") {
			return {
				accessToken: parsed.accessToken,
				profileArn: typeof parsed.profileArn === "string" ? parsed.profileArn : profileArn,
			};
		}
	} catch {
		// Raw API keys are not JSON.
	}
	return { accessToken: token, profileArn };
}

/** Resolve an explicit Kiro region first, then a profile ARN's region, then the service default. */
export function resolveKiroRegion(region: string | undefined, profileArn: string | undefined): string {
	return region || profileArn?.split(":")[3] || KIRO_DEFAULT_REGION;
}

/**
 * Fetches the account-scoped `ListAvailableModels` catalog. The service returns
 * model ids directly, so this function never derives ids from display names.
 */
export async function fetchKiroModels(options: KiroModelDiscoveryOptions): Promise<ModelSpec<"kiro-agent">[] | null> {
	const credentials = parseKiroCredentials(options.apiKey, options.profileArn);
	if (!credentials) return null;

	const region = resolveKiroRegion(options.region, credentials.profileArn);
	const baseUrl = options.baseUrl ?? `https://management.${region}.kiro.dev`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	try {
		const url = new URL(baseUrl);
		url.searchParams.set("origin", KIRO_ORIGIN);
		if (credentials.profileArn) url.searchParams.set("profileArn", credentials.profileArn);
		const response = await discoveryFetch(options.fetch)(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.accessToken}`,
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": KIRO_LIST_MODELS_TARGET,
			},
			body: JSON.stringify({
				origin: KIRO_ORIGIN,
				...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
			}),
			signal,
		});
		if (!response.ok) return null;
		return normalizeKiroModels(await response.json(), region, options.baseUrl);
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

export function normalizeKiroModels(
	response: unknown,
	region = KIRO_DEFAULT_REGION,
	baseUrl?: string,
): ModelSpec<"kiro-agent">[] {
	if (!isRecord(response) || !Array.isArray(response.models)) return [];
	const models = new Map<string, ModelSpec<"kiro-agent">>();
	for (const candidate of response.models) {
		if (!isRecord(candidate)) continue;
		const id = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
		if (!id) continue;
		const tokenLimits = isRecord(candidate.tokenLimits) ? candidate.tokenLimits : undefined;
		const maxInputTokens = finitePositive(tokenLimits?.maxInputTokens);
		const maxOutputTokens = finitePositive(tokenLimits?.maxOutputTokens);
		const thinking = kiroThinkingConfig(candidate);
		models.set(id, {
			id,
			name: typeof candidate.modelName === "string" && candidate.modelName.trim() ? candidate.modelName.trim() : id,
			api: "kiro-agent",
			provider: "kiro",
			baseUrl: baseUrl ?? `https://runtime.${region}.kiro.dev`,
			reasoning: thinking !== undefined,
			input: ["text"],
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: maxInputTokens ?? 200_000,
			maxTokens: maxOutputTokens ?? 64_000,
			...(thinking ? { thinking } : undefined),
		});
	}
	return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

// Both Kiro reasoning schemas accept the same effort ladder (low..max); the
// `reasoning` schema's `none` is the off state, expressed via `disableReasoning`
// rather than a user-facing effort tier. The mode discriminates the wire shape
// (`thinking`+`output_config` for Claude-family, `reasoning` for GPT-family) so
// the provider serializes schema-appropriate fields under `additionalProperties: false`.
const KIRO_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

function kiroThinkingConfig(candidate: Record<string, unknown>): ThinkingConfig | undefined {
	const schema = candidate.additionalModelRequestFieldsSchema;
	if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
	if (isRecord(schema.properties.thinking)) {
		return { mode: "kiro-thinking", efforts: KIRO_REASONING_EFFORTS };
	}
	if (isRecord(schema.properties.reasoning)) {
		return { mode: "kiro-reasoning", efforts: KIRO_REASONING_EFFORTS };
	}
	return undefined;
}

function finitePositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
