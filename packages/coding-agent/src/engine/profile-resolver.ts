import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	type AuthCredential,
	getOAuthProvider,
	type OAuthProvider,
	refreshOAuthToken,
} from "@oh-my-pi/pi-ai";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry, type ProviderConfigInput } from "../config/model-registry";
import { SETTINGS_SCHEMA, type SettingPath, Settings } from "../config/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import type { EngineChildProfile } from "../tools";
import type { EngineLaunchProfile } from "./contracts";

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
	api: Api;
	baseUrl: string;
	headers?: Record<string, string>;
	trusted: boolean;
	credential?: AuthCredential;
	credentialBinding?: { source: "local_omp"; accountId: string };
}

export interface ResolvedEngineSessionProfile {
	options: Pick<
		CreateAgentSessionOptions,
		| "authStorage"
		| "modelRegistry"
		| "model"
		| "thinkingLevel"
		| "toolNames"
		| "restrictToolNames"
		| "enableMCP"
		| "enableLsp"
		| "maxSpawnDepth"
		| "settings"
	>;
	childProfiles: EngineChildProfile[];
	routes: EngineResolvedProviderRoute[];
	dispose(): void;
}

export interface EngineResolvedProviderRoute {
	selector: string;
	routeRef: string;
	providerAccountRef: string;
	modelIdentityId: string;
	providerSurfaceId: string;
}

interface LoadedRoute {
	routeRef: string;
	route: AvailableModelRoute;
	accountRef: string;
	cachedAccount: CachedArtifact;
	account: ProviderAccount;
	credential: AuthCredential;
	authProvider: string;
	localCredentialId?: number;
	localModelId?: string;
}

export class EngineProfileResolver {
	constructor(
		readonly artifactCacheRoot: string,
		readonly credentialRoot: string,
		readonly localCredentialDbPath: string = getAgentDbPath(),
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
		const disabledProviders = launch.disabledCapabilityProviders ?? [];
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
		let localStore: Awaited<ReturnType<typeof SqliteAuthCredentialStore.open>> | undefined;
		const loaded: LoadedRoute[] = [];
		let lastError: unknown;
		for (const routeRef of candidates) {
			try {
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
				let credential = embeddedCredential;
				let localCredentialId: number | undefined;
				if (localBinding) {
					localStore ??= await SqliteAuthCredentialStore.open(this.localCredentialDbPath);
					const stored = localStore
						.listAuthCredentials(account.providerId)
						.find(
							item => item.credential.type === "oauth" && item.credential.accountId === localBinding.accountId,
						);
					if (!stored) throw new Error("The local OMP account bound to ProviderAccount is unavailable");
					credential = stored.credential;
					localCredentialId = stored.id;
				}
				if (!credential) throw new Error("ProviderAccount credential is unavailable");
				loaded.push({
					routeRef,
					route,
					accountRef,
					cachedAccount,
					account,
					credential,
					authProvider: account.providerId,
					...(localCredentialId === undefined ? {} : { localCredentialId }),
				});
			} catch (error) {
				lastError = error;
			}
		}
		if (!loaded.length) {
			localStore?.close();
			throw new Error("No usable AvailableModelRoute in AgentProfile", { cause: lastError });
		}
		const providerCounts = Map.groupBy(loaded, route => route.account.providerId);
		for (const route of loaded) {
			if ((providerCounts.get(route.account.providerId)?.length ?? 0) > 1) {
				route.authProvider = `grimoire-route-${route.routeRef.slice(5)}`;
			}
		}
		try {
			return await this.#resolveRoutes(
				profile,
				loaded,
				launch,
				childProfiles,
				cwd,
				disabledProviders,
				spawnPolicy.maxSpawnDepth,
				localStore,
			);
		} catch (error) {
			localStore?.close();
			throw error;
		}
	}

	async #routeCandidates(profile: AgentProfile, selected?: string): Promise<string[]> {
		const configured = profile.models.map((ref, index) => requiredRef(ref, `models[${index}]`));
		if (selected) {
			const selectedRef = requiredRef(selected, "selectedRouteRef");
			if (!configured.includes(selectedRef)) throw new Error("selectedRouteRef is outside AgentProfile");
			configured.splice(configured.indexOf(selectedRef), 1);
			configured.unshift(selectedRef);
		}
		if (!profile.allowSameModelProviderFallback) return configured;
		const allRoutes = await this.#allCachedRoutes();
		const expanded: string[] = [];
		for (const ref of configured) {
			expanded.push(ref);
			const route = parseJson<AvailableModelRoute>(
				(await this.#read(ref, "grimoire.available_model_route.v1")).content,
				"AvailableModelRoute",
			);
			for (const candidate of allRoutes) {
				if (
					candidate.ref !== ref &&
					candidate.route.status !== "disabled" &&
					candidate.route.model.modelIdentityId === route.model.modelIdentityId
				) {
					expanded.push(candidate.ref);
				}
			}
		}
		return [...new Set(expanded)];
	}

	async #resolveRoutes(
		profile: AgentProfile,
		routes: LoadedRoute[],
		launch: EngineLaunchProfile,
		childProfiles: EngineChildProfile[],
		cwd: string,
		disabledProviders: string[],
		maxSpawnDepth: number,
		localStore?: Awaited<ReturnType<typeof SqliteAuthCredentialStore.open>>,
	): Promise<ResolvedEngineSessionProfile> {
		const profileDir = path.join(
			this.credentialRoot,
			requiredRef(launch.launchProfileRef, "launchProfileRef").slice(5),
		);
		await fs.mkdir(profileDir, { recursive: true });
		const sourceProviders = new Map(routes.map(route => [route.authProvider, route.account.providerId]));
		const authStorage = await AuthStorage.create(path.join(profileDir, "credentials.sqlite"), {
			sourceLabel: "Grimoire AgentProfile route",
			refreshOAuthCredential: async (provider, _credentialId, credential, signal) => {
				const sourceProvider = sourceProviders.get(provider);
				if (!sourceProvider) throw new Error(`Unknown AgentProfile credential route: ${provider}`);
				const custom = getOAuthProvider(sourceProvider);
				if (custom) {
					if (!custom.refreshToken) throw new Error(`OAuth provider ${sourceProvider} cannot refresh credentials`);
					return custom.refreshToken(credential, signal);
				}
				return refreshOAuthToken(sourceProvider as OAuthProvider, credential, signal);
			},
		});
		try {
			await authStorage.reload();
			for (const route of routes) {
				const sourcePath = path.join(profileDir, `${route.routeRef.slice(5)}.source.json`);
				const source = await readJson(sourcePath);
				const sourceIdentity =
					route.localCredentialId === undefined
						? route.cachedAccount.content_hash
						: credentialHash(route.credential);
				if (source?.sourceIdentity !== sourceIdentity) {
					await authStorage.set(route.authProvider, route.credential);
					await atomicWriteJson(sourcePath, { sourceIdentity });
				}
			}
			const writebackRoot = path.resolve(this.artifactCacheRoot, "..", "credential-writeback");
			await fs.mkdir(writebackRoot, { recursive: true });
			const writeback = async () => {
				for (const route of routes) {
					const credentials = authStorage.listStoredCredentials(route.authProvider);
					if (credentials.length !== 1) continue;
					const credential = credentials[0]?.credential;
					if (!credential) continue;
					if (route.localCredentialId !== undefined) {
						if (credentialHash(credential) !== credentialHash(route.credential)) {
							localStore?.updateAuthCredential(route.localCredentialId, credential);
							route.credential = credential;
						}
						continue;
					}
					const baseCredentialHash = credentialHash(route.credential);
					const writebackPath = path.join(writebackRoot, `${route.accountRef.slice(5)}.json`);
					if (credentialHash(credential) === baseCredentialHash) {
						await fs.rm(writebackPath, { force: true });
						continue;
					}
					await atomicWriteJson(writebackPath, {
						schema: "grimoire.engine_credential_writeback.v1",
						artifactRef: route.accountRef,
						baseRevision: route.cachedAccount.revision,
						baseContentHash: route.cachedAccount.content_hash,
						baseCredentialHash,
						credential,
						updatedAt: new Date().toISOString(),
					});
				}
			};
			const unsubscribeWriteback = authStorage.onGenerationChanged(() => void writeback().catch(() => {}));
			await writeback();

			const modelRegistry = new ModelRegistry(authStorage, path.join(profileDir, "models.yml"), {
				ignoreLocalModelConfig: true,
				cacheDbPath: path.join(profileDir, "models.sqlite"),
			});
			const usedSelectors = new Set<string>();
			for (const route of routes) {
				const baseSelector = `${route.account.providerId}/${route.route.model.modelId}`;
				route.localModelId = usedSelectors.has(baseSelector)
					? `${route.route.model.modelId}@${route.routeRef.slice(5)}`
					: route.route.model.modelId;
				usedSelectors.add(`${route.account.providerId}/${route.localModelId}`);
			}
			const byProvider = Map.groupBy(routes, route => route.account.providerId);
			for (const [provider, providerRoutes] of byProvider) {
				const first = providerRoutes[0];
				if (!first) continue;
				modelRegistry.registerProvider(provider, {
					api: first.account.api,
					baseUrl: first.account.baseUrl,
					models: providerRoutes.map(route =>
						toModelSpec(route.route, route.account, route.localModelId!, route.authProvider),
					),
				});
			}
			const resolvedRoutes = routes.map(route => ({
				selector: `${route.account.providerId}/${route.localModelId}`,
				routeRef: route.routeRef,
				providerAccountRef: route.accountRef,
				modelIdentityId: route.route.model.modelIdentityId,
				providerSurfaceId: route.route.model.providerSurfaceId,
			}));
			const [primary, ...fallbacks] = resolvedRoutes;
			if (!primary) throw new Error("AgentProfile has no executable route");
			const settings = await Settings.loadReadOnly({
				cwd,
				overrides: {
					disabledProviders,
					"lsp.shared": launch.lspShared ?? false,
					"task.maxRecursionDepth": maxSpawnDepth,
					"retry.enabled": true,
					"retry.maxRetries": 3,
					"retry.baseDelayMs": 3_000,
					"retry.modelFallback": fallbacks.length > 0,
					"retry.fallbackRevertPolicy": "never",
					"retry.fallbackChains": fallbacks.length
						? { [primary.selector]: fallbacks.map(route => route.selector) }
						: {},
				},
			});
			const primaryRoute = routes[0];
			const model = primaryRoute
				? modelRegistry.find(primaryRoute.account.providerId, primaryRoute.localModelId!)
				: undefined;
			if (!model) throw new Error("AgentProfile primary model is unavailable after registration");
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
					thinkingLevel: profile.generationDefaults?.thinkingLevel,
					toolNames,
					restrictToolNames: profileRestricted || launchRestricted,
					enableMCP: launch.enableMCP ?? true,
					enableLsp: launch.enableLsp ?? true,
					maxSpawnDepth,
				},
				childProfiles,
				routes: resolvedRoutes,
				dispose: () => {
					unsubscribeWriteback();
					authStorage.close();
					localStore?.close();
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

	async #allCachedRoutes(): Promise<Array<{ ref: string; route: AvailableModelRoute }>> {
		const entries = await fs.readdir(this.artifactCacheRoot, { withFileTypes: true }).catch(() => []);
		const routes: Array<{ ref: string; route: AvailableModelRoute }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const value = await readJson(path.join(this.artifactCacheRoot, entry.name));
			if (value?.kind !== "grimoire.available_model_route.v1" || typeof value.content !== "string") continue;
			try {
				routes.push({ ref: String(value.artifact_ref), route: parseJson(value.content, "AvailableModelRoute") });
			} catch {}
		}
		return routes;
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

function toModelSpec(
	route: AvailableModelRoute,
	account: ProviderAccount,
	localModelId = route.model.modelId,
	authProvider?: string,
): NonNullable<ProviderConfigInput["models"]>[number] {
	const contextWindow = route.model.contextWindow;
	const maxTokens = route.model.maxOutputTokens;
	if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0) {
		throw new Error("AvailableModelRoute requires model.contextWindow for execution");
	}
	if (!Number.isSafeInteger(maxTokens) || Number(maxTokens) <= 0) {
		throw new Error("AvailableModelRoute requires model.maxOutputTokens for execution");
	}
	const input = uniqueStrings(route.model.inputModalities ?? ["text"]).filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	return {
		id: localModelId,
		requestModelId:
			route.model.requestModelId ?? (localModelId === route.model.modelId ? undefined : route.model.modelId),
		name: route.model.name || route.displayName || route.model.modelId,
		api: account.api,
		authProvider,
		baseUrl: account.baseUrl,
		headers: account.headers,
		reasoning: route.model.supportsReasoning === true,
		supportsTools: route.model.supportsTools,
		input: input.length ? input : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Number(contextWindow),
		maxTokens: Number(maxTokens),
	};
}

function requiredRef(value: unknown, field: string): string {
	if (typeof value !== "string" || !GCTX.test(value)) throw new Error(`${field} must be a gctx Artifact ref`);
	return value;
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

function validLocalCredentialBinding(value: unknown): value is { source: "local_omp"; accountId: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).source === "local_omp" &&
		typeof (value as Record<string, unknown>).accountId === "string" &&
		((value as Record<string, unknown>).accountId as string).trim().length > 0
	);
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
