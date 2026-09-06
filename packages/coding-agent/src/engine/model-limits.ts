import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";

export interface ResolvedModelLimits {
	contextWindow: number;
	maxOutputTokens: number;
	referenceProvider: string;
	referenceModelId: string;
}

/** Resolve execution limits from the exact model identity through the bundled canonical reference index. */
export function resolveCanonicalModelLimits(modelIdentityId: string): ResolvedModelLimits | undefined {
	const identity = modelIdentityId.trim();
	if (!identity) return undefined;
	const reference = resolveModelReference(identity, getBundledModelReferenceIndex());
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
	return {
		contextWindow,
		maxOutputTokens,
		referenceProvider: reference.provider,
		referenceModelId: reference.id,
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
