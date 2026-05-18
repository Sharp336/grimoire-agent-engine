import type { KnownApi, Model } from "../types";

export type CloudflareGatewayBackend = {
	/** Bundle-data prefix used by this backend (e.g. "anthropic", "workers-ai"). */
	prefix: "anthropic" | "openai" | "workers-ai" | "google-ai-studio";
	/** Wire API shape used to talk to this backend. */
	api: KnownApi;
	/** Path segment appended to the gateway base to form the request `baseUrl`. */
	pathSuffix: string;
};

const ANTHROPIC_BACKEND: CloudflareGatewayBackend = {
	prefix: "anthropic",
	api: "anthropic-messages",
	pathSuffix: "/anthropic",
};

const BACKENDS: Readonly<Record<string, CloudflareGatewayBackend>> = {
	anthropic: ANTHROPIC_BACKEND,
	openai: { prefix: "openai", api: "openai-completions", pathSuffix: "/openai/v1" },
	"workers-ai": { prefix: "workers-ai", api: "openai-completions", pathSuffix: "/workers-ai/v1" },
	"google-ai-studio": {
		prefix: "google-ai-studio",
		api: "openai-completions",
		pathSuffix: "/google-ai-studio/v1beta/openai",
	},
};

/**
 * Maps a bundled CF AI Gateway model ID to its routing decision.
 * Unknown / unprefixed IDs fall back to the Anthropic backend (legacy compat).
 */
export function classifyCloudflareAiGatewayBackend(modelId: string): CloudflareGatewayBackend {
	const slash = modelId.indexOf("/");
	if (slash < 0) return ANTHROPIC_BACKEND;
	const prefix = modelId.slice(0, slash);
	return BACKENDS[prefix] ?? ANTHROPIC_BACKEND;
}

/**
 * Resolves the backend-routed baseUrl for a CF AI Gateway model at request time.
 * Re-derived from `model.id` (not cached at registration) because the model
 * registry can stomp per-model `baseUrl` with a single provider-level URL from
 * models.yml — re-classifying here keeps routing authoritative.
 */
export function resolveCloudflareAiGatewayBaseUrl(model: Pick<Model, "id" | "baseUrl">): string {
	const backend = classifyCloudflareAiGatewayBackend(model.id);
	return `${normalizeCloudflareAiGatewayBase(model.baseUrl ?? "")}${backend.pathSuffix}`;
}

/**
 * Returns the wire model id for a CF AI Gateway bundled id — the bare id the
 * upstream backend expects in the request body. Bundle ids carry a backend
 * prefix (e.g. `workers-ai/@cf/moonshotai/kimi-k2.6`) for disambiguation; the
 * upstream backend only knows its own bare id (`@cf/moonshotai/kimi-k2.6`).
 * Unprefixed ids pass through unchanged.
 */
export function toCloudflareGatewayWireModelId(modelId: string): string {
	const slash = modelId.indexOf("/");
	if (slash < 0) return modelId;
	const prefix = modelId.slice(0, slash);
	return prefix in BACKENDS ? modelId.slice(slash + 1) : modelId;
}

// Ordered longest-first: a shorter suffix must not appear before any longer suffix that shares its prefix.
const KNOWN_SUFFIXES: readonly string[] = [
	"/google-ai-studio/v1beta/openai",
	"/workers-ai/v1",
	"/openai/v1",
	"/anthropic",
	"/openai",
	"/workers-ai",
	"/google-ai-studio",
];

/**
 * Strips a single trailing known suffix (e.g. `/anthropic`, `/workers-ai/v1`)
 * from a user-configured CF AI Gateway base URL. Idempotent against the bare
 * gateway base. Existing users with legacy `…/anthropic` configs keep working.
 */
export function normalizeCloudflareAiGatewayBase(baseUrl: string): string {
	const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	for (const suffix of KNOWN_SUFFIXES) {
		if (trimmed.endsWith(suffix)) {
			return trimmed.slice(0, -suffix.length);
		}
	}
	return trimmed;
}
