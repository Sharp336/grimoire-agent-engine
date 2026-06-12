/**
 * Model facade exposed to extensions as `ctx.models`.
 *
 * Read-only model selection (list / current / resolve / family) plus an
 * out-of-band one-shot completion (`complete`). The completion builds its own
 * context and never touches session history — distinct from `pi.sendMessage`,
 * which injects into the live conversation. Credentials and telemetry are
 * resolved through core the same way the agent's own one-shot calls
 * (`inspect_image`, the eval completion bridge) are.
 */
import { type AgentTelemetryConfig, instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelString,
	getModelMatchPreferences,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ExtensionCompleteOptions, ExtensionModelQuery } from "./types";

/**
 * Host-supplied runtime plumbing for `ctx.models.complete()`. Provided by the
 * extension runner, never by extension authors. All fields optional: without a
 * telemetry source the completion still runs, just without an OTEL span.
 */
export interface ExtensionModelCompleteDeps {
	/** Telemetry source; read per call so spans attach to the live session. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Session id for telemetry correlation. */
	getSessionId?: () => string | null | undefined;
	/** Oneshot telemetry scope, e.g. the calling tool name → `extension:<scope>`. */
	scope?: string;
	/** Test seam: overrides the underlying `completeSimple` round-trip. */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/**
	 * Apply the session's secret obfuscation + stream hooks to a side request:
	 * obfuscate the caller context for the provider, layer session
	 * onPayload/onResponse/metadata/OpenRouter routing onto the options, and
	 * deobfuscate the response. Provided by the runner; absent → no transform.
	 */
	prepareSideRequest?: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions,
	) =>
		| {
				context: Context;
				options: SimpleStreamOptions;
				finalize: (message: AssistantMessage) => AssistantMessage;
		  }
		| undefined;
}

/** The session-bound side-request preparer threaded into the model facade. */
export type ExtensionSideRequestPreparer = NonNullable<ExtensionModelCompleteDeps["prepareSideRequest"]>;

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
	completeDeps?: ExtensionModelCompleteDeps,
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
	// resolveModelRoleValue expands a role alias (`pi/slow`) to its full configured
	// priority list and tries each pattern — the same path core selection uses — so a
	// fallback model lower in the list still resolves. Plain model strings pass through
	// as a single pattern.
	const resolve = (spec: string): Model<Api> | undefined =>
		resolveModelRoleValue(spec, available(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
			modelRegistry,
		}).model;
	return {
		list: () => available(),
		current: () => getModel(),
		resolve,
		family: (model: Model<Api>): string =>
			modelFamilyToken(modelRegistry.getCanonicalId(model) ?? model.id) || model.provider.toLowerCase(),
		complete: async (
			model: Model<Api> | string,
			request: Context,
			options?: ExtensionCompleteOptions,
		): Promise<AssistantMessage> => {
			const target = typeof model === "string" ? resolve(model) : model;
			if (!target) {
				throw new Error(`ctx.models.complete: no model matches "${String(model)}"`);
			}
			// A directly-passed Model bypasses resolve()'s scoping, so enforce enabledModels
			// here for that path only. String specs were already scoped through resolve();
			// re-checking their resolved id can wrongly drop valid provider aliases (e.g.
			// OpenRouter dated ids) whose canonical id isn't present verbatim in getAvailable().
			if (typeof model !== "string") {
				const patterns = settings?.get("enabledModels");
				if (
					patterns &&
					patterns.length > 0 &&
					!available().some(m => m.provider === target.provider && m.id === target.id)
				) {
					throw new Error(
						`ctx.models.complete: ${formatModelString(target)} is outside this session's enabledModels scope`,
					);
				}
			}
			const apiKey = await modelRegistry.getApiKey(target, completeDeps?.getSessionId?.() ?? undefined);
			if (!apiKey) {
				throw new Error(`ctx.models.complete: no API key available for ${formatModelString(target)}`);
			}
			const streamOptions: SimpleStreamOptions = {
				// Pass the registry resolver (not a static key) so streamSimple can run the
				// central auth retry/rotation path on 401/usage-limit for OAuth credentials.
				apiKey: modelRegistry.resolver(target, completeDeps?.getSessionId?.() ?? undefined),
				signal: options?.signal,
				reasoning: options?.effort,
				toolChoice: options?.toolChoice,
			};
			// Match the active session's secret obfuscation + stream hooks so a caller
			// context carrying real secrets is obfuscated outbound and deobfuscated back.
			const prepared = completeDeps?.prepareSideRequest?.(target, request, streamOptions);
			const result = await instrumentedCompleteSimple(
				target,
				prepared?.context ?? request,
				prepared?.options ?? streamOptions,
				{
					telemetry: resolveTelemetry(completeDeps?.getTelemetry?.(), completeDeps?.getSessionId?.() ?? undefined),
					oneshotKind: completeDeps?.scope ? `extension:${completeDeps.scope}` : "extension",
					completeImpl: completeDeps?.completeImpl,
				},
			);
			return prepared?.finalize ? prepared.finalize(result) : result;
		},
	};
}
