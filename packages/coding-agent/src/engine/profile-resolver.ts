import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, AuthCredential, AuthCredentialStore, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { SETTINGS_SCHEMA, type SettingPath, Settings } from "../config/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import type { TurnRetryPolicy } from "../session/agent-session-types";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import type { EngineChildProfile } from "../tools";
import type { EngineLaunchProfile } from "./contracts";
import { resolveExecutableModelLimits } from "./model-limits";
import type { ProviderAdmissionClient, ProviderApiKeyRouteIdentity } from "./provider-admission";

const GCTX = /^gctx:[23456789abcdefghjkmnpqrstuvwxyz]{16}$/;

interface CachedArtifact {
	schema: "grimoire.client_cached_artifact.v1";
	artifact_ref: string;
	revision: number;
	content_hash: string;
	kind: string;
	content: string;
}

interface AgentProfile {
	schema: "grimoire.agent_profile.v1";
	displayName?: string;
	description?: string;
	status?: "active" | "disabled";
	models: string[];
	allowSameModelProviderFallback?: boolean;
	requireTrustedProvider?: boolean;
	autoSelectionEnabled?: boolean;
	tools?: { mode?: "unrestricted" | "allowlist"; names?: string[] };
	generationDefaults?: { thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"] };
	childProfiles?: string[];
	maxSpawnDepth?: number;
	maxChildren?: number;
}

interface AvailableModelRoute {
	schema: "grimoire.available_model_route.v1";
	status?: "active" | "disabled";
	displayName?: string;
	providerAccountRef: string;
	model: {
		modelIdentityId: string;
		providerSurfaceId: string;
		modelId: string;
		requestModelId?: string;
		name?: string;
		contextWindow?: number;
		maxOutputTokens?: number;
		inputModalities?: string[];
		supportsTools?: boolean;
		supportsReasoning?: boolean;
	};
}

interface ProviderAccount {
	schema: "grimoire.provider_account.v1";
	status?: "active" | "disabled";
	providerId: string;
	providerKind?: string;
	accountBindingId?: string;
	api: Api;
	baseUrl: string;
	headers?: Record<string, string>;
	trusted: boolean;
	credential?: AuthCredential;
	credentialBinding?: { source: "local_omp"; accountId: string; credentialId?: number };
}

export interface ResolvedEngineSessionProfile {
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
	childProfiles: EngineChildProfile[];
	sameModelRouteFallback?: NonNullable<TurnRetryPolicy["sameModelRouteFallback"]>;
	dispose(): void;
}

export class EngineProfileResolver {
	constructor(
		readonly artifactCacheRoot: string,
		readonly credentialRoot: string,
		readonly localCredentialDbPath: string = getAgentDbPath(),
		readonly providerAdmissionClient?: ProviderAdmissionClient,
	) {}

	async continuationDigest(launch: EngineLaunchProfile, cwd: string): Promise<string> {
		const profileRef = requiredRef(launch.launchProfileRef, "launchProfileRef");
		const cachedProfile = await this.#read(profileRef, "grimoire.agent_profile.v1");
		if (cachedProfile.content_hash !== launch.profileDigest) {
			throw new Error("AgentProfile digest does not match the cached Artifact");
		}
		const profile = parseJson<AgentProfile>(cachedProfile.content, "AgentProfile");
		if (profile.schema !== "grimoire.agent_profile.v1" || profile.status === "disabled" || !profile.models?.length) {
			throw new Error("AgentProfile must contain at least one route");
		}
		const spawnPolicy = resolveSpawnPolicy(profile, launch);
		const settings = await Settings.loadReadOnly({
			cwd,
			overrides: {
				disabledProviders: launch.disabledCapabilityProviders ?? [],
				"lsp.shared": launch.lspShared ?? false,
				"task.maxRecursionDepth": spawnPolicy.maxSpawnDepth,
			},
		});
		const routes: Record<string, unknown>[] = [];
		for (const routeRef of await this.#routeCandidates(profile, launch.selectedRouteRef)) {
			try {
				const cachedRoute = await this.#read(routeRef, "grimoire.available_model_route.v1");
				const route = parseJson<AvailableModelRoute>(cachedRoute.content, "AvailableModelRoute");
				const accountRef = requiredRef(route.providerAccountRef, "providerAccountRef");
				const cachedAccount = await this.#read(accountRef, "grimoire.provider_account.v1");
				routes.push({
					ref: routeRef,
					contentHash: cachedRoute.content_hash,
					accountRef,
					accountContentHash: cachedAccount.content_hash,
				});
			} catch {
				routes.push({ ref: routeRef, unavailable: true });
			}
		}
		const childProfiles = [];
		for (const ref of spawnPolicy.childProfileRefs) {
			const cached = await this.#read(ref, "grimoire.agent_profile.v1");
			childProfiles.push({ ref, contentHash: cached.content_hash });
		}
		return digestJson({
			profileRef,
			profileContentHash: cachedProfile.content_hash,
			routes,
			childProfiles,
			settings: Object.fromEntries(
				(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(key => [key, settings.get(key)]),
			),
		});
	}

	async resolve(launch: EngineLaunchProfile, cwd: string): Promise<ResolvedEngineSessionProfile> {
		const profileRef = requiredRef(launch.launchProfileRef, "launchProfileRef");
		const cachedProfile = await this.#read(profileRef, "grimoire.agent_profile.v1");
		if (cachedProfile.content_hash !== launch.profileDigest) {
			throw new Error("AgentProfile digest does not match the cached Artifact");
		}
		const profile = parseJson<AgentProfile>(cachedProfile.content, "AgentProfile");
		if (
			profile.schema !== "grimoire.agent_profile.v1" ||
			profile.status === "disabled" ||
			!Array.isArray(profile.models) ||
			!profile.models.length
		) {
			throw new Error("AgentProfile must contain at least one route");
		}
		const spawnPolicy = resolveSpawnPolicy(profile, launch);
		const candidates = await this.#routeCandidates(profile, launch.selectedRouteRef);
		const childProfiles = await this.#childProfiles(spawnPolicy.childProfileRefs);
		let sameModelIdentityId: string | undefined;
		if (profile.allowSameModelProviderFallback) {
			for (const routeRef of candidates) {
				try {
					const route = parseJson<AvailableModelRoute>(
						(await this.#read(routeRef, "grimoire.available_model_route.v1")).content,
						"AvailableModelRoute",
					);
					if (route.status !== "disabled" && route.model?.modelIdentityId) {
						sameModelIdentityId = route.model.modelIdentityId;
						break;
					}
				} catch {}
			}
			if (!sameModelIdentityId) throw new Error("AgentProfile has no usable same-model identity");
		}
		let lastError: unknown;
		for (const [index, routeRef] of candidates.entries()) {
			try {
				if (sameModelIdentityId) {
					const route = parseJson<AvailableModelRoute>(
						(await this.#read(routeRef, "grimoire.available_model_route.v1")).content,
						"AvailableModelRoute",
					);
					if (route.model.modelIdentityId !== sameModelIdentityId) continue;
				}
				return await this.#resolveRoute(
					profile,
					routeRef,
					launch,
					childProfiles,
					cwd,
					spawnPolicy.maxSpawnDepth,
					profile.allowSameModelProviderFallback ? candidates.slice(index + 1) : [],
				);
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error("No usable AvailableModelRoute in AgentProfile", { cause: lastError });
	}

	async #routeCandidates(profile: AgentProfile, selected?: string): Promise<string[]> {
		const configured = profile.models.map((ref, index) => requiredRef(ref, `models[${index}]`));
		if (selected) {
			const selectedRef = requiredRef(selected, "selectedRouteRef");
			if (!configured.includes(selectedRef)) throw new Error("selectedRouteRef is outside AgentProfile");
			configured.splice(configured.indexOf(selectedRef), 1);
			configured.unshift(selectedRef);
		}
		return configured;
	}

	async #resolveRoute(
		profile: AgentProfile,
		routeRef: string,
		launch: EngineLaunchProfile,
		childProfiles: EngineChildProfile[],
		cwd: string,
		maxSpawnDepth: number,
		fallbackRouteRefs: string[],
	): Promise<ResolvedEngineSessionProfile> {
		const route = parseJson<AvailableModelRoute>(
			(await this.#read(routeRef, "grimoire.available_model_route.v1")).content,
			"AvailableModelRoute",
		);
		if (
			route.schema !== "grimoire.available_model_route.v1" ||
			route.status === "disabled" ||
			!route.model?.modelId ||
			!route.model.modelIdentityId
		) {
			throw new Error("AvailableModelRoute has no valid model");
		}
		const accountRef = requiredRef(route.providerAccountRef, "providerAccountRef");
		const cachedAccount = await this.#read(accountRef, "grimoire.provider_account.v1");
		const account = parseJson<ProviderAccount>(cachedAccount.content, "ProviderAccount");
		const embeddedCredential = validCredential(account.credential) ? account.credential : undefined;
		const localBinding = validLocalCredentialBinding(account.credentialBinding)
			? account.credentialBinding
			: undefined;
		if (
			account.schema !== "grimoire.provider_account.v1" ||
			account.status === "disabled" ||
			!account.providerId ||
			!account.api ||
			!account.baseUrl ||
			(!embeddedCredential && !localBinding)
		) {
			throw new Error("ProviderAccount does not match AvailableModelRoute");
		}
		if (profile.requireTrustedProvider && account.trusted !== true) {
			throw new Error("AgentProfile requires a trusted provider");
		}
		const admissionIdentity =
			account.providerKind === "openai_codex_subscription"
				? {
						providerAccountRef: accountRef,
						routeRef,
						providerKind: "openai_codex_subscription" as const,
						providerId: account.providerId,
						accountBindingId: requiredText(account.accountBindingId, "ProviderAccount accountBindingId"),
					}
				: undefined;
		if (admissionIdentity && (!localBinding || localBinding.accountId !== admissionIdentity.accountBindingId)) {
			throw new Error("ProviderAccount quota identity does not match its local credential binding");
		}
		if (admissionIdentity && !this.providerAdmissionClient) {
			throw new Error("Provider quota admission is unavailable");
		}
		const settings = await Settings.loadReadOnly({
			cwd,
			overrides: {
				disabledProviders: launch.disabledCapabilityProviders ?? [],
				"lsp.shared": launch.lspShared ?? false,
				"task.maxRecursionDepth": maxSpawnDepth,
				...(admissionIdentity ? { "providers.openaiWebsockets": "off" } : {}),
			},
		});
		const accountDir = path.join(this.credentialRoot, accountRef.slice(5));
		await fs.mkdir(accountDir, { recursive: true });
		let authStorage: AuthStorage;
		if (localBinding) {
			const store = await SqliteAuthCredentialStore.open(this.localCredentialDbPath);
			const credential = store
				.listAuthCredentials(account.providerId)
				.find(
					item =>
						item.credential.type === "oauth" &&
						item.credential.accountId === localBinding.accountId &&
						(localBinding.credentialId === undefined || item.id === localBinding.credentialId),
				);
			if (!credential) {
				store.close();
				throw new Error("The local OMP account bound to ProviderAccount is unavailable");
			}
			authStorage = new AuthStorage(exactCredentialStore(store, account.providerId, credential.id), {
				sourceLabel: "local OMP account",
			});
			await authStorage.reload();
		} else {
			authStorage = await AuthStorage.create(path.join(accountDir, "credentials.sqlite"));
		}
		try {
			let unsubscribeWriteback = () => {};
			if (embeddedCredential) {
				const sourcePath = path.join(accountDir, "source.json");
				const source = await readJson(sourcePath);
				if (source?.contentHash !== cachedAccount.content_hash) {
					await authStorage.set(account.providerId, embeddedCredential);
					await atomicWriteJson(sourcePath, { contentHash: cachedAccount.content_hash });
				} else await authStorage.reload();
				const writebackRoot = path.resolve(this.artifactCacheRoot, "..", "credential-writeback");
				await fs.mkdir(writebackRoot, { recursive: true });
				const baseCredentialHash = credentialHash(embeddedCredential);
				const writebackPath = path.join(writebackRoot, `${accountRef.slice(5)}.json`);
				const writeback = async () => {
					const credentials = authStorage.listStoredCredentials(account.providerId);
					if (credentials.length !== 1) return;
					const credential = credentials[0]?.credential;
					if (!credential) return;
					if (credentialHash(credential) === baseCredentialHash) {
						await fs.rm(writebackPath, { force: true });
						return;
					}
					await atomicWriteJson(writebackPath, {
						schema: "grimoire.engine_credential_writeback.v1",
						artifactRef: accountRef,
						baseRevision: cachedAccount.revision,
						baseContentHash: cachedAccount.content_hash,
						baseCredentialHash,
						credential,
						updatedAt: new Date().toISOString(),
					});
				};
				unsubscribeWriteback = authStorage.onGenerationChanged(() => void writeback().catch(() => {}));
				await writeback();
			}
			const modelRegistry = new ModelRegistry(authStorage, path.join(accountDir, "models.yml"), {
				ignoreLocalModelConfig: true,
				cacheDbPath: path.join(accountDir, "models.sqlite"),
			});
			const model = buildModel(toModelSpec(route, account)) as Model;
			const fallbackSelectors = [formatModelStringWithRouting(model)];
			const fallbackApiKeyRoutes: ProviderApiKeyRouteIdentity[] = [];
			const fallbackWritebacks: Array<() => void> = [];
			if (profile.allowSameModelProviderFallback && (embeddedCredential || localBinding)) {
				for (const fallbackRouteRef of fallbackRouteRefs) {
					try {
						const fallbackRoute = parseJson<AvailableModelRoute>(
							(await this.#read(fallbackRouteRef, "grimoire.available_model_route.v1")).content,
							"AvailableModelRoute",
						);
						if (
							fallbackRoute.status === "disabled" ||
							fallbackRoute.model.modelIdentityId !== route.model.modelIdentityId
						) {
							continue;
						}
						const fallbackAccountRef = requiredRef(fallbackRoute.providerAccountRef, "providerAccountRef");
						const fallbackCachedAccount = await this.#read(fallbackAccountRef, "grimoire.provider_account.v1");
						const fallbackAccount = parseJson<ProviderAccount>(fallbackCachedAccount.content, "ProviderAccount");
						const fallbackCredential = validCredential(fallbackAccount.credential)
							? fallbackAccount.credential
							: undefined;
						if (
							fallbackAccount.status === "disabled" ||
							fallbackCredential?.type !== "api_key" ||
							fallbackAccount.providerKind === "openai_codex_subscription" ||
							!fallbackAccount.providerId ||
							!fallbackAccount.api ||
							!fallbackAccount.baseUrl ||
							(profile.requireTrustedProvider && fallbackAccount.trusted !== true) ||
							fallbackAccount.providerId === account.providerId
						) {
							continue;
						}
						if (!localBinding) await authStorage.set(fallbackAccount.providerId, fallbackCredential);
						const fallbackModel = buildModel(toModelSpec(fallbackRoute, fallbackAccount)) as Model;
						modelRegistry.registerProvider(fallbackAccount.providerId, {
							apiKey: fallbackCredential.key,
							api: fallbackAccount.api,
							baseUrl: fallbackAccount.baseUrl,
							headers: fallbackAccount.headers,
							models: [toProviderModel(fallbackModel)],
						});
						fallbackApiKeyRoutes.push({
							providerAccountRef: fallbackAccountRef,
							routeRef: fallbackRouteRef,
							providerId: fallbackModel.provider,
							modelId: fallbackModel.id,
							baseUrl: fallbackModel.baseUrl,
						});
						const selector = formatModelStringWithRouting(fallbackModel);
						if (!fallbackSelectors.includes(selector)) fallbackSelectors.push(selector);
						if (!localBinding)
							fallbackWritebacks.push(
								authStorage.onGenerationChanged(
									() =>
										void this.#writeCredentialBack(
											authStorage,
											fallbackAccount.providerId,
											fallbackAccountRef,
											fallbackCachedAccount,
											fallbackCredential,
										).catch(() => {}),
								),
							);
					} catch {
						// Unavailable routes are omitted once; the runtime chain never cycles back to them.
					}
				}
			}
			const profileRestricted = profile.tools?.mode === "allowlist";
			const launchRestricted = launch.restrictToolNames === true;
			const profileNames = uniqueStrings(profile.tools?.names ?? []);
			const launchNames = uniqueStrings(launch.toolNames ?? []);
			const toolNames =
				profileRestricted && launchRestricted
					? profileNames.filter(name => launchNames.includes(name))
					: profileRestricted
						? profileNames
						: launchRestricted
							? launchNames
							: undefined;
			return {
				options: {
					settings,
					authStorage,
					modelRegistry,
					model,
					providerRequestHook:
						admissionIdentity && this.providerAdmissionClient
							? this.providerAdmissionClient.createHook(
									admissionIdentity,
									authStorage,
									account.baseUrl,
									fallbackApiKeyRoutes,
								)
							: undefined,
					thinkingLevel: profile.generationDefaults?.thinkingLevel,
					toolNames,
					restrictToolNames: profileRestricted || launchRestricted,
					enableMCP: launch.enableMCP ?? true,
					enableLsp: launch.enableLsp ?? true,
					maxSpawnDepth,
				},
				childProfiles,
				...(profile.allowSameModelProviderFallback
					? {
							sameModelRouteFallback: {
								modelIdentityId: route.model.modelIdentityId,
								selectors: fallbackSelectors,
							},
						}
					: {}),
				dispose: () => {
					unsubscribeWriteback();
					for (const unsubscribe of fallbackWritebacks) unsubscribe();
					authStorage.close();
				},
			};
		} catch (error) {
			authStorage.close();
			throw error;
		}
	}

	async #childProfiles(refs: string[]): Promise<EngineChildProfile[]> {
		const profiles: EngineChildProfile[] = [];
		for (const [index, profileRef] of refs.entries()) {
			const cached = await this.#read(
				requiredRef(profileRef, `childProfiles[${index}]`),
				"grimoire.agent_profile.v1",
			);
			const profile = parseJson<AgentProfile>(cached.content, "AgentProfile");
			if (
				profile.schema !== "grimoire.agent_profile.v1" ||
				profile.status === "disabled" ||
				!Array.isArray(profile.models) ||
				!profile.models.length
			) {
				throw new Error(`Child AgentProfile is unavailable: ${profileRef}`);
			}
			profiles.push({
				profileRef,
				displayName: profile.displayName?.trim() || profileRef,
				...(profile.description?.trim() ? { description: profile.description.trim() } : {}),
			});
		}
		return profiles;
	}

	async #writeCredentialBack(
		authStorage: AuthStorage,
		providerId: string,
		accountRef: string,
		cachedAccount: CachedArtifact,
		baseCredential: AuthCredential,
	): Promise<void> {
		const credentials = authStorage.listStoredCredentials(providerId);
		if (credentials.length !== 1 || !credentials[0]?.credential) return;
		const credential = credentials[0].credential;
		const writebackRoot = path.resolve(this.artifactCacheRoot, "..", "credential-writeback");
		await fs.mkdir(writebackRoot, { recursive: true });
		const writebackPath = path.join(writebackRoot, `${accountRef.slice(5)}.json`);
		if (credentialHash(credential) === credentialHash(baseCredential)) {
			await fs.rm(writebackPath, { force: true });
			return;
		}
		await atomicWriteJson(writebackPath, {
			schema: "grimoire.engine_credential_writeback.v1",
			artifactRef: accountRef,
			baseRevision: cachedAccount.revision,
			baseContentHash: cachedAccount.content_hash,
			baseCredentialHash: credentialHash(baseCredential),
			credential,
			updatedAt: new Date().toISOString(),
		});
	}

	async #read(ref: string, kind: string): Promise<CachedArtifact> {
		const value = await readJson(path.join(this.artifactCacheRoot, `${ref.slice(5)}.json`));
		if (
			value?.schema !== "grimoire.client_cached_artifact.v1" ||
			value.artifact_ref !== ref ||
			!Number.isSafeInteger(value.revision) ||
			value.kind !== kind ||
			typeof value.content_hash !== "string" ||
			typeof value.content !== "string"
		) {
			throw new Error(`Cached ${kind} Artifact is unavailable: ${ref}`);
		}
		return value as unknown as CachedArtifact;
	}
}

function toModelSpec(route: AvailableModelRoute, account: ProviderAccount): ModelSpec<Api> {
	const { contextWindow, maxOutputTokens } = resolveExecutableModelLimits(route.model);
	const input = uniqueStrings(route.model.inputModalities ?? ["text"]).filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	return {
		id: route.model.modelId,
		requestModelId: route.model.requestModelId,
		name: route.model.name || route.displayName || route.model.modelId,
		api: account.api,
		provider: account.providerId,
		baseUrl: account.baseUrl,
		headers: account.headers,
		reasoning: route.model.supportsReasoning === true,
		supportsTools: route.model.supportsTools,
		input: input.length ? input : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Number(contextWindow),
		maxTokens: maxOutputTokens,
	};
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
		input: model.input,
		supportsTools: model.supportsTools,
		cost: model.cost,
		contextWindow: Number(model.contextWindow),
		maxTokens: Number(model.maxTokens),
		headers: model.headers,
	};
}

function requiredRef(value: unknown, field: string): string {
	if (typeof value !== "string" || !GCTX.test(value)) throw new Error(`${field} must be a gctx Artifact ref`);
	return value;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
	return value.trim();
}

function resolveSpawnPolicy(
	profile: AgentProfile,
	launch: EngineLaunchProfile,
): { maxSpawnDepth: number; maxChildren: number; childProfileRefs: string[] } {
	if (!Array.isArray(profile.childProfiles ?? [])) throw new Error("AgentProfile childProfiles must be an array");
	const profileRefs = (profile.childProfiles ?? []).map((ref, index) => requiredRef(ref, `childProfiles[${index}]`));
	if (new Set(profileRefs).size !== profileRefs.length) throw new Error("AgentProfile childProfiles must be unique");
	const profileDepth = profile.maxSpawnDepth ?? 0;
	const profileLimit = profile.maxChildren ?? 0;
	if (!Number.isSafeInteger(profileDepth) || profileDepth < 0 || profileDepth > 31) {
		throw new Error("AgentProfile maxSpawnDepth must be between 0 and 31");
	}
	if (!Number.isSafeInteger(profileLimit) || profileLimit < 0 || profileLimit > 256) {
		throw new Error("AgentProfile maxChildren must be between 0 and 256");
	}
	if (profileDepth > 0 && (!profileRefs.length || profileLimit === 0)) {
		throw new Error("AgentProfile spawn depth requires childProfiles and maxChildren");
	}
	if (profileDepth === 0 && (profileRefs.length > 0 || profileLimit !== 0)) {
		throw new Error("AgentProfile childProfiles and maxChildren require spawn depth");
	}

	const launchDepth = launch.maxSpawnDepth ?? 0;
	const launchLimit = launch.maxChildren ?? 0;
	const launchRefs = launch.childProfileRefs ?? [];
	if (
		!Number.isSafeInteger(launchDepth) ||
		launchDepth < 0 ||
		launchDepth > profileDepth ||
		!Number.isSafeInteger(launchLimit) ||
		launchLimit < 0 ||
		!Array.isArray(launchRefs)
	) {
		throw new Error("Launch spawn policy exceeds the pinned AgentProfile");
	}
	const expectedRefs = launchDepth > 0 ? profileRefs : [];
	const expectedLimit = launchDepth > 0 ? profileLimit : 0;
	const expectedSpawns = launchDepth > 0 ? "*" : "";
	if (
		launch.spawns !== expectedSpawns ||
		launchLimit !== expectedLimit ||
		launchRefs.length !== expectedRefs.length ||
		launchRefs.some((ref, index) => ref !== expectedRefs[index])
	) {
		throw new Error("Launch spawn policy does not match the pinned AgentProfile");
	}
	return { maxSpawnDepth: launchDepth, maxChildren: launchLimit, childProfileRefs: expectedRefs };
}

function parseJson<T>(content: string, label: string): T {
	try {
		const value = JSON.parse(content);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as T;
	} catch {
		throw new Error(`${label} content must be one JSON object`);
	}
}

function validCredential(value: unknown): value is AuthCredential {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const credential = value as Record<string, unknown>;
	return (
		(credential.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0) ||
		(credential.type === "oauth" &&
			typeof credential.access === "string" &&
			typeof credential.refresh === "string" &&
			Number.isSafeInteger(credential.expires))
	);
}

function validLocalCredentialBinding(
	value: unknown,
): value is { source: "local_omp"; accountId: string; credentialId?: number } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).source === "local_omp" &&
		typeof (value as Record<string, unknown>).accountId === "string" &&
		((value as Record<string, unknown>).accountId as string).trim().length > 0 &&
		((value as Record<string, unknown>).credentialId === undefined ||
			(Number.isSafeInteger((value as Record<string, unknown>).credentialId) &&
				((value as Record<string, unknown>).credentialId as number) > 0))
	);
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

function uniqueStrings(values: unknown[]): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(file, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	await fs.writeFile(temp, JSON.stringify(value), "utf8");
	await fs.rename(temp, file);
}

function credentialHash(credential: AuthCredential): string {
	return digestJson(credential);
}

function digestJson(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringifyJson(value), "utf8").digest("hex")}`;
}
