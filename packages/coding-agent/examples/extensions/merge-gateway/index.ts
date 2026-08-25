import type { ExtensionAPI, OAuthLoginCallbacks, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/**
 * omp-merge-gateway-provider
 *
 * Registers Merge Gateway (https://docs.merge.dev/merge-gateway/get-started) as
 * two omp model providers so any Gateway route can be selected from /model:
 *
 *   - "merge-gateway"           OpenAI-compatible wire (`/v1/openai/chat/completions`)
 *   - "merge-gateway-anthropic" Anthropic-compatible wire (`/v1/messages`)
 *
 * Two registrations are required because the two wires need different base URLs:
 * omp's openai-completions client appends `/chat/completions` to the base URL,
 * while its anthropic client builds `${baseURL}/v1/messages` with no stripping.
 * The Anthropic wire preserves signed thinking blocks across multi-round tool
 * loops (Gateway drops unsigned blocks on replay), so Claude routes get their
 * own provider registration.
 */

const PROVIDER_OPENAI = "merge-gateway";
const PROVIDER_ANTHROPIC = "merge-gateway-anthropic";
const OPENAI_BASE_URL = "https://api-gateway.merge.dev/v1/openai";
const ANTHROPIC_BASE_URL = "https://api-gateway.merge.dev";
const CATALOG_BASE = "https://api-gateway.merge.dev/v1";
const ENV_VAR = "MERGE_GATEWAY_API_KEY";

/** Page size for `GET /models` (Gateway caps at 500). */
const CATALOG_PAGE_LIMIT = 500;
/** Hard stop for pagination so a broken cursor cannot loop forever. */
const CATALOG_MAX_PAGES = 20;

/** One execution-vendor entry inside a catalog model's `vendors` map. */
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

/**
 * Merge Gateway routing-policy model. Gateway picks the real model per request;
 * omp only uses these fields for context accounting.
 */
export function makeDefaultRoutingEntry(): ProviderModelConfig {
	return {
		id: "default_routing",
		name: "Merge Gateway (routing policy)",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

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
 */
export function mapCatalogEntry(entry: CatalogModel): ProviderModelConfig | null {
	const picked = pickVendor(entry);
	if (!picked) return null;
	const caps = picked.vendor.capabilities ?? {};
	if (caps.supports_tool_calling !== true) return null;
	if (!(caps.output ?? []).includes("text")) return null;
	const input: ("text" | "image")[] = (caps.input ?? []).includes("image") ? ["text", "image"] : ["text"];
	return {
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
}

/** Fetch every raw catalog entry, following the cursor envelope. */
async function fetchRawCatalog(apiKey: string): Promise<CatalogModel[]> {
	const entries: CatalogModel[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
		const url = new URL(`${CATALOG_BASE}/models`);
		url.searchParams.set("limit", String(CATALOG_PAGE_LIMIT));
		if (cursor) url.searchParams.set("cursor", cursor);
		const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 200);
			throw new Error(`Merge Gateway model discovery failed: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
		}
		const pageData = (await res.json()) as CatalogPage;
		entries.push(...(pageData.data ?? []));
		if (pageData.has_more === false || !pageData.next_cursor) return entries;
		cursor = pageData.next_cursor;
	}
	// Cursor never terminated within the cap: keep what we have rather than
	// silently dropping the request on the floor, but say so.
	console.error(
		`[merge-gateway] catalog exceeded ${CATALOG_MAX_PAGES} pages; showing the first ${entries.length} models`,
	);
	return entries;
}

/**
 * Discover the live model catalog from Gateway. Without a key returns only the
 * routing-policy entry so the picker stays usable pre-auth; with a key pages
 * through the catalog and maps every tool-callable text model.
 */
export async function fetchCatalog(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
	if (!apiKey) return [makeDefaultRoutingEntry()];
	const entries = await fetchRawCatalog(apiKey);
	const models = entries.map(mapCatalogEntry).filter(m => m !== null);
	models.push(makeDefaultRoutingEntry());
	return models;
}

/**
 * Anthropic wire: only Claude routes served by the first-party `anthropic`
 * vendor (plus the routing entry). The id prefix alone is not enough —
 * `anthropic/…` models can be backed by bedrock, and first-party routes are
 * what guarantee signed thinking blocks survive multi-round tool loops.
 */
export async function fetchAnthropicWireModels(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
	if (!apiKey) return [makeDefaultRoutingEntry()];
	const entries = await fetchRawCatalog(apiKey);
	const models: ProviderModelConfig[] = [];
	for (const entry of entries) {
		if (!entry.model.startsWith("anthropic/")) continue;
		const picked = pickVendor(entry);
		if (picked?.id !== "anthropic") continue;
		const mapped = mapCatalogEntry(entry);
		if (mapped) models.push(mapped);
	}
	models.push(makeDefaultRoutingEntry());
	return models;
}

/** Cheap key probe: a single model request validates the key (401/403 ⇒ bad). */
export async function validateKey(key: string): Promise<void> {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("No API key provided");
	const res = await fetch(`${CATALOG_BASE}/models?limit=1`, {
		headers: { Authorization: `Bearer ${trimmed}` },
	});
	if (res.status === 401 || res.status === 403) {
		throw new Error("Invalid Merge Gateway API key");
	}
	if (!res.ok) {
		throw new Error(`Merge Gateway key validation failed: HTTP ${res.status}`);
	}
}

/** Shared /login paste-key flow. Returning a string persists it as an API key. */
export async function login(callbacks: OAuthLoginCallbacks): Promise<string> {
	const pasted = await callbacks.onPrompt({
		message: "Paste your Merge Gateway API key",
		placeholder: "mg_…",
	});
	await validateKey(pasted);
	return pasted.trim();
}

/**
 * Register both providers. apiKey is set only when the env var is actually
 * defined: omp resolves apiKey as env-var-name-or-literal, and passing the name
 * while the var is unset would store the bogus literal "MERGE_GATEWAY_API_KEY".
 * When unset, users authenticate once via /login (static key; no refresh).
 */
export default function (pi: ExtensionAPI): void {
	const apiKeyConfig = process.env[ENV_VAR] ? ENV_VAR : undefined;

	pi.registerProvider(PROVIDER_OPENAI, {
		baseUrl: OPENAI_BASE_URL,
		...(apiKeyConfig ? { apiKey: apiKeyConfig } : {}),
		api: "openai-completions",
		// Gateway forwards reasoning_effort and some vendors reject it.
		compat: { supportsReasoningEffort: false },
		oauth: { name: "Merge Gateway", login },
		fetchDynamicModels: fetchCatalog,
	});

	pi.registerProvider(PROVIDER_ANTHROPIC, {
		baseUrl: ANTHROPIC_BASE_URL,
		...(apiKeyConfig ? { apiKey: apiKeyConfig } : {}),
		api: "anthropic-messages",
		oauth: { name: "Merge Gateway (Anthropic wire)", login },
		fetchDynamicModels: fetchAnthropicWireModels,
	});
}
