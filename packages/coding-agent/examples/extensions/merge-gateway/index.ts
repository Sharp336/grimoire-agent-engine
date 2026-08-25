import { APIError, MergeGateway } from "merge-gateway-sdk";
import type { ExtensionAPI, OAuthLoginCallbacks, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/**
 * omp-merge-gateway-provider
 *
 * Registers Merge Gateway (https://docs.merge.dev/merge-gateway/get-started)
 * as a single omp model provider so any Gateway route can be selected from
 * /model through one MERGE_GATEWAY_API_KEY.
 *
 * One provider serves both wires because omp resolves `baseUrl` and `api`
 * per model (`modelDef.baseUrl ?? providerBaseUrl`, custom-models.ts):
 *
 *   - default                       OpenAI-compatible wire (/v1/openai/chat/completions)
 *   - first-party anthropic routes  Anthropic-compatible wire (/v1/messages)
 *
 * The Anthropic wire preserves signed thinking blocks across multi-round tool
 * loops (Gateway drops unsigned blocks on replay), so first-party Claude
 * routes are pinned to it. `reasoning_effort` is suppressed on OpenAI-wire
 * models because Gateway forwards it and some vendors reject it.
 *
 * Catalog discovery and key validation go through the official
 * `merge-gateway-sdk` client (auth header, request timeout, typed errors),
 * per https://docs.merge.dev/merge-gateway and the gateway-implement guide.
 */

const PROVIDER = "merge-gateway";
/** The SDK's default base URL; pinned here so the OpenAI-wire surface matches. */
const OPENAI_BASE_URL = "https://api-gateway.merge.dev/v1/openai";
const ANTHROPIC_BASE_URL = "https://api-gateway.merge.dev";
const ENV_VAR = "MERGE_GATEWAY_API_KEY";

/** Page size for `GET /models` (Gateway caps at 500). */
const CATALOG_PAGE_LIMIT = 500;
/** Hard stop for pagination so a broken cursor cannot loop forever. */
const CATALOG_MAX_PAGES = 20;

/**
 * One execution-vendor entry inside a catalog model's `vendors` map. Field
 * names follow the live REST catalog; several are optional because the
 * official SDK models a flatter shape than the wire currently returns, and
 * this parser accepts both.
 */
interface CatalogVendor {
	context_window?: number;
	max_output_tokens?: number;
	availability_status?: string;
	capabilities?: {
		input?: string[];
		output?: string[];
		supports_tool_calling?: boolean;
		supports_reasoning?: boolean;
	};
	pricing?: {
		input_per_million?: number;
		output_per_million?: number;
	};
}

/** One canonical catalog model (top-level `model`, `display_name`, `vendors`). */
interface CatalogModel {
	model: string;
	display_name?: string;
	availability_status?: string;
	vendors?: Record<string, CatalogVendor>;
}

/** A single page of the paginated `GET /models` envelope. */
interface CatalogPage {
	data?: CatalogModel[];
	has_more?: boolean;
	next_cursor?: string | null;
}

/** Sink for non-fatal discovery warnings (wired to pi.logger by the factory). */
export type WarnSink = (message: string) => void;

/**
 * Pick the execution vendor that will serve a catalog model: prefer the
 * canonical owner vendor (the prefix of `model`, e.g. `anthropic` for
 * `anthropic/…`) when it is available; otherwise the first available vendor.
 * Returns the vendor id along with its entry so callers can tell WHICH route
 * backs a model — the id prefix alone does not (`anthropic/…` can be served
 * through bedrock).
 */
export function pickVendor(entry: CatalogModel): { id: string; vendor: CatalogVendor } | undefined {
	const vendors = entry.vendors;
	if (!vendors) return undefined;
	const owner = entry.model.split("/")[0];
	const preferred = vendors[owner];
	if (preferred?.availability_status === "available") return { id: owner, vendor: preferred };
	const fallback = Object.entries(vendors).find(([, v]) => v.availability_status === "available");
	if (!fallback) return undefined;
	return { id: fallback[0], vendor: fallback[1] };
}

/**
 * Map a catalog entry to an omp model config, or null to drop it. A model is
 * kept only when a vendor route is available AND it supports tool calling AND
 * its output includes "text" — which excludes embeddings and image/audio/video
 * generation models.
 *
 * First-party `anthropic` routes are pinned to the Anthropic-compatible wire
 * (signed thinking blocks); everything else rides the OpenAI-compatible wire
 * with `supportsReasoningEffort` disabled.
 */
export function mapCatalogEntry(entry: CatalogModel): ProviderModelConfig | null {
	const picked = pickVendor(entry);
	if (!picked) return null;
	const caps = picked.vendor.capabilities ?? {};
	if (caps.supports_tool_calling !== true) return null;
	if (!(caps.output ?? []).includes("text")) return null;
	const input: ("text" | "image")[] = (caps.input ?? []).includes("image") ? ["text", "image"] : ["text"];
	const model: ProviderModelConfig = {
		id: entry.model,
		name: entry.display_name ?? entry.model,
		reasoning: caps.supports_reasoning === true,
		input,
		cost: {
			input: picked.vendor.pricing?.input_per_million ?? 0,
			output: picked.vendor.pricing?.output_per_million ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: picked.vendor.context_window ?? 128_000,
		maxTokens: picked.vendor.max_output_tokens ?? 16_384,
	};
	if (picked.id === "anthropic") {
		model.api = "anthropic-messages";
		model.baseUrl = ANTHROPIC_BASE_URL;
	} else {
		model.baseUrl = OPENAI_BASE_URL;
		model.compat = { supportsReasoningEffort: false };
	}
	return model;
}

function describeError(error: unknown): string {
	if (error instanceof APIError) {
		return `${error.name}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Fetch every raw catalog entry, following the cursor envelope. */
async function fetchRawCatalog(apiKey: string, warn: WarnSink): Promise<CatalogModel[]> {
	const client = new MergeGateway({ apiKey });
	const entries: CatalogModel[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
		const pageData = (await client.models.list({
			limit: CATALOG_PAGE_LIMIT,
			cursor,
		})) as unknown as CatalogPage;
		entries.push(...(pageData.data ?? []));
		if (pageData.has_more === false || !pageData.next_cursor) return entries;
		cursor = pageData.next_cursor;
	}
	// Cursor never terminated within the cap: keep what we have rather than
	// silently dropping the request on the floor, but say so through the
	// logger — never stderr/stdout, discovery can run while a TUI/RPC session
	// is rendering.
	warn(`catalog exceeded ${CATALOG_MAX_PAGES} pages; showing the first ${entries.length} models`);
	return entries;
}

/**
 * Discover the live model catalog from Gateway. Without a key returns an
 * empty list — the picker simply shows nothing until the user authenticates.
 * With a key, pages through the catalog and maps every tool-callable text
 * model. `warn` receives non-fatal notices; omp wires it to its logger.
 */
export async function fetchModels(
	apiKey: string | undefined,
	warn: WarnSink = () => {},
): Promise<ProviderModelConfig[]> {
	if (!apiKey) return [];
	try {
		const entries = await fetchRawCatalog(apiKey, warn);
		return entries.map(mapCatalogEntry).filter(m => m !== null);
	} catch (error) {
		throw new Error(`Merge Gateway model discovery failed: ${describeError(error)}`);
	}
}

export interface ValidateOptions {
	/** Aborts the probe — wired to the /login flow's cancel signal. */
	signal?: AbortSignal;
	/** Request seam override — the /login flow supplies its own. */
	fetch?: typeof fetch;
}

/**
 * Cheap key probe: a single model request validates the key. Error messages
 * mirror the documented Gateway error taxonomy (401 invalid key, 402 budget
 * exhausted, 429 rate limited). Honors the caller's signal and fetch seam so
 * cancelling /login aborts an in-flight probe.
 */
export async function validateKey(key: string, options: ValidateOptions = {}): Promise<void> {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("No API key provided");
	const doFetch = options.fetch ?? fetch;
	const res = await doFetch(`${OPENAI_BASE_URL.replace(/\/openai$/, "")}/models?limit=1`, {
		headers: { Authorization: `Bearer ${trimmed}` },
		signal: options.signal,
	});
	if (res.status === 401 || res.status === 403) {
		throw new Error("Invalid Merge Gateway API key");
	}
	if (res.status === 402) {
		throw new Error("Merge Gateway budget exhausted (HTTP 402): upgrade or raise your spend limit.");
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 200);
		throw new Error(`Merge Gateway key validation failed: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
	}
}

/** Shared /login paste-key flow. Returning a string persists it as an API key. */
export async function login(callbacks: OAuthLoginCallbacks): Promise<string> {
	const pasted = await callbacks.onPrompt({
		message: "Paste your Merge Gateway API key",
		placeholder: "mg_…",
	});
	await validateKey(pasted.trim(), {
		signal: callbacks.signal,
		fetch: callbacks.fetch ?? fetch,
	});
	return pasted.trim();
}

/**
 * Register the provider. apiKey is set only when the env var is actually
 * defined: omp resolves apiKey as env-var-name-or-literal, and passing the
 * name while the var is unset would store the bogus literal
 * "MERGE_GATEWAY_API_KEY". When unset, users authenticate once via /login
 * (static key; no refresh).
 *
 * No provider-level baseUrl: omp's provider transport override wins over
 * per-model baseUrl (`override.baseUrl ?? entry.baseUrl`), so a provider
 * default would clobber the Anthropic-wire routes. Every model therefore
 * carries its own wire-specific baseUrl.
 */
export default function (pi: ExtensionAPI): void {
	const apiKeyConfig = process.env[ENV_VAR] ? ENV_VAR : undefined;

	pi.registerProvider(PROVIDER, {
		...(apiKeyConfig ? { apiKey: apiKeyConfig } : {}),
		api: "openai-completions",
		oauth: { name: "Merge Gateway", login },
		fetchDynamicModels: (apiKey: string | undefined) => fetchModels(apiKey, m => pi.logger.warn(m)),
	});
}
