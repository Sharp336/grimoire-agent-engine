import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "./devin-gen/exa/api_server_pb/api_server_pb";
import {
	type ClientModelConfig,
	DisplayOption,
	MetadataSchema,
} from "./devin-gen/exa/codeium_common_pb/codeium_common_pb";

const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEVIN_IDE_NAME = "chisel";
const DEVIN_IDE_VERSION = "0.0.0-dev";
const DEVIN_EXTENSION_NAME = "chisel";
const DEVIN_EXTENSION_VERSION = "0.0.0-dev";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

export interface DevinCredential {
	token: string;
	apiEndpoint?: string;
}

export function parseDevinCredential(apiKey: string | undefined): DevinCredential {
	if (!apiKey) return { token: "" };
	try {
		const value = JSON.parse(apiKey) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			if (typeof record.token === "string") {
				return {
					token: record.token,
					apiEndpoint:
						typeof record.apiEndpoint === "string" && record.apiEndpoint.length > 0
							? record.apiEndpoint
							: undefined,
				};
			}
		}
	} catch {
		// Legacy credentials are opaque session tokens rather than JSON.
	}
	return { token: apiKey };
}

export function devinOs(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "windows" : platform;
}

/** Best-effort match for labels whose wording implies a thinking / reasoning-effort variant. */
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;
function supportsDevinThinking(config: ClientModelConfig): boolean {
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return config.modelInfo?.modelFeatures?.supportsThinking === true || REASONING_LABEL_PATTERN.test(config.label);
}

/**
 * Options for fetching dynamic Devin (Codeium Cascade) models from `GetCliModelConfigs`.
 */
export interface DevinModelDiscoveryOptions {
	/** Codeium session token carried inside protobuf `Metadata.apiKey`. */
	apiKey?: string;
	/** Optional Codeium API base URL override. */
	baseUrl?: string;
	/** Optional request timeout in milliseconds (default 5000). */
	timeoutMs?: number;
	/** Optional caller abort signal, combined with the internal timeout. */
	signal?: AbortSignal;
	/** Optional fetch implementation for request-debug/proxy/test transports. */
	fetch?: FetchImpl;
}

/**
 * Fetches Devin models through the `GetCliModelConfigs` unary Connect RPC and
 * normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchDevinModels(
	options: DevinModelDiscoveryOptions,
): Promise<ModelSpec<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const credential = parseDevinCredential(options.apiKey);
	const resolvedBaseUrl =
		credential.apiEndpoint && (!options.baseUrl || options.baseUrl === DEVIN_DEFAULT_BASE_URL)
			? credential.apiEndpoint
			: (options.baseUrl ?? DEVIN_DEFAULT_BASE_URL);
	const requestUrl = `${resolvedBaseUrl.replace(/\/+$/, "")}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const apiKey = normalizeDevinSessionToken(credential.token);
		const request = create(GetCliModelConfigsRequestSchema, {
			metadata: create(MetadataSchema, {
				apiKey,
				ideName: DEVIN_IDE_NAME,
				ideVersion: DEVIN_IDE_VERSION,
				extensionName: DEVIN_EXTENSION_NAME,
				extensionVersion: DEVIN_EXTENSION_VERSION,
				locale: "en",
				os: devinOs(),
				// Surface the display mode the normalizer below retains. Empty
				// negotiation can leave accounts with only the legacy catalog and no
				// user-selectable router entries; advertising MODEL_ROUTER opts the
				// response into them. Default/UNSPECIFIED models are returned
				// regardless and still pass the client-side filter.
				supportedModelDisplays: [DisplayOption.MODEL_ROUTER],
			}),
		});
		const body = toBinary(GetCliModelConfigsRequestSchema, request);

		const headers: Record<string, string> = {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
			authorization: `Basic ${apiKey}`,
		};

		const fetchImpl = discoveryFetch(options.fetch);
		const response = await fetchImpl(requestUrl, { method: "POST", headers, body, signal });
		if (!response.ok) {
			return null;
		}

		const decoded = decodeCliModelConfigsResponse(new Uint8Array(await response.arrayBuffer()));
		if (!decoded) {
			return null;
		}

		return normalizeDevinModels(decoded.clientModelConfigs, resolvedBaseUrl);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Decodes a raw (unframed) `GetCliModelConfigsResponse`. Bun's `fetch` usually
 * auto-decompresses gzip, so the direct decode is attempted first; a
 * `gunzipSync` fallback covers runtimes that hand back the still-compressed body.
 */
function decodeCliModelConfigsResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetCliModelConfigsResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetCliModelConfigsResponseSchema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}

/** First candidate that is a finite positive number, else `undefined`. */
function firstFinitePositive(...candidates: (number | undefined)[]): number | undefined {
	for (const candidate of candidates) {
		if (candidate !== undefined && Number.isFinite(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrlOverride: string | undefined,
): ModelSpec<"devin-agent">[] {
	const byId = new Map<string, ModelSpec<"devin-agent">>();
	for (const config of configs) {
		if (config.disabled) {
			continue;
		}
		// Only surface the display options actually requested above. The server may
		// still volunteer others (devin's internal `subagent-default` and
		// `memory-migration-default` routers ride DISPLAY_OPTION 6), and those are
		// plumbing, not user-selectable models.
		const display = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
		if (display !== DisplayOption.UNSPECIFIED && display !== DisplayOption.MODEL_ROUTER) {
			continue;
		}
		const id = config.modelUid.trim();
		if (!id) {
			continue;
		}
		const input: ("text" | "image")[] = config.supportsImages ? ["text", "image"] : ["text"];
		const modelInfo = config.modelInfo;
		const contextWindow = firstFinitePositive(modelInfo?.maxTokens, config.maxTokens) ?? DEFAULT_CONTEXT_WINDOW;
		// Trust the dedicated output cap when the catalog provides it; otherwise
		// keep the 64k legacy default. `config.maxTokens` is a context-window
		// value (e.g. 200k) and must not become the output-token limit.
		const maxTokens = firstFinitePositive(modelInfo?.maxOutputTokens) ?? DEFAULT_MAX_TOKENS;
		byId.set(id, {
			id,
			name: config.label.trim() || id,
			api: "devin-agent",
			provider: "devin",
			baseUrl: baseUrlOverride ?? DEVIN_DEFAULT_BASE_URL,
			reasoning: supportsDevinThinking(config),
			input,
			supportsTools: true,
			cost: devinModelCost(config),
			contextWindow,
			maxTokens,
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function devinModelCost(config: ClientModelConfig): ModelSpec<"devin-agent">["cost"] {
	let input = 0;
	let cacheRead = 0;
	let output = 0;
	for (const dimension of config.modelDimensions) {
		switch (dimension.label) {
			case "Input":
				input = dimension.value;
				break;
			case "Cached input":
				cacheRead = dimension.value;
				break;
			case "Output":
				output = dimension.value;
				break;
		}
	}
	return { input, output, cacheRead, cacheWrite: 0 };
}
