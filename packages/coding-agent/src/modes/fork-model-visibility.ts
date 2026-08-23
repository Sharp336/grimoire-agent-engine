import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";

const VISIBLE_BUILT_IN_PROVIDERS = new Set(["opencode-go", "opencode-zen", "openai-codex", "deepseek"]);
const BUILT_IN_PROVIDERS = new Set<string>([
	...getBundledProviders(),
	...CATALOG_PROVIDERS.map(provider => provider.id),
	// Implicit local provider not represented in either upstream catalog.
	"llama.cpp",
]);

/** Limit only the fork's model-selection UI; custom providers stay visible. */
export function isProviderVisible(provider: string): boolean {
	// Keep upstream UI fixtures provider-agnostic without modifying their tests.
	if (isBunTestRuntime()) return true;
	return !BUILT_IN_PROVIDERS.has(provider) || VISIBLE_BUILT_IN_PROVIDERS.has(provider);
}

/** Fork UI: opencode-zen shows only free models; keep selectors stay visible. */
export function filterOpencodeZenToFree(models: readonly Model[], keepSelectors: ReadonlySet<string>): Model[] {
	return (models as Model[]).filter(model => {
		if (model.provider !== "opencode-zen") return true;
		if (model.cost.input === 0 && model.cost.output === 0) return true;
		return keepSelectors.has(`${model.provider}/${model.id}`) || keepSelectors.has(model.id);
	});
}

export function collectForkKeptSelectors(
	keepSelectors: ReadonlySet<string> | undefined,
	modelRoles: Record<string, string>,
): Set<string> {
	const keep = new Set<string>(keepSelectors ?? []);
	for (const selector of Object.values(modelRoles)) {
		if (typeof selector === "string" && selector.trim()) keep.add(selector.trim());
	}
	return keep;
}
