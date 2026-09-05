import { AsyncLocalStorage } from "node:async_hooks";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { extractRetryHint, isRetryableStatus } from "@oh-my-pi/pi-utils";
import type { ProviderRequestHook } from "../sdk";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;

export const PROVIDER_RETRY_DEFERRED_CODE = "engine_provider_retry_deferred";
export const PROVIDER_RETRY_EXHAUSTED_CODE = "engine_provider_retry_budget_exhausted";
export const PROVIDER_RETRY_PERMANENT_CODE = "engine_provider_permanent_failure";

interface ProviderRetryBudgetState {
	attempts: number;
	readonly maxAttempts: number;
}

const providerRetryBudget = new AsyncLocalStorage<ProviderRetryBudgetState>();

class EngineProviderRetryError extends Error {
	readonly retryable = false;

	constructor(
		readonly code:
			| typeof PROVIDER_RETRY_DEFERRED_CODE
			| typeof PROVIDER_RETRY_EXHAUSTED_CODE
			| typeof PROVIDER_RETRY_PERMANENT_CODE,
		message: string,
		options?: ErrorOptions,
	) {
		super(`${code}: ${message}`, options);
		this.name = "EngineProviderRetryError";
	}
}

function abortError(): DOMException {
	return new DOMException("The provider request was aborted", "AbortError");
}

function retryDescription(status: number, statusText: string, retryAfterMs: number | undefined): string {
	return `HTTP ${status}${statusText ? ` ${statusText}` : ""}${retryAfterMs === undefined ? "" : `; retry-after-ms=${Math.ceil(retryAfterMs)}`}`;
}

function deferredError(reason: string, options?: ErrorOptions): EngineProviderRetryError {
	return new EngineProviderRetryError(PROVIDER_RETRY_DEFERRED_CODE, `${reason}; retry through Engine`, options);
}

function permanentResponseFailure(model: Model, response: Response, body: string | undefined): string | undefined {
	const id = AIError.classifyMessage({
		api: model.api,
		provider: model.provider,
		model: model.id,
		errorStatus: response.status,
		errorMessage: `HTTP ${response.status} ${body ?? ""}`,
	});
	if (AIError.is(id, AIError.Flag.AuthFailed)) return "authentication failed";
	if (AIError.is(id, AIError.Flag.AccountPolicy)) return "account policy denied the request";
	if (AIError.is(id, AIError.Flag.ContentBlocked)) return "provider policy blocked the request";
	if (AIError.is(id, AIError.Flag.OAuthExpiry)) return "provider authorization expired";
	if (AIError.is(id, AIError.Flag.PayloadRejected)) return "provider rejected the request payload";
	return undefined;
}

/** Share one physical-request budget across a complete Engine model-call saga. */
export function withProviderRetryBudget<T>(maxAttempts: number, callback: () => T): T {
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("Provider retry maxAttempts must be a positive safe integer");
	}
	return providerRetryBudget.run({ attempts: 0, maxAttempts }, callback);
}

/**
 * Compose the Engine retry budget below a host admission hook. Admission runs
 * first; only a fetch that reaches the provider consumes the shared budget.
 */
export function createProviderRetryBudgetHook(inner?: ProviderRequestHook): ProviderRequestHook {
	return {
		wrapFetch(model: Model, fetch: Fetch): Fetch {
			let fetchedInThisStream = false;
			const budgetedFetch: Fetch = async (input, init) => {
				const state = providerRetryBudget.getStore();
				if (!state) return await fetch(input, init);
				if (init?.signal?.aborted) throw abortError();
				if (fetchedInThisStream) {
					throw deferredError("a nested provider retry was suppressed");
				}
				if (state.attempts >= state.maxAttempts) {
					throw new EngineProviderRetryError(
						PROVIDER_RETRY_EXHAUSTED_CODE,
						`exhausted after ${state.maxAttempts} physical requests`,
					);
				}
				fetchedInThisStream = true;
				state.attempts++;
				let response: Response;
				try {
					response = await fetch(input, init);
				} catch (error) {
					if (init?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
					if (error && typeof error === "object" && Reflect.get(error, "retryable") === false) throw error;
					throw deferredError(error instanceof Error ? error.message : String(error), { cause: error });
				}
				if (!isRetryableStatus(response.status)) return response;
				const body = await response
					.clone()
					.text()
					.catch(() => undefined);
				const retryAfterMs = extractRetryHint(response, body);
				const permanentFailure = permanentResponseFailure(model, response, body);
				await response.body?.cancel().catch(() => {});
				if (permanentFailure) {
					throw new EngineProviderRetryError(
						PROVIDER_RETRY_PERMANENT_CODE,
						`${retryDescription(response.status, response.statusText, retryAfterMs)}; ${permanentFailure}`,
					);
				}
				throw deferredError(retryDescription(response.status, response.statusText, retryAfterMs));
			};
			const admittedFetch = inner?.wrapFetch(model, budgetedFetch) ?? budgetedFetch;
			return async (input, init) => {
				const state = providerRetryBudget.getStore();
				if (state && fetchedInThisStream) throw deferredError("a nested provider retry was suppressed");
				if (state && state.attempts >= state.maxAttempts) {
					throw new EngineProviderRetryError(
						PROVIDER_RETRY_EXHAUSTED_CODE,
						`exhausted after ${state.maxAttempts} physical requests`,
					);
				}
				return await admittedFetch(input, init);
			};
		},
	};
}

/** Provider loops call this before replaying an already-failed stream. */
export async function deferNestedProviderRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError();
	throw deferredError(
		`a nested provider stream retry was suppressed; retry-after-ms=${Math.max(0, Math.ceil(delayMs))}`,
	);
}

export function isDeferredProviderRetryMessage(message: string): boolean {
	return message.includes(PROVIDER_RETRY_DEFERRED_CODE);
}

export function isExhaustedProviderRetryMessage(message: string): boolean {
	return message.includes(PROVIDER_RETRY_EXHAUSTED_CODE);
}

export function isPermanentProviderFailureMessage(message: string): boolean {
	return message.includes(PROVIDER_RETRY_PERMANENT_CODE);
}
