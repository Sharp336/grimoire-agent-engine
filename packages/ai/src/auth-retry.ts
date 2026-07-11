import type { OAuthAccess } from "./auth-storage";
import * as AIError from "./error";
import { isAuthRetryableError } from "./error/auth-classify";
import { isUsageLimit } from "./error/flags";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair drives shared authentication recovery:
 * - `error === undefined` → initial resolve (no force-refresh).
 * - `error !== undefined && !lastChance` → refresh the same credential.
 * - `error !== undefined && lastChance` → rotate to a sibling credential.
 *
 * Normal authentication errors follow the bounded a/b/c sequence. Usage-limit
 * errors call the sibling step repeatedly until the resolver exhausts or
 * repeats its credential pool.
 */
export interface ApiKeyResolveContext {
	/** True when resolving a sibling credential after an authentication failure. */
	lastChance: boolean;
	/** The error that triggered re-resolution, or `undefined` on initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Caller cancel signal, threaded into credential refresh and rotation. */
	signal?: AbortSignal;
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

/**
 * Wraps a resolver with a bearer that was already selected for this request.
 *
 * Callers that preflight credentials can pass the returned resolver to the
 * auth-retry driver without making the driver know about that preflight: the
 * first initial resolution reuses `seed`, and all later resolutions delegate to
 * `resolver`.
 */
export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return ctx => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

// Re-exported from the error module (its new home); see error/auth-classify.ts.
export { isAuthRetryableError };

/**
 * The ordered normal-auth retry steps after the initial attempt fails:
 * `false` → refresh same credential, `true` → switch once to a sibling.
 * Usage-limit recovery is intentionally separate because it walks every
 * distinct available sibling.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isUsageLimit(error));
		return (await resolver({ lastChance: rotateSibling, error, signal, previousKey })) || undefined;
	} catch {
		return undefined;
	}
}

type UsageLimitRotationState<TCredential, TFailure> = {
	credential: TCredential;
	failure: TFailure;
};

type UsageLimitRotationAttempt<TFailure, TResult> =
	| { type: "failure"; failure: TFailure }
	| { type: "success"; value: TResult };

type UsageLimitRotationResult<TCredential, TFailure, TResult> =
	| { type: "exhausted"; state: UsageLimitRotationState<TCredential, TFailure> }
	| { type: "non_usage"; state: UsageLimitRotationState<TCredential, TFailure> }
	| { type: "success"; value: TResult };

/**
 * Replays a quota-limited request with distinct sibling credentials.
 *
 * Credential pools can be larger than the normal a/b/c retry ladder. Stop
 * when selection is exhausted, cycles, or caller aborts.
 */
export async function rotateUsageLimitedSiblings<TCredential, TIdentity, TFailure, TResult>(
	initial: UsageLimitRotationState<TCredential, TFailure>,
	options: {
		credentialIdentity: (credential: TCredential) => TIdentity;
		failureError: (failure: TFailure) => unknown;
		resolveSibling: (state: UsageLimitRotationState<TCredential, TFailure>) => Promise<TCredential | undefined>;
		attempt: (credential: TCredential) => Promise<UsageLimitRotationAttempt<TFailure, TResult>>;
		signal?: AbortSignal;
	},
): Promise<UsageLimitRotationResult<TCredential, TFailure, TResult>> {
	let state = initial;
	const attemptedCredentials = new Set<TIdentity>([options.credentialIdentity(state.credential)]);
	while (true) {
		options.signal?.throwIfAborted();
		const sibling = await options.resolveSibling(state);
		if (sibling === undefined) return { type: "exhausted", state };
		const identity = options.credentialIdentity(sibling);
		if (attemptedCredentials.has(identity)) return { type: "exhausted", state };
		attemptedCredentials.add(identity);

		options.signal?.throwIfAborted();
		const outcome = await options.attempt(sibling);
		if (outcome.type === "success") return outcome;
		state = { credential: sibling, failure: outcome.failure };
		if (!isUsageLimit(options.failureError(state.failure))) return { type: "non_usage", state };
	}
}

/**
 * Runs an auth-protected operation through shared credential recovery.
 *
 * - A static string key (or any non-resolver) → one `attempt`, no retry.
 * - A resolver → initial `attempt`; normal authentication errors use a bounded
 *   refresh-same then switch-sibling ladder. Usage-limit errors skip refreshing
 *   the exhausted credential and walk distinct siblings until selection ends.
 *
 * Used by non-streaming consumers. The streaming driver in `stream.ts` uses
 * the same sibling-rotation primitive with replay-safe buffering.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	let lastKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (lastKey === undefined) throw missingKey();

	let lastError: unknown;
	try {
		return await attempt(lastKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	if (isUsageLimit(lastError)) {
		const rotation = await rotateUsageLimitedSiblings(
			{ credential: lastKey, failure: lastError },
			{
				credentialIdentity: credential => credential,
				failureError: failure => failure,
				resolveSibling: state => resolveRetryKey(resolver, true, state.failure, signal, state.credential),
				attempt: async credential => {
					try {
						return { type: "success", value: await attempt(credential) };
					} catch (error) {
						if (!isAuthError(error)) throw error;
						return { type: "failure", failure: error };
					}
				},
				signal,
			},
		);
		if (rotation.type === "success") return rotation.value;
		lastKey = rotation.state.credential;
		lastError = rotation.state.failure;
		if (rotation.type === "exhausted") throw lastError;
	}

	for (const lastChance of AUTH_RETRY_STEPS) {
		const nextKey = await resolveRetryKey(resolver, lastChance, lastError, signal, lastKey);
		if (nextKey === undefined || nextKey === lastKey) continue;
		lastKey = nextKey;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (and importing only the `OAuthAccess` type) so this module
 * never takes a runtime dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: { forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<OAuthAccess | undefined>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; signal?: AbortSignal },
	): Promise<boolean>;
}

export interface WithOAuthAccessOptions {
	/** Session id for credential stickiness, threaded into every resolve. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Override the retryable-error classifier (default {@link isAuthRetryableError}). */
	isAuthError?: (error: unknown) => boolean;
	/**
	 * Pre-resolved access used for the initial attempt. Callers that already
	 * resolved access for an availability gate pass it here so the helper
	 * doesn't double-resolve (mirrors the gateway resolver's `initialKey`).
	 */
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

/**
 * {@link withAuth} for consumers that require OAuth identity metadata.
 *
 * Normal authentication failures refresh the same credential once, then select
 * a sibling. Usage-limit failures select each distinct available sibling until
 * exhausted; `credentialId` provides stable sibling identity across token
 * refreshes, with the bearer as a compatibility fallback.
 */
export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.getOAuthAccess(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const resolveStep = async (lastChance: boolean, error: unknown): Promise<OAuthAccess | undefined> => {
		try {
			const rotateSibling = lastChance || isUsageLimit(error);
			if (!rotateSibling) return await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
			const rotated = await storage.rotateSessionCredential(provider, sessionId, { error, signal });
			if (!rotated) return undefined;
			return await storage.getOAuthAccess(provider, sessionId, { signal });
		} catch {
			return undefined;
		}
	};

	let lastError: unknown;
	try {
		return await attempt(lastAccess);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	if (isUsageLimit(lastError)) {
		const rotation = await rotateUsageLimitedSiblings(
			{ credential: lastAccess, failure: lastError },
			{
				credentialIdentity: credential => credential.credentialId ?? credential.accessToken,
				failureError: failure => failure,
				resolveSibling: state => resolveStep(true, state.failure),
				attempt: async credential => {
					try {
						return { type: "success", value: await attempt(credential) };
					} catch (error) {
						if (!isAuthError(error)) throw error;
						return { type: "failure", failure: error };
					}
				},
				signal,
			},
		);
		if (rotation.type === "success") return rotation.value;
		lastAccess = rotation.state.credential;
		lastError = rotation.state.failure;
		if (rotation.type === "exhausted") throw lastError;
	}

	for (const lastChance of AUTH_RETRY_STEPS) {
		const next = await resolveStep(lastChance, lastError);
		if (!next || next.accessToken === lastAccess.accessToken) continue;
		lastAccess = next;
		try {
			return await attempt(next);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}
