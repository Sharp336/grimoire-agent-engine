import type { UsageModelCoverage } from "./agent-session-types";

/**
 * Build the per-provider coverage of available models by live quantitative
 * usage data. `resolveReportingIds` returns the subset of `modelIds` whose
 * usage maps to a quantitative scope for the provider (AuthStorage's
 * `getUsageReportingModelIds`). Providers with no reporting model are omitted;
 * duplicate registry entries and duplicate reporting ids count once, so a
 * fully-covered provider cannot be misread as partially covered.
 */
export function buildUsageModelCoverage<P extends string>(
	models: ReadonlyArray<{ provider: P; id: string }>,
	resolveReportingIds: (provider: P, modelIds: string[]) => readonly string[],
): Map<string, UsageModelCoverage> {
	const modelIdsByProvider = new Map<P, Set<string>>();
	for (const model of models) {
		const modelIds = modelIdsByProvider.get(model.provider) ?? new Set<string>();
		modelIds.add(model.id);
		modelIdsByProvider.set(model.provider, modelIds);
	}
	const coverage = new Map<string, UsageModelCoverage>();
	for (const [provider, modelIds] of modelIdsByProvider) {
		const reportingIds = resolveReportingIds(provider, [...modelIds]);
		if (reportingIds.length === 0) continue;
		const reporting = [...new Set(reportingIds)]
			.map(modelId => `${provider}/${modelId}`)
			.sort((left, right) => left.localeCompare(right));
		coverage.set(provider, { reporting, availableCount: modelIds.size });
	}
	return coverage;
}
