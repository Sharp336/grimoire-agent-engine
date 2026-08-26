// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// Provider modules are loaded lazily; display metadata lives in types.ts so UI
// listings can share it without importing provider implementations.

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { type SearchParams, SearchProvider } from "./providers/base";
import {
	type BuiltInSearchProviderId,
	isBuiltInSearchProviderId,
	isSearchProviderId,
	retainSearchProviderOption,
	SEARCH_PROVIDER_LABELS,
	SEARCH_PROVIDER_ORDER,
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";
export { SEARCH_PROVIDER_ORDER } from "./types";

/** Structural provider contract accepted from runtime extensions. */
export interface ExtensionSearchProvider {
	readonly id: SearchProviderId;
	readonly label: string;
	readonly description: string;
	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean;
	isExplicitlyAvailable?(authStorage: AuthStorage): Promise<boolean> | boolean;
	search(params: SearchParams): Promise<SearchResponse>;
}

class ExtensionSearchProviderAdapter extends SearchProvider {
	readonly id: SearchProviderId;
	readonly label: string;
	#definition: ExtensionSearchProvider;

	constructor(definition: ExtensionSearchProvider, label: string) {
		super();
		this.id = definition.id;
		this.label = label;
		this.#definition = definition;
	}

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return this.#definition.isAvailable(authStorage);
	}

	override isExplicitlyAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return this.#definition.isExplicitlyAvailable?.(authStorage) ?? this.#definition.isAvailable(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return this.#definition.search(params);
	}
}

interface RegisteredExtensionSearchProvider {
	provider: SearchProvider;
	sourceId: string;
	label: string;
	description: string;
	releaseOption: () => void;
}

/** Session-local overlay containing providers contributed by loaded extensions. */
export class SearchProviderRegistry {
	#providers = new Map<SearchProviderId, RegisteredExtensionSearchProvider>();

	register(definition: ExtensionSearchProvider, sourceId: string): void {
		if (!isSearchProviderId(definition.id)) {
			throw new TypeError(`Invalid web search provider id: ${definition.id}`);
		}
		if (isBuiltInSearchProviderId(definition.id)) {
			throw new Error(`Cannot replace built-in web search provider "${definition.id}"`);
		}
		const label = definition.label.trim();
		const description = definition.description.trim();
		if (label.length === 0) {
			throw new TypeError(`Web search provider "${definition.id}" must have a label`);
		}
		if (description.length === 0) {
			throw new TypeError(`Web search provider "${definition.id}" must have a description`);
		}

		const existing = this.#providers.get(definition.id);
		if (existing) {
			if (existing.sourceId !== sourceId) {
				throw new Error(
					`Web search provider "${definition.id}" is already registered by extension "${existing.sourceId}"`,
				);
			}
			if (existing.label !== label || existing.description !== description) {
				throw new Error(`Unregister web search provider "${definition.id}" before changing its metadata`);
			}
			existing.provider = new ExtensionSearchProviderAdapter(definition, label);
			return;
		}

		const releaseOption = retainSearchProviderOption({ value: definition.id, label, description });
		this.#providers.set(definition.id, {
			provider: new ExtensionSearchProviderAdapter(definition, label),
			sourceId,
			label,
			description,
			releaseOption,
		});
	}

	unregister(id: SearchProviderId, sourceId: string): void {
		const existing = this.#providers.get(id);
		if (!existing || existing.sourceId !== sourceId) return;
		this.#providers.delete(id);
		existing.releaseOption();
	}

	get(id: SearchProviderId): SearchProvider | undefined {
		return this.#providers.get(id)?.provider;
	}

	ids(): SearchProviderId[] {
		return [...this.#providers.keys()];
	}

	dispose(): void {
		for (const registration of this.#providers.values()) registration.releaseOption();
		this.#providers.clear();
	}
}

interface ProviderMeta {
	id: BuiltInSearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<BuiltInSearchProviderId, ProviderMeta> = {
	perplexity: {
		id: "perplexity",
		label: SEARCH_PROVIDER_LABELS.perplexity,
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	gemini: {
		id: "gemini",
		label: SEARCH_PROVIDER_LABELS.gemini,
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	anthropic: {
		id: "anthropic",
		label: SEARCH_PROVIDER_LABELS.anthropic,
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	codex: {
		id: "codex",
		label: SEARCH_PROVIDER_LABELS.codex,
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	xai: {
		id: "xai",
		label: SEARCH_PROVIDER_LABELS.xai,
		load: async () => new (await import("./providers/xai")).XAIProvider(),
	},
	zai: {
		id: "zai",
		label: SEARCH_PROVIDER_LABELS.zai,
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	exa: {
		id: "exa",
		label: SEARCH_PROVIDER_LABELS.exa,
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	tinyfish: {
		id: "tinyfish",
		label: SEARCH_PROVIDER_LABELS.tinyfish,
		load: async () => new (await import("./providers/tinyfish")).TinyFishProvider(),
	},
	jina: {
		id: "jina",
		label: SEARCH_PROVIDER_LABELS.jina,
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	kagi: {
		id: "kagi",
		label: SEARCH_PROVIDER_LABELS.kagi,
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	tavily: {
		id: "tavily",
		label: SEARCH_PROVIDER_LABELS.tavily,
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	firecrawl: {
		id: "firecrawl",
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		load: async () => new (await import("./providers/firecrawl")).FirecrawlProvider(),
	},
	brave: {
		id: "brave",
		label: SEARCH_PROVIDER_LABELS.brave,
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	kimi: {
		id: "kimi",
		label: SEARCH_PROVIDER_LABELS.kimi,
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	parallel: {
		id: "parallel",
		label: SEARCH_PROVIDER_LABELS.parallel,
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	synthetic: {
		id: "synthetic",
		label: SEARCH_PROVIDER_LABELS.synthetic,
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: SEARCH_PROVIDER_LABELS.searxng,
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	duckduckgo: {
		id: "duckduckgo",
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
	google: {
		id: "google",
		label: SEARCH_PROVIDER_LABELS.google,
		load: async () => new (await import("./providers/google")).GoogleProvider(),
	},
	ecosia: {
		id: "ecosia",
		label: SEARCH_PROVIDER_LABELS.ecosia,
		load: async () => new (await import("./providers/ecosia")).EcosiaProvider(),
	},
	startpage: {
		id: "startpage",
		label: SEARCH_PROVIDER_LABELS.startpage,
		load: async () => new (await import("./providers/startpage")).StartpageProvider(),
	},
	mojeek: {
		id: "mojeek",
		label: SEARCH_PROVIDER_LABELS.mojeek,
		load: async () => new (await import("./providers/mojeek")).MojeekProvider(),
	},
	public: {
		id: "public",
		label: SEARCH_PROVIDER_LABELS.public,
		load: async () => new (await import("./providers/public")).PublicWebProvider(),
	},
};

const instanceCache = new Map<BuiltInSearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a built-in provider load. */
export function getSearchProviderLabel(id: SearchProviderId, registry?: SearchProviderRegistry): string {
	const extensionProvider = registry?.get(id);
	if (extensionProvider) return extensionProvider.label;
	return isBuiltInSearchProviderId(id) ? PROVIDER_META[id].label : id;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			const label = error.provider === provider.id ? provider.label : getSearchProviderLabel(error.provider);
			return `${label} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/**
 * Resolve an extension provider from the session overlay, or lazily load and
 * cache a built-in provider.
 */
export async function getSearchProvider(
	id: SearchProviderId,
	registry?: SearchProviderRegistry,
): Promise<SearchProvider> {
	const extensionProvider = registry?.get(id);
	if (extensionProvider) return extensionProvider;
	if (!isBuiltInSearchProviderId(id)) {
		throw new Error(`Unknown search provider: ${id}`);
	}
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const provider = await PROVIDER_META[id].load();
	instanceCache.set(id, provider);
	return provider;
}

/** Providers explicitly prioritized through settings. */
let orderedProvIds: readonly SearchProviderId[] = [];
let explicitProvIds = new Set<SearchProviderId>();

/**
 * Preserve configured extension IDs even when settings load before their
 * extensions. Candidate resolution admits them once the session registry has
 * the matching provider.
 */
export function setSearchProviderOrder(providers: readonly SearchProviderId[]): void {
	const prioritized = new Set(providers.filter(isSearchProviderId));
	explicitProvIds = prioritized;
	orderedProvIds = [...prioritized];
}

/** Providers excluded from web search resolution via settings. */
let excludedProvIds = new Set<SearchProviderId>();

/** Set providers that web search should never use, including fallbacks. */
export function setExcludedSearchProviders(providers: readonly SearchProviderId[]): void {
	excludedProvIds = new Set(providers);
}

/** `true` when settings exclude `id` from web search (auto chain and the Public Web fan-out). */
export function isSearchProviderExcluded(id: SearchProviderId): boolean {
	return excludedProvIds.has(id);
}

export interface SearchProviderCandidate {
	id: SearchProviderId;
	explicit: boolean;
}

/**
 * Return provider candidates without loading built-in modules. Configured
 * providers lead, followed by unlisted built-ins and then unlisted extensions.
 */
export function resolveProviderCandidates(
	forcedProvider?: SearchProviderId,
	registry?: SearchProviderRegistry,
): SearchProviderCandidate[] {
	const candidates: SearchProviderCandidate[] = [];
	const seen = new Set<SearchProviderId>();
	const isKnown = (id: SearchProviderId): boolean => isBuiltInSearchProviderId(id) || registry?.get(id) !== undefined;
	const append = (id: SearchProviderId, explicit: boolean): void => {
		if (seen.has(id) || isSearchProviderExcluded(id) || !isKnown(id)) return;
		seen.add(id);
		candidates.push({ id, explicit });
	};

	if (forcedProvider !== undefined) append(forcedProvider, true);
	for (const id of orderedProvIds) append(id, explicitProvIds.has(id));
	for (const id of SEARCH_PROVIDER_ORDER) append(id, explicitProvIds.has(id));
	for (const id of registry?.ids() ?? []) append(id, explicitProvIds.has(id));
	return candidates;
}

/**
 * Resolve the complete available provider chain.
 *
 * This compatibility helper loads every candidate. Search execution should use
 * {@link resolveProviderCandidates} so fallback modules load only when reached.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	forcedProvider?: SearchProviderId,
	registry?: SearchProviderRegistry,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	for (const candidate of resolveProviderCandidates(forcedProvider, registry)) {
		const provider = await getSearchProvider(candidate.id, registry);
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(authStorage)
			: await provider.isAvailable(authStorage);
		if (available) providers.push(provider);
	}

	return providers;
}
