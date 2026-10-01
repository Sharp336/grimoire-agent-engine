import { AsyncLocalStorage } from "node:async_hooks";
import { type AssistantMessage, type Context, completeSimple, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";

/**
 * Managed-Engine executor for auxiliary helper completions. It runs an admitted
 * helper as an ordinary model effect of the current Attempt, or returns
 * undefined (no egress) when the model is not one of the Attempt's admitted routes.
 */
export type HelperCompletionExecutor = (
	model: Model,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage | undefined>;

/** A managed helper produced no result and made no provider request; callers take their no-result path. */
export class HelperCompletionUnavailableError extends Error {
	readonly retryable = false;

	constructor(setting: SettingPath) {
		super(`${setting}: helper model completion is unavailable in this managed session`);
		this.name = "HelperCompletionUnavailableError";
	}
}

const helperCompletionExecutor = new AsyncLocalStorage<HelperCompletionExecutor>();

/** Engine sessions scope every session operation so auxiliary helpers can never egress on their own. */
export function withHelperCompletionExecutor<T>(executor: HelperCompletionExecutor, callback: () => T): T {
	return helperCompletionExecutor.run(executor, callback);
}

/**
 * Auxiliary helper completion. Outside a managed Engine session this is plain
 * `completeSimple`. Inside one, an unconfigured (schema-default) helper setting
 * makes no request, and an explicitly configured one runs only through the
 * Engine executor. No result throws {@link HelperCompletionUnavailableError},
 * which every helper already handles as its existing no-result path.
 */
export async function helperCompletion(
	settings: Pick<Settings, "isConfigured">,
	setting: SettingPath,
	model: Model,
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const executor = helperCompletionExecutor.getStore();
	if (!executor) return await completeSimple(model, context, options);
	const message = settings.isConfigured(setting) ? await executor(model, context, options) : undefined;
	if (!message) throw new HelperCompletionUnavailableError(setting);
	return message;
}
