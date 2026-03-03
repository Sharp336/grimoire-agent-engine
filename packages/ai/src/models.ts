import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel(provider: GeneratedProvider, modelId: string): Model<Api> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId) as Model<Api>;
}

export function getBundledProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	let { input: inputRate, output: outputRate, cacheRead: cacheReadRate, cacheWrite: cacheWriteRate } = model.cost;

	// Apply premium long-context rates when total input exceeds the model's threshold.
	if (model.longContextPricing) {
		const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
		if (totalInput > model.longContextPricing.inputThreshold) {
			const { multipliers } = model.longContextPricing;
			inputRate *= multipliers.input;
			outputRate *= multipliers.output;
			cacheReadRate *= multipliers.cacheRead;
			cacheWriteRate *= multipliers.cacheWrite;
		}
	}

	usage.cost.input = (inputRate / 1_000_000) * usage.input;
	usage.cost.output = (outputRate / 1_000_000) * usage.output;
	usage.cost.cacheRead = (cacheReadRate / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (cacheWriteRate / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.1 Codex Max
 * - GPT-5.2 / GPT-5.3 model families
 * - Anthropic Messages API Opus 4.6 models (xhigh maps to adaptive effort "max"), or other models that support budget-based thinking
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.1-codex-max")) {
		return true;
	}
	return model.api === "anthropic-messages";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
