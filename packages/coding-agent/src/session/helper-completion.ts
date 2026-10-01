import { AsyncLocalStorage } from "node:async_hooks";
import { type AssistantMessage, type Context, completeSimple, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";

/** Managed-Engine boundary for auxiliary helper completions of the current Attempt. */
export interface HelperCompletionBoundary {
	/** Admits one helper run before it resolves a model or credential; both happen inside. */
	run<T>(work: () => Promise<T>): Promise<T>;
	/**
	 * Completes as an ordinary recorded model effect when `model` is one of the Attempt's
	 * admitted routes; otherwise returns undefined without any request.
	 */
	complete(model: Model, context: Context, options: SimpleStreamOptions): Promise<AssistantMessage | undefined>;
}

/** A managed helper produced no result and made no provider request; callers take their no-result path. */
export class HelperCompletionUnavailableError extends Error {
	readonly retryable = false;

	constructor(setting: SettingPath) {
		super(`${setting}: helper model completion is unavailable in this managed session`);
		this.name = "HelperCompletionUnavailableError";
	}
}

const helperCompletionBoundary = new AsyncLocalStorage<HelperCompletionBoundary>();

/** Engine sessions scope every session operation so auxiliary helpers can never egress on their own. */
export function withHelperCompletionBoundary<T>(boundary: HelperCompletionBoundary, callback: () => T): T {
	return helperCompletionBoundary.run(boundary, callback);
}

/**
 * Whether a helper may run. Outside a managed Engine session it always may; inside one only
 * an explicitly configured setting may, because the schema-default online helpers are ambient.
 * Callers check this before resolving any model or credential.
 */
export function helperEnabled(settings: Pick<Settings, "isConfigured">, setting: SettingPath): boolean {
	return !helperCompletionBoundary.getStore() || settings.isConfigured(setting);
}

/**
 * Runs a helper's model resolution, credential lookup and request. A disabled helper throws
 * {@link HelperCompletionUnavailableError} before any of them; a managed one runs inside the
 * owner's admission so a credential refresh or billing transition never precedes it.
 */
export async function runHelper<T>(
	settings: Pick<Settings, "isConfigured">,
	setting: SettingPath,
	work: () => Promise<T>,
): Promise<T> {
	if (!helperEnabled(settings, setting)) throw new HelperCompletionUnavailableError(setting);
	const boundary = helperCompletionBoundary.getStore();
	return boundary ? await boundary.run(work) : await work();
}

/**
 * The helper's model completion. Outside a managed session this is plain `completeSimple`;
 * inside one it is the boundary's recorded effect, and no result throws
 * {@link HelperCompletionUnavailableError}, which every helper handles as its no-result path.
 */
export async function helperCompletion(
	setting: SettingPath,
	model: Model,
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const boundary = helperCompletionBoundary.getStore();
	if (!boundary) return await completeSimple(model, context, options);
	const message = await boundary.complete(model, context, options);
	if (!message) throw new HelperCompletionUnavailableError(setting);
	return message;
}
