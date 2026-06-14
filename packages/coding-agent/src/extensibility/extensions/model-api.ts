/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, and compare model families — without touching the mutable registry or
 * duplicating resolution/family heuristics.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	getModelMatchPreferences,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ExtensionModelQuery } from "./types";

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	// Honor the session's path-scoped `enabledModels` allow-list so an extension
	// selects from the same scoped set core selection uses, not the raw auth set.
	const available = (): Model<Api>[] => {
		const all = modelRegistry.getAvailable();
		const patterns = settings?.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		const scoped = filterAvailableModelsByEnabledPatterns(all, patterns, modelRegistry);
		// The live session model (e.g. an explicit `--model` override) wins over
		// enabledModels in core selection, so keep it listable/resolvable even when
		// it falls outside the configured scope.
		const current = getModel();
		if (current && !scoped.some(m => m.provider === current.provider && m.id === current.id)) {
			return [current, ...scoped];
		}
		return scoped;
	};
	return {
		list: () => available(),
		current: () => getModel(),
		// resolveModelRoleValue expands a role alias (`pi/slow`) to its full configured
		// priority list and tries each pattern — the same path core selection uses — so a
		// fallback model lower in the list still resolves. Plain model strings pass through
		// as a single pattern.
		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelRoleValue(spec, available(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
				modelRegistry,
			}).model,
		family: (model: Model<Api>): string =>
			modelFamilyToken(modelRegistry.getCanonicalId(model) ?? model.id) || model.provider.toLowerCase(),
	};
}
