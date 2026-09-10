import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api } from "@oh-my-pi/pi-catalog/types";

export interface ResolvedModelLimits {
	contextWindow: number;
	maxOutputTokens: number;
	referenceProvider: string;
	referenceModelId: string;
	reasoningEfforts: readonly Effort[];
	reasoningOffApis: readonly Api[];
}

/** Resolve execution limits from the exact model identity through the bundled canonical reference index. */
export function resolveCanonicalModelLimits(modelIdentityId: string): ResolvedModelLimits | undefined {
	const identity = modelIdentityId.trim();
	if (!identity) return undefined;
	const reference = getBundledModelReferenceIndex().exact.get(identity.toLowerCase());
	const contextWindow = reference?.contextWindow;
	const maxOutputTokens = reference?.maxTokens;
	if (
		!reference ||
		typeof contextWindow !== "number" ||
		!Number.isSafeInteger(contextWindow) ||
		contextWindow <= 0 ||
		typeof maxOutputTokens !== "number" ||
		!Number.isSafeInteger(maxOutputTokens) ||
		maxOutputTokens <= 0
	) {
		return undefined;
	}
	const reasoningOffApis: Api[] = [];
	if (
		reference.reasoning &&
		(reference.thinking?.requiresEffort !== true || reference.thinking?.suppressWhenOff === true)
	) {
		if (reference.compat && "reasoningDisableMode" in reference.compat) {
			if (reference.provider === "openai" && reference.compat.reasoningDisableMode === "none-effort") {
				reasoningOffApis.push(
					"openai-completions",
					"openai-responses",
					"openai-codex-responses",
					"azure-openai-responses",
				);
			}
		} else {
			reasoningOffApis.push(reference.api);
		}
	}
	return {
		contextWindow,
		maxOutputTokens,
		referenceProvider: reference.provider,
		referenceModelId: reference.id,
		reasoningEfforts: getSupportedEfforts(reference),
		reasoningOffApis,
	};
}

export function resolveExecutableModelLimits(model: {
	modelIdentityId: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}): Pick<ResolvedModelLimits, "contextWindow" | "maxOutputTokens"> {
	const explicitContext = positiveInteger(model.contextWindow, "model.contextWindow");
	const explicitOutput = positiveInteger(model.maxOutputTokens, "model.maxOutputTokens");
	if (explicitContext !== undefined && explicitOutput !== undefined) {
		return { contextWindow: explicitContext, maxOutputTokens: explicitOutput };
	}
	const reference = resolveCanonicalModelLimits(model.modelIdentityId);
	const contextWindow = explicitContext ?? reference?.contextWindow;
	const maxOutputTokens = explicitOutput ?? reference?.maxOutputTokens;
	if (contextWindow === undefined || maxOutputTokens === undefined) {
		throw new Error(
			`AvailableModelRoute model limits are unknown for modelIdentityId ${model.modelIdentityId}; provide contextWindow and maxOutputTokens`,
		);
	}
	return { contextWindow, maxOutputTokens };
}

function positiveInteger(value: number | undefined, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
	return value;
}
