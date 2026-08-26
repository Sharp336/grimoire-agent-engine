import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import {
	resolveProviderCandidates,
	resolveProviderChain,
	SearchProviderRegistry,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_CHOICES, SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = {
	hasAuth(provider: string): boolean {
		return provider === "jina" && Boolean(process.env.JINA_API_KEY);
	},
} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setExcludedSearchProviders([]);
	setSearchProviderOrder([]);
	restoreEnv();
});

function registerFixtureProvider(registry: SearchProviderRegistry, sourceId = "fixture-extension"): void {
	registry.register(
		{
			id: "fixture-search",
			label: "Fixture Search",
			description: "Fixture extension search provider",
			isAvailable: () => true,
			search: () => Promise.resolve({ provider: "fixture-search", sources: [] }),
		},
		sourceId,
	);
}

describe("resolveProviderCandidates", () => {
	it("orders the forced provider before configured and built-in fallbacks", () => {
		setSearchProviderOrder(["gemini", "exa"]);

		const candidates = resolveProviderCandidates("perplexity");

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual([
			"gemini",
			"exa",
			...SEARCH_PROVIDER_ORDER.filter(id => id !== "perplexity" && id !== "gemini" && id !== "exa"),
		]);
	});

	it("marks configured-order entries explicit so hand-listed providers keep explicit-selection semantics", () => {
		setSearchProviderOrder(["perplexity"]);

		const candidates = resolveProviderCandidates();

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates[1]?.explicit).toBe(false);
	});

	it("omits excluded providers without resolving them", () => {
		setExcludedSearchProviders(["duckduckgo", "google"]);

		const candidates = resolveProviderCandidates("exa");

		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
		expect(candidates.map(candidate => candidate.id)).not.toContain("google");
	});

	it("applies live settings edits, filtering invalid and duplicate provider IDs", () => {
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("providers.webSearchOrder", ["exa", "not-a-provider", "exa", "gemini"]);

		const candidates = resolveProviderCandidates();
		expect(candidates.slice(0, 2).map(candidate => candidate.id)).toEqual(["exa", "gemini"]);
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length);
	});
});

describe("SearchProviderRegistry", () => {
	it("activates a configured extension ID after its extension registers", () => {
		setSearchProviderOrder(["fixture-search"]);
		expect(resolveProviderCandidates().map(candidate => candidate.id)).not.toContain("fixture-search");

		const registry = new SearchProviderRegistry();
		try {
			registerFixtureProvider(registry);
			expect(resolveProviderCandidates(undefined, registry)[0]).toEqual({
				id: "fixture-search",
				explicit: true,
			});
		} finally {
			registry.dispose();
		}
	});

	it("keeps a live settings choice until every session registry releases it", () => {
		const first = new SearchProviderRegistry();
		const second = new SearchProviderRegistry();
		try {
			registerFixtureProvider(first);
			registerFixtureProvider(second);
			expect(SEARCH_PROVIDER_CHOICES.filter(option => option.value === "fixture-search")).toHaveLength(1);
			first.dispose();
			expect(SEARCH_PROVIDER_CHOICES.some(option => option.value === "fixture-search")).toBe(true);
			second.dispose();
			expect(SEARCH_PROVIDER_CHOICES.some(option => option.value === "fixture-search")).toBe(false);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it("routes the available chain through an extension provider", async () => {
		const registry = new SearchProviderRegistry();
		try {
			registerFixtureProvider(registry);
			setSearchProviderOrder(["fixture-search"]);
			setExcludedSearchProviders(SEARCH_PROVIDER_ORDER);
			const providers = await resolveProviderChain(authStorage, undefined, registry);
			expect(providers.map(provider => provider.id)).toEqual(["fixture-search"]);
		} finally {
			registry.dispose();
		}
	});

	it("rejects attempts to replace a built-in provider", () => {
		const registry = new SearchProviderRegistry();
		expect(() =>
			registry.register(
				{
					id: "brave",
					label: "Replacement",
					description: "Must not replace built-ins",
					isAvailable: () => true,
					search: () => Promise.resolve({ provider: "brave", sources: [] }),
				},
				"fixture-extension",
			),
		).toThrow('Cannot replace built-in web search provider "brave"');
	});
});

describe("resolveProviderChain", () => {
	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("ignores the forced provider when it is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("applies live settings edits to the exclusion chain", async () => {
		enableKeyBackedProviders();
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange(
			"providers.webSearchExclude",
			SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"),
		);

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});
});
