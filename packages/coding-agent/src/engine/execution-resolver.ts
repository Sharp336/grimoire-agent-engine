import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	Api,
	AuthCredential,
	AuthCredentialStore,
	Model,
	ModelSpec,
	OAuthCredential,
	PhysicalRequest,
	ServiceTier,
	SimpleStreamOptions,
	StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
import { extractCursorAccessTokenUserId } from "@oh-my-pi/pi-ai/oauth/cursor";
import { serviceTierFamily } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type PerfIds, perfSpan, perfWrap } from "@oh-my-pi/pi-utils/perf-trace";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { formatRetryFallbackSelector } from "../session/retry-fallback-chains";
import { parseThinkingLevel, resolveThinkingLevelForModel } from "../thinking";
import type { EngineExecutionConfiguration, EngineExecutionRoute } from "./contracts";
import { resolveCanonicalModelLimits, resolveExecutableModelLimits } from "./model-limits";
import { candidateIdentity } from "./routing-admission";
import { reconcileProviderBilling, withProviderBillingRequest } from "./provider-admission";
import type {
	ProviderAdmissionClient,
	ProviderAdmissionIdentity,
	ProviderApiKeyRouteIdentity,
} from "./provider-admission";
import { ProviderExecutionError } from "./provider-execution";
import type {
	BillingPoolProposal,
	ProviderExecutionClient,
	ProviderExecutionIdentity,
	ProviderExecutionDescriptor,
	ProviderExecutionMaterial,
} from "./provider-execution";

/** Admitted Attempt facts every credential/admission request is bound to (§3, §8.3). */
export type ExecutionAttemptIdentity = Omit<
	ProviderExecutionIdentity,
	| "routeRef"
	| "routeContentHash"
	| "providerAccountRef"
	| "providerAccountContentHash"
	| "credentialGeneration"
	| "providerId"
	| "modelId"
>;

export interface ResolvedEngineExecution {
	options: Pick<
		CreateAgentSessionOptions,
		| "authStorage"
		| "modelRegistry"
		| "model"
		| "providerRequestHook"
		| "managedServiceTier"
		| "thinkingLevel"
		| "toolNames"
		| "restrictToolNames"
		| "enableMCP"
		| "enableLsp"
		| "maxSpawnDepth"
		| "settings"
	>;
	/** Native retry selector per admitted frozen route unit (index-aligned); undefined = unusable here. */
	selectors: Array<string | undefined>;
	/** Recheck current route/credential authorization before a lease transfer or model swap. */
	verifyCandidate(index: number, currentExecutionDigest: string, signal?: AbortSignal): Promise<{
		billing_pool_id: string; billing_pool_basis: "expected" | "observed";
	}>;
	activateCandidate(index: number, executionDigest: string): void | Promise<void>;
	setBillingPoolChanged(callback: (proposal: BillingPoolProposal, signal?: AbortSignal) => Promise<void>): void;
	dispose(): void;
}

type RouteExecution = EngineExecutionRoute["execution"];
type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;
const BROKER_CREDENTIAL_PLACEHOLDER = "gri_pbr_pending";

const LOCAL_OMP_REF = /^clientcred:\/\/localomp\.[a-f0-9]{64}$/;
const CLIENT_CREDENTIAL_REF = /^(?:wincred|clientcred):\/[/]?[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/;
/** Owner-local OMP OAuth providers whose execution Core admits, keyed to Core provider_kind. */
const LOCAL_OAUTH_PROVIDER_KINDS: Record<string, ProviderAdmissionIdentity["providerKind"] | undefined> = {
	"openai-codex": "openai_codex_subscription",
	anthropic: "anthropic_subscription",
	cursor: "cursor_subscription",
};

/**
 * Materializes the admitted frozen route units of a normalized dispatch into one native session.
 * It reads no profile, route or account Artifact: the admitted descriptors are the only source and
 * credentials resolve through ClientHost against the exact admitted Attempt.
 */
export class EngineExecutionResolver {
	constructor(
		readonly credentialRoot: string,
		readonly providerAdmissionClient?: ProviderAdmissionClient,
		readonly providerExecutionClient?: ProviderExecutionClient,
	) {}

	async resolve(
		config: EngineExecutionConfiguration,
		frozen: readonly EngineExecutionRoute[],
		attempt: ExecutionAttemptIdentity,
		cwd: string,
		signal?: AbortSignal,
	): Promise<ResolvedEngineExecution> {
		signal?.throwIfAborted();
		const primary = frozen[0];
		if (!primary) throw new Error("Admitted execution has no selected route");
		const settings = config.continuationConfiguration;
		const spawn = config.dispatch.spawn;
		const maxSpawnDepth = spawn.allowed === "no" ? 0 : spawn.max_depth;
		const localRef = primary.execution.credential.local_ref;
		const local = typeof localRef === "string" && LOCAL_OMP_REF.test(localRef);
		if (local && !this.providerExecutionClient) throw new Error("Owner-local credential proof is unavailable");
		// Every Engine provider request must be admitted and recorded; there is no unobserved fallback.
		if (!this.providerAdmissionClient) throw new Error("Provider quota admission is unavailable");
		const perfIds: PerfIds = { attemptId: attempt.attemptId, agentInstanceRef: attempt.agentInstanceRef };
		const localDescriptor = local ? await perfWrap("engine.resolve.describe", perfIds, { local: true }, () =>
			this.providerExecutionClient!.describe({ ...attempt, ...routeIdentity(primary), modelId: primary.modelId }, signal)) : undefined;
		const localOAuth = localDescriptor?.localOAuth;
		const localProviderKind = LOCAL_OAUTH_PROVIDER_KINDS[primary.provider];
		if (local && (!localOAuth || localDescriptor?.mode !== "owner_local" || !localProviderKind))
			throw new Error("Owner-local OAuth credential binding differs");
		const admission: ProviderAdmissionIdentity | undefined =
			local && primary.execution.account_binding_id && localProviderKind
				? {
						...attempt,
						...routeIdentity(primary),
						providerKind: localProviderKind,
						accountBindingId: primary.execution.account_binding_id,
					}
				: undefined;
		if (admission) admission.executionPin = await perfWrap("engine.resolve.pin", perfIds, undefined, () =>
			this.providerAdmissionClient!.pin(admission, primary.modelId, signal));
		const sessionSettings = await perfWrap("engine.resolve.settings_load", perfIds, undefined, () => Settings.loadReadOnly({
			cwd,
			overrides: {
				disabledProviders: settings.disabledCapabilityProviders,
				"lsp.shared": settings.lspShared,
				"task.maxRecursionDepth": maxSpawnDepth,
				// The SSE transport sends every model request through the observed fetch boundary.
				"providers.openaiWebsockets": "off",
			},
		}));
		const attemptDir = path.join(this.credentialRoot, attempt.attemptId);
		await fs.mkdir(attemptDir, { recursive: true });
		const external = new Map<string, ProviderExecutionBinding>();
		let billingPoolChanged: ((proposal: BillingPoolProposal, signal?: AbortSignal) => Promise<void>) | undefined;
		const client = this.providerExecutionClient;
		const gatedMaterial = async (binding: ProviderExecutionBinding, materialSignal?: AbortSignal) => {
			if (!client) throw new Error("Provider execution material is unavailable");
			try {
				return await client.resolve(binding.identity, materialSignal, binding.executionPin);
			} catch (error) {
				if (!(error instanceof ProviderExecutionError) || !error.billing || !billingPoolChanged) throw error;
				// Current pool gate proposed one same-route transition: record it, then ask once more.
				await reconcileProviderBilling(error.billing, billingPoolChanged, materialSignal);
				return await client.resolve(binding.identity, materialSignal, binding.executionPin);
			}
		};
		const configValueResolver = (value: string, valueSignal?: AbortSignal) =>
			resolveProviderExecutionCredential(value, external, gatedMaterial, valueSignal);
		let authStorage: AuthStorage;
		if (localOAuth) {
			const store = await perfWrap("engine.resolve.credential_store_open", perfIds, undefined, () =>
				SqliteAuthCredentialStore.open(getAgentDbPath(localOAuth.agentDir)));
			const credential = store.listAuthCredentials(primary.provider).find(item =>
				item.credential.type === "oauth" && item.id === localOAuth.credentialId &&
				isClaimedOAuthCredential(primary.provider, item.credential, localOAuth.accountId));
			if (!credential) {
				store.close();
				throw new Error("The exact owned local OMP credential is unavailable");
			}
			authStorage = new AuthStorage(externalCredentialOverlay(exactCredentialStore(store, primary.provider, credential.id)), {
				sourceLabel: "local OMP account",
				configValueResolver,
			});
		} else {
			authStorage = new AuthStorage(
				externalCredentialOverlay(await perfWrap("engine.resolve.credential_store_open", perfIds, undefined, () =>
					SqliteAuthCredentialStore.open(path.join(attemptDir, "credentials.sqlite")))),
				{ configValueResolver },
			);
		}
		await perfWrap("engine.resolve.auth_reload", perfIds, undefined, () => authStorage.reload());
		try {
			const endRegistry = perfSpan("engine.resolve.model_registry", perfIds);
			const modelRegistry = new ModelRegistry(authStorage, path.join(attemptDir, "models.yml"), {
				ignoreLocalModelConfig: true,
				cacheDbPath: path.join(attemptDir, "models.sqlite"),
			});
			endRegistry();
			const apiKeyRoutes: ProviderApiKeyRouteIdentity[] = [];
			const externalProviders = new Map<string, ProviderExecutionBinding>();
			const selectors: Array<string | undefined> = [];
			const candidateBindings: Array<ProviderExecutionBinding | undefined> = [];
			const tierByModel = new Map<string, ServiceTier | undefined>();
			let model: Model | undefined;
			let thinkingLevel: ResolvedThinkingLevel | undefined;
			const endRoutes = perfSpan("engine.resolve.route_models", perfIds);
			for (const [index, route] of frozen.entries()) {
				signal?.throwIfAborted();
				const fallback = config.dispatch.requirement.fallback_mode;
				if (index > 0 && (fallback === "none" ||
					(fallback === "same_model" && route.model_id !== primary.model_id))) {
					selectors.push(undefined);
					continue;
				}
				try {
					const execution = route.execution;
					if (execution.header_refs.length > 0)
						throw new Error("Route header references need ClientHost header material");
					let material: ProviderExecutionDescriptor | undefined;
					let provider = route.provider;
					const externalRoute = index > 0 || !local;
					if (externalRoute) {
						// Frozen fallbacks are models only; no credential/pin before a durable transfer.
						const ref = execution.credential.local_ref ?? execution.credential.hosted_ref;
						if (execution.credential.method !== "api_key" || !ref ||
							(execution.credential.local_ref && !CLIENT_CREDENTIAL_REF.test(execution.credential.local_ref)))
							throw new Error(`Credential method ${execution.credential.method} is unsupported for this route`);
						if (!this.providerExecutionClient) throw new Error("Provider execution material is unavailable");
						const identity = Object.freeze({ ...attempt, ...routeIdentity(route), modelId: route.modelId });
						if (index === 0) material = await perfWrap("engine.resolve.describe", perfIds, { local: false }, () =>
							this.providerExecutionClient!.describe(identity, signal));
						const marker = `clientexec://sha256:${createHash("sha256").update(stableStringifyJson(identity), "utf8").digest("hex")}`;
						const binding: ProviderExecutionBinding = {
							identity, execution,
							...(material ? { transport: executionTransport(material) } : {}),
						};
						external.set(marker, binding);
						candidateBindings[index] = binding;
						provider = `artel-route-${createHash("sha256")
							.update(stableStringifyJson(candidateIdentity(route))).digest("hex").slice(0, 24)}`;
						binding.runtimeProviderId = provider;
						externalProviders.set(provider, binding);
						await authStorage.set(provider, { type: "api_key", key: marker });
					}
					const candidate = buildModel(toModelSpec(route, provider, material)) as Model;
					const family = serviceTierFamily({ ...candidate, provider: route.provider });
					if (route.service_tier !== "standard" &&
						(!family && route.provider !== "fireworks" && candidate.api !== "openai-completions" &&
							candidate.api !== "openai-responses" && candidate.api !== "azure-openai-responses" ||
							route.service_tier === "flex" && (family === "anthropic" || candidate.api === "google-vertex" || route.provider === "fireworks")))
						throw new Error("The admitted service tier is not supported by this provider API");
					tierByModel.set(`${provider}\0${candidate.id}`, route.service_tier === "standard"
						? family === "openai" ? "default" : undefined : route.service_tier);
					if (externalRoute) {
						modelRegistry.registerProvider(candidate.provider, {
							authStorageManaged: true,
							api: candidate.api,
							baseUrl: candidate.baseUrl,
							models: [toProviderModel(candidate)],
						});
						apiKeyRoutes.push({
							...attempt,
							...routeIdentity(route),
							modelId: route.modelId,
							runtimeProviderId: candidate.provider,
							baseUrl: candidate.baseUrl,
						});
					}
					const requested = route.effort === "none" ? "off" : route.effort;
					const level = resolveThinkingLevelForModel(candidate, parseThinkingLevel(requested));
					if (level !== requested)
						throw new Error(`Admitted effort ${route.effort} is not supported by ${candidate.provider}/${candidate.id}`);
					selectors.push(formatRetryFallbackSelector(candidate, level));
					if (index === 0) {
						model = candidate;
						thinkingLevel = level;
					}
				} catch (error) {
					// The selected route must work; an unusable fallback unit is skipped, never replaced.
					if (index === 0 || signal?.aborted) throw error;
					selectors.push(undefined);
				}
			}
			endRoutes();
			const quotaHook = this.providerAdmissionClient.createHook(
				admission, authStorage, primary.execution.base_url, apiKeyRoutes,
				localOAuth ? { accountId: localOAuth.accountId, credentialId: localOAuth.credentialId } : undefined,
				async (proposal, signal) => {
					if (!billingPoolChanged) throw new Error("Billing transition is not bound to the admitted Attempt");
					await billingPoolChanged(proposal, signal);
				},
				{ provider_id: primary.provider, external_id: localOAuth?.accountId ?? null,
					pools: primary.billing_pools, quota_windows: primary.quota_windows },
			);
			// Every physical request rechecks live Engine admission and current Core ACL/credential/pool fences.
			// A changed descriptor refuses before anything is sent.
			const currentMaterial = async (binding: ProviderExecutionBinding, signal?: AbortSignal) => {
				const current = await gatedMaterial(binding, signal);
				if (binding.transport &&
					stableStringifyJson(executionTransport(current)) !== stableStringifyJson(binding.transport))
					throw new ProviderExecutionError("provider_execution_identity_changed",
						"Provider execution transport changed; start a new Attempt");
				if (current.api !== nativeProviderApi(binding.execution.api as Api) ||
					(current.mode === "owner_local" && current.baseUrl !== binding.execution.base_url))
					throw new ProviderExecutionError("provider_execution_identity_changed",
						"Provider execution descriptor changed; start a new Attempt");
				binding.transport ??= executionTransport(current);
				return current;
			};
			const refreshFetch = (runtimeModel: Model, fetch: Fetch): Fetch => async (input, init) => {
				const binding = externalProviders.get(runtimeModel.provider);
				if (!binding) return fetch(input, init);
				const current = await currentMaterial(binding, init?.signal ?? undefined);
				if (binding.transport?.mode !== "hosted_broker") return fetch(input, init);
				const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
				let replaced = false;
				for (const [key, value] of headers) {
					if (!value.includes(BROKER_CREDENTIAL_PLACEHOLDER)) continue;
					headers.set(key, value.replaceAll(BROKER_CREDENTIAL_PLACEHOLDER, current.credential));
					replaced = true;
				}
				if (!replaced)
					throw new ProviderExecutionError("provider_transport_unsupported",
						"Hosted broker request has no replaceable authorization header");
				return fetch(input, { ...init, headers });
			};
			const refreshRequest = async (runtimeModel: Model, request: PhysicalRequest): Promise<number | null> => {
				const binding = externalProviders.get(runtimeModel.provider);
				if (!binding) return await request.send();
				await currentMaterial(binding, request.signal);
				// A non-fetch transport cannot carry the broker's header substitution.
				if (binding.transport?.mode === "hosted_broker")
					throw new ProviderExecutionError("provider_transport_unsupported",
						"Hosted broker routes cannot carry this provider transport");
				return await request.send();
			};
			return {
				options: {
					settings: sessionSettings,
					authStorage,
					modelRegistry,
					model,
					managedServiceTier: runtimeModel => {
						const key = `${runtimeModel.provider}\0${runtimeModel.id}`;
						if (!tierByModel.has(key)) throw new Error("Model tier is outside the admitted frozen routes");
						return tierByModel.get(key);
					},
					providerRequestHook: {
						wrapFetch: (runtimeModel, fetch) => {
							const wrapped = quotaHook.wrapFetch(runtimeModel, refreshFetch(runtimeModel, fetch));
							return (input, init) => withProviderBillingRequest(() => wrapped(input, init));
						},
						wrapRequest: (runtimeModel, request) => withProviderBillingRequest(() =>
							quotaHook.wrapRequest(runtimeModel, { ...request, send: () => refreshRequest(runtimeModel, request) })),
					},
					thinkingLevel,
					toolNames: settings.restrictToolNames ? settings.toolNames : undefined,
					restrictToolNames: settings.restrictToolNames,
					enableMCP: settings.enableMCP,
					enableLsp: settings.enableLsp,
					maxSpawnDepth,
				},
				selectors,
				verifyCandidate: async (index, currentExecutionDigest, signal) => {
					const binding = candidateBindings[index];
					const candidate = frozen[index];
					if (!binding || !candidate || !this.providerExecutionClient)
						throw new Error("Admitted fallback candidate is unavailable");
					return await this.providerExecutionClient.checkCandidate(
						{ ...binding.identity, executionDigest: currentExecutionDigest },
						{
							route_ref: candidate.route_ref, account_ref: candidate.account_ref,
							effort: candidate.effort, service_tier: candidate.service_tier,
						}, signal,
					);
				},
				activateCandidate: async (index, executionDigest) => {
					if (index === 0 && admission) admission.executionDigest = executionDigest;
					const binding = candidateBindings[index];
					if (binding) {
						binding.identity = { ...binding.identity, executionDigest };
						const observation = apiKeyRoutes.find(route =>
							route.runtimeProviderId === binding.runtimeProviderId);
						if (observation) observation.executionDigest = executionDigest;
						if (!binding.transport) {
							// The durable lease transfer precedes descriptor/credential access.
							const descriptor = await this.providerExecutionClient!.describe(binding.identity);
							if (descriptor.api !== nativeProviderApi(binding.execution.api as Api) ||
								(descriptor.mode === "owner_local" && descriptor.baseUrl !== binding.execution.base_url))
								throw new ProviderExecutionError("provider_execution_identity_changed", "Admitted fallback descriptor differs");
							binding.transport = executionTransport(descriptor);
							const candidate = buildModel(toModelSpec(frozen[index], binding.runtimeProviderId!, descriptor)) as Model;
							modelRegistry.registerProvider(candidate.provider, {
								authStorageManaged: true, api: candidate.api, baseUrl: candidate.baseUrl,
								models: [toProviderModel(candidate)],
							});
							if (observation) observation.baseUrl = candidate.baseUrl;
						}
					} else if (index !== 0) throw new Error("Admitted fallback candidate is unavailable");
				},
				setBillingPoolChanged: callback => { billingPoolChanged = callback; },
				dispose: () => authStorage.close(),
			};
		} catch (error) {
			authStorage.close();
			throw error;
		}
	}
}

function routeIdentity(route: EngineExecutionRoute) {
	return {
		routeRef: route.route_ref,
		routeContentHash: route.execution.route_content_hash,
		providerAccountRef: route.account_ref,
		providerAccountContentHash: route.execution.account_content_hash,
		credentialGeneration: route.execution.credential.generation,
		providerId: route.provider_id,
	};
}

function toModelSpec(route: EngineExecutionRoute, provider: string, material?: Pick<ProviderExecutionDescriptor, "api" | "baseUrl">): ModelSpec<Api> {
	const execution: RouteExecution = route.execution;
	const api = material?.api ?? nativeProviderApi(execution.api as Api);
	const reference = resolveCanonicalModelLimits(route.modelId);
	const { disable_strict_tools: disableStrictTools, ...compat } = execution.compat ?? {};
	const { contextWindow, maxOutputTokens } = resolveExecutableModelLimits({
		modelIdentityId: route.modelId,
		contextWindow: execution.context_window ?? undefined,
		maxOutputTokens: execution.max_output_tokens ?? undefined,
	});
	return {
		id: route.modelId,
		requestModelId: execution.provider_model_id,
		name: execution.display_name,
		api,
		provider,
		baseUrl: material?.baseUrl ?? execution.base_url,
		reasoning: execution.supports_reasoning,
		// Match the exact catalog scale exposed by ClientHost instead of the
		// generic OpenAI ladder. A rejecting gateway must fail, not lower Max.
		...(api === "openai-completions" && execution.supports_reasoning && reference?.referenceProvider === "anthropic"
			? { thinking: { mode: "effort" as const, efforts: reference.reasoningEfforts } }
			: {}),
		compat: {
			...(reference?.referenceProvider === "openai" && reference.reasoningOffApis.includes(api)
				? { reasoningDisableMode: "none-effort" as const }
				: {}),
			...compat,
			...(disableStrictTools === undefined ? {} : { disableStrictTools }),
		},
		supportsTools: execution.supports_tools,
		input: execution.input_modalities.length ? execution.input_modalities : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: maxOutputTokens,
	};
}

async function resolveProviderExecutionCredential(
	value: string,
	identities: ReadonlyMap<string, ProviderExecutionBinding>,
	gatedMaterial: (binding: ProviderExecutionBinding, signal?: AbortSignal) => Promise<ProviderExecutionMaterial>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const binding = identities.get(value);
	if (!binding) return process.env[value] || value;
	if (binding.transport?.mode === "hosted_broker") return BROKER_CREDENTIAL_PLACEHOLDER;
	const material = await gatedMaterial(binding, signal);
	if (binding.transport && stableStringifyJson(executionTransport(material)) !== stableStringifyJson(binding.transport))
		throw new Error("Provider execution transport changed; start a new Attempt");
	if (material.api !== nativeProviderApi(binding.execution.api as Api) ||
		(material.mode === "owner_local" && material.baseUrl !== binding.execution.base_url))
		throw new Error("Provider execution descriptor changed; start a new Attempt");
	binding.transport ??= executionTransport(material);
	return binding.transport.mode === "hosted_broker" ? BROKER_CREDENTIAL_PLACEHOLDER : material.credential;
}

interface ProviderExecutionBinding {
	identity: ProviderExecutionIdentity;
	transport?: ProviderExecutionDescriptor;
	execution: RouteExecution;
	runtimeProviderId?: string;
	executionPin?: string;
}

function executionTransport(
	material: ProviderExecutionDescriptor,
): ProviderExecutionDescriptor {
	return {
		mode: material.mode,
		providerRuntimeId: material.providerRuntimeId,
		api: material.api,
		baseUrl: material.baseUrl,
	};
}

function nativeProviderApi(api: Api): Api {
	if (api === "openai_chat_completions") return "openai-completions";
	if (api === "anthropic_messages") return "anthropic-messages";
	return api;
}

function toProviderModel(
	model: Model,
): NonNullable<Parameters<ModelRegistry["registerProvider"]>[1]["models"]>[number] {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinking: model.thinking,
		input: model.input,
		supportsTools: model.supportsTools,
		cost: model.cost,
		contextWindow: Number(model.contextWindow),
		maxTokens: Number(model.maxTokens),
		headers: model.headers,
	};
}

/**
 * Whether a stored local OMP OAuth row is the claimed account. A row records its account id;
 * a Cursor row minted before logins recorded one is proven by its own access token's user id,
 * the same identity the login now records, so an existing owner login keeps working.
 */
export function isClaimedOAuthCredential(provider: string, credential: OAuthCredential, accountId: string): boolean {
	if (credential.accountId !== undefined) return credential.accountId === accountId;
	return provider === "cursor" && extractCursorAccessTokenUserId(credential.access) === accountId;
}

export function exactCredentialStore(store: AuthCredentialStore, provider: string, credentialId: number): AuthCredentialStore {
	return new Proxy(store, {
		get(target, property) {
			if (property === "listAuthCredentials") {
				return (requestedProvider?: string) => {
					if (requestedProvider !== undefined && requestedProvider !== provider) return [];
					return target.listAuthCredentials(provider).filter(item => item.id === credentialId);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function externalCredentialOverlay(store: AuthCredentialStore): AuthCredentialStore {
	const rows = new Map<string, StoredAuthCredential[]>();
	let nextId = 1_500_000_000;
	const isExternal = (credential: AuthCredential): boolean =>
		credential.type === "api_key" && credential.key.startsWith("clientexec://sha256:");
	const allRows = (provider?: string): StoredAuthCredential[] => {
		const base = store.listAuthCredentials(provider);
		const extra = provider ? (rows.get(provider) ?? []) : [...rows.values()].flat();
		return [...base, ...extra];
	};
	return new Proxy(store, {
		get(target, property) {
			if (property === "listAuthCredentials") return allRows;
			if (property === "replaceAuthCredentialsForProvider") {
				return (provider: string, credentials: AuthCredential[]) => {
					if (!credentials.every(isExternal))
						return target.replaceAuthCredentialsForProvider(provider, credentials);
					const replacement = credentials.map(credential => ({
						id: nextId++,
						provider,
						credential,
						disabledCause: null,
					}));
					rows.set(provider, replacement);
					return replacement;
				};
			}
			if (property === "upsertAuthCredentialForProvider") {
				return (provider: string, credential: AuthCredential) => {
					if (!isExternal(credential)) return target.upsertAuthCredentialForProvider(provider, credential);
					const existing = rows.get(provider) ?? [];
					const replacement = [
						{
							id: existing[0]?.id ?? nextId++,
							provider,
							credential,
							disabledCause: null,
						},
					];
					rows.set(provider, replacement);
					return replacement;
				};
			}
			if (property === "deleteAuthCredentialsForProvider") {
				return (provider: string, cause: string) => {
					if (rows.delete(provider)) return;
					return target.deleteAuthCredentialsForProvider(provider, cause);
				};
			}
			if (property === "updateAuthCredential") {
				return (id: number, credential: AuthCredential) => {
					for (const [provider, entries] of rows) {
						const index = entries.findIndex(entry => entry.id === id);
						if (index >= 0) {
							if (!isExternal(credential)) throw new Error("External credential cannot become persistent");
							entries[index] = { id, provider, credential, disabledCause: null };
							return;
						}
					}
					return target.updateAuthCredential(id, credential);
				};
			}
			if (property === "deleteAuthCredential") {
				return (id: number, cause: string) => {
					for (const [provider, entries] of rows) {
						if (entries.some(entry => entry.id === id)) {
							rows.set(
								provider,
								entries.filter(entry => entry.id !== id),
							);
							return;
						}
					}
					return target.deleteAuthCredential(id, cause);
				};
			}
			if (property === "tryDisableAuthCredentialIfMatches") {
				return (id: number, expected: string, cause: string, lease?: { owner: string; nowMs: number }) => {
					for (const [provider, entries] of rows) {
						const entry = entries.find(item => item.id === id);
						if (entry) {
							if (stableStringifyJson(entry.credential) !== expected) return false;
							rows.set(
								provider,
								entries.filter(item => item.id !== id),
							);
							return true;
						}
					}
					return target.tryDisableAuthCredentialIfMatches(id, expected, cause, lease);
				};
			}
			if (property === "close")
				return () => {
					rows.clear();
					target.close();
				};
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
