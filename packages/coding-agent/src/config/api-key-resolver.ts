import type { Api, ApiKeyResolver, AuthStorage, Model } from "@oh-my-pi/pi-ai";

/** Model slice accepted by the model-form `resolver(model, sessionId)` overload. */
export type ApiKeyResolverModel = Pick<Model<Api>, "provider" | "baseUrl" | "id" | "api" | "transport">;

export interface ApiKeyResolverOptions {
	/** Session id for credential stickiness; read at resolve time by the caller. */
	sessionId?: string;
	/** Provider base URL hint forwarded to the auth-storage cascade. */
	baseUrl?: string;
	/** Provider model id forwarded to model-scoped usage ranking/backoff. */
	modelId?: string;
	/** Transport determines whether a configured key authenticates a gateway instead of the upstream provider. */
	transport?: Model<Api>["transport"];
}

/**
 * Minimal slice of `ModelRegistry` the resolver needs. Typed structurally so
 * narrower registry shells (e.g. the commit pipeline's `CommitModelRegistry`)
 * can build resolvers without depending on the full class.
 */
export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: {
			baseUrl?: string;
			modelId?: string;
			transport?: Model<Api>["transport"];
			forceRefresh?: boolean;
			signal?: AbortSignal;
		},
	): Promise<string | undefined>;
	authStorage: Pick<AuthStorage, "rotateSessionCredential">;
	/**
	 * Build an {@link ApiKeyResolver} implementing the central a/b/c auth-retry
	 * policy: initial → resolve; step (b) → force-refresh same account; step (c)
	 * → rotate to a sibling credential, then re-resolve.
	 *
	 * Two call forms: `resolver(provider, options?)` for provider-scoped keys,
	 * and `resolver(model, sessionId?)` which derives `baseUrl`/`modelId`/`transport`
	 * from the model. The resolver is stateless (safe to reuse across requests).
	 * Callers that need the initial key for a guard can call
	 * `resolveApiKeyOnce(resolver)`.
	 */
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
}

/**
 * Default implementation of {@link ApiKeyResolverRegistry.resolver}.
 * Also usable standalone for structural registries that don't carry the method.
 */
export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyForProvider" | "authStorage">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId, transport } = options;
	return async ({ lastChance, error, signal, previousKey }) => {
		if (error === undefined) {
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId, transport });
		}
		if (lastChance) {
			if (transport === "pi-native") {
				// The configured key authenticates the gateway, not the upstream
				// OAuth provider. Re-resolve it (including command-backed keys)
				// without recording it as an OAuth credential or rotating accounts.
				return registry.getApiKeyForProvider(provider, sessionId, {
					baseUrl,
					modelId,
					transport,
					forceRefresh: true,
					signal,
				});
			}
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor any retry-after here — if a
			// sibling exists we switch immediately; the precise no-sibling backoff
			// is owned by `markUsageLimitReached` (default + server usage-report
			// reset) and the outer whole-turn retry layer.
			await registry.authStorage.rotateSessionCredential(provider, sessionId, {
				error,
				modelId,
				signal,
				apiKey: previousKey,
			});
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId, transport });
		}
		return registry.getApiKeyForProvider(provider, sessionId, {
			baseUrl,
			modelId,
			transport,
			forceRefresh: true,
			signal,
		});
	};
}
