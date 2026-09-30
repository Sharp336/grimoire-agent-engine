import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, AuthCredential, AuthCredentialStore, Model, ModelSpec, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { formatRetryFallbackSelector } from "../session/retry-fallback-chains";
import { resolveThinkingLevelForModel } from "../thinking";
import type { EngineExecutionConfiguration, EngineExecutionRoute } from "./contracts";
import { resolveCanonicalModelLimits, resolveExecutableModelLimits } from "./model-limits";
import type {
	ProviderAdmissionClient,
	ProviderAdmissionIdentity,
	ProviderApiKeyRouteIdentity,
} from "./provider-admission";
import type {
	ProviderExecutionClient,
	ProviderExecutionIdentity,
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
	dispose(): void;
}

type RouteExecution = EngineExecutionRoute["execution"];

const LOCAL_OMP_REF = /^localomp:\/([A-Za-z0-9][A-Za-z0-9._~@-]{0,254})(?:#([1-9][0-9]{0,15}))?$/;
const CLIENT_CREDENTIAL_REF = /^(?:wincred|clientcred):\/[/]?[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/;

/**
 * Materializes the admitted frozen route units of a normalized dispatch into one native session.
 * It reads no profile, route or account Artifact: the admitted descriptors are the only source and
 * credentials resolve through ClientHost against the exact admitted Attempt.
 */
export class EngineExecutionResolver {
	constructor(
		readonly credentialRoot: string,
		readonly localCredentialDbPath: string = getAgentDbPath(),
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
		const local = primary.execution.credential.local_ref?.match(LOCAL_OMP_REF);
		const admission: ProviderAdmissionIdentity | undefined =
			local && primary.execution.account_binding_id
				? {
						...attempt,
						...routeIdentity(primary),
						providerKind: "openai_codex_subscription",
						accountBindingId: primary.execution.account_binding_id,
					}
				: undefined;
		if (admission) {
			if (!this.providerAdmissionClient) throw new Error("Provider quota admission is unavailable");
			if (local?.[1] !== admission.accountBindingId)
				throw new Error("ProviderAccount quota identity does not match its local credential binding");
			admission.executionPin = await this.providerAdmissionClient.pin(admission, primary.modelId, signal);
		}
		const sessionSettings = await Settings.loadReadOnly({
			cwd,
			overrides: {
				disabledProviders: settings.disabledCapabilityProviders,
				"lsp.shared": settings.lspShared,
				"task.maxRecursionDepth": maxSpawnDepth,
				...(admission ? { "providers.openaiWebsockets": "off" } : {}),
			},
		});
		const attemptDir = path.join(this.credentialRoot, attempt.attemptId);
		await fs.mkdir(attemptDir, { recursive: true });
		const external = new Map<string, ProviderExecutionBinding>();
		const configValueResolver = (value: string, valueSignal?: AbortSignal) =>
			resolveProviderExecutionCredential(value, external, this.providerExecutionClient, valueSignal);
		let authStorage: AuthStorage;
		if (local) {
			const store = await SqliteAuthCredentialStore.open(this.localCredentialDbPath);
			const credential = store
				.listAuthCredentials(primary.provider)
				.find(
					item =>
						item.credential.type === "oauth" &&
						item.credential.accountId === local[1] &&
						(local[2] === undefined || item.id === Number(local[2])),
				);
			if (!credential) {
				store.close();
				throw new Error("The local OMP account bound to ProviderAccount is unavailable");
			}
			authStorage = new AuthStorage(externalCredentialOverlay(exactCredentialStore(store, primary.provider, credential.id)), {
				sourceLabel: "local OMP account",
				configValueResolver,
			});
		} else {
			authStorage = new AuthStorage(
				externalCredentialOverlay(await SqliteAuthCredentialStore.open(path.join(attemptDir, "credentials.sqlite"))),
				{ configValueResolver },
			);
		}
		await authStorage.reload();
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(attemptDir, "models.yml"), {
				ignoreLocalModelConfig: true,
				cacheDbPath: path.join(attemptDir, "models.sqlite"),
			});
			const apiKeyRoutes: ProviderApiKeyRouteIdentity[] = [];
			const selectors: Array<string | undefined> = [];
			let model: Model | undefined;
			let thinkingLevel: ResolvedThinkingLevel | undefined;
			for (const [index, route] of frozen.entries()) {
				signal?.throwIfAborted();
				try {
					const execution = route.execution;
					if (execution.header_refs.length > 0)
						throw new Error("Route header references need ClientHost header material");
					let material: ProviderExecutionMaterial | undefined;
					let provider = route.provider;
					if (index > 0 || !local) {
						// Secrets never enter the roster; ClientHost resolves the exact admitted route credential.
						const ref = execution.credential.local_ref ?? execution.credential.hosted_ref;
						if (
							execution.credential.method !== "api_key" ||
							__omp_shell("ref ||")
							(execution.credential.local_ref && !CLIENT_CREDENTIAL_REF.test(execution.credential.local_ref))
						)
							throw new Error(`Credential method ${execution.credential.method} is unsupported for this route`);
						if (!this.providerExecutionClient) throw new Error("Provider execution material is unavailable");
						const identity = Object.freeze({ ...attempt, ...routeIdentity(route), modelId: route.modelId });
						material = await this.providerExecutionClient.resolve(identity, signal);
						const marker = `clientexec://sha256:${createHash("sha256").update(stableStringifyJson(identity), "utf8").digest("hex")}`;
						external.set(marker, {
							identity,
							transport: executionTransport(material),
							executionPin: material.executionPin,
						});
						provider = `artel-route-${route.route_ref.slice(5)}`;
						await authStorage.set(provider, { type: "api_key", key: marker });
					}
					const candidate = buildModel(toModelSpec(route, provider, material)) as Model;
					if (material) {
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
					const level = resolveThinkingLevelForModel(candidate, requested);
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
			return {
				options: {
					settings: sessionSettings,
					authStorage,
					modelRegistry,
					model,
					providerRequestHook:
						this.providerAdmissionClient && (admission || apiKeyRoutes.length > 0)
							? this.providerAdmissionClient.createHook(
									admission,
									authStorage,
									primary.execution.base_url,
									apiKeyRoutes,
								)
							: undefined,
					thinkingLevel,
					toolNames: settings.restrictToolNames ? settings.toolNames : undefined,
					restrictToolNames: settings.restrictToolNames,
					enableMCP: settings.enableMCP,
					enableLsp: settings.enableLsp,
					maxSpawnDepth,
				},
				selectors,
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

function toModelSpec(route: EngineExecutionRoute, provider: string, material?: ProviderExecutionMaterial): ModelSpec<Api> {
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
	client: ProviderExecutionClient | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const binding = identities.get(value);
	if (!binding) return process.env[value] || value;
	if (!client) throw new Error("Provider execution material is unavailable");
	const material = await client.resolve(binding.identity, signal, binding.executionPin);
	if (stableStringifyJson(executionTransport(material)) !== stableStringifyJson(binding.transport)) {
		throw new Error("Provider execution transport changed; start a new Attempt with the refreshed route roster");
	}
	return material.credential;
}

interface ProviderExecutionBinding {
	identity: ProviderExecutionIdentity;
	transport: Omit<ProviderExecutionMaterial, "credential" | "executionPin">;
	executionPin?: string;
}

function executionTransport(
	material: ProviderExecutionMaterial,
): Omit<ProviderExecutionMaterial, "credential" | "executionPin"> {
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

function exactCredentialStore(store: AuthCredentialStore, provider: string, credentialId: number): AuthCredentialStore {
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
