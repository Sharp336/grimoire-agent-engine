import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, AuthCredential, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../config/model-registry";
import type { CreateAgentSessionOptions } from "../sdk";
import { AuthStorage } from "../session/auth-storage";
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
	routes: string[];
	trySameModelOtherProvider?: boolean;
	trustedProviderRequired?: boolean;
	toolPolicy?: { mode?: "unrestricted" | "allowlist"; toolNames?: string[] };
	mcpPolicy?: { mode?: "unrestricted" | "disabled" };
	generation?: { thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"] };
}

interface AvailableModelRoute {
	schema: "grimoire.available_model_route.v1";
	providerAccountRef: string;
	model: ModelSpec<Api>;
}

interface ProviderAccount {
	schema: "grimoire.provider_account.v1";
	providerId: string;
	trusted: boolean;
	credential: AuthCredential;
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
	>;
	dispose(): void;
}

export class EngineProfileResolver {
	constructor(
		readonly artifactCacheRoot: string,
		readonly credentialRoot: string,
	) {}

	async resolve(launch: EngineLaunchProfile): Promise<ResolvedEngineSessionProfile> {
		const profileRef = requiredRef(launch.launchProfileRef, "launchProfileRef");
		const cachedProfile = await this.#read(profileRef, "grimoire.agent_profile.v1");
		if (cachedProfile.content_hash !== launch.profileDigest) {
			throw new Error("AgentProfile digest does not match the cached Artifact");
		}
		const profile = parseJson<AgentProfile>(cachedProfile.content, "AgentProfile");
		if (profile.schema !== "grimoire.agent_profile.v1" || !Array.isArray(profile.routes) || !profile.routes.length) {
			throw new Error("AgentProfile must contain at least one route");
		}
		const candidates = await this.#routeCandidates(profile, launch.selectedRouteRef);
		let lastError: unknown;
		for (const routeRef of candidates) {
			try {
				return await this.#resolveRoute(profile, routeRef, launch.maxSpawnDepth);
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error("No usable AvailableModelRoute in AgentProfile", { cause: lastError });
	}

	async #routeCandidates(profile: AgentProfile, selected?: string): Promise<string[]> {
		const configured = profile.routes.map((ref, index) => requiredRef(ref, `routes[${index}]`));
		if (selected) {
			const selectedRef = requiredRef(selected, "selectedRouteRef");
			if (!configured.includes(selectedRef)) throw new Error("selectedRouteRef is outside AgentProfile");
			configured.splice(configured.indexOf(selectedRef), 1);
			configured.unshift(selectedRef);
		}
		if (!profile.trySameModelOtherProvider) return configured;
		const allRoutes = await this.#allCachedRoutes();
		const expanded: string[] = [];
		for (const ref of configured) {
			expanded.push(ref);
			const route = parseJson<AvailableModelRoute>(
				(await this.#read(ref, "grimoire.available_model_route.v1")).content,
				"AvailableModelRoute",
			);
			for (const candidate of allRoutes) {
				if (candidate.ref !== ref && candidate.route.model.id === route.model.id) expanded.push(candidate.ref);
			}
		}
		return [...new Set(expanded)];
	}

	async #resolveRoute(
		profile: AgentProfile,
		routeRef: string,
		maxSpawnDepth: number | undefined,
	): Promise<ResolvedEngineSessionProfile> {
		const route = parseJson<AvailableModelRoute>(
			(await this.#read(routeRef, "grimoire.available_model_route.v1")).content,
			"AvailableModelRoute",
		);
		if (route.schema !== "grimoire.available_model_route.v1" || !route.model?.id || !route.model.provider) {
			throw new Error("AvailableModelRoute has no valid model");
		}
		const accountRef = requiredRef(route.providerAccountRef, "providerAccountRef");
		const cachedAccount = await this.#read(accountRef, "grimoire.provider_account.v1");
		const account = parseJson<ProviderAccount>(cachedAccount.content, "ProviderAccount");
		if (
			account.schema !== "grimoire.provider_account.v1" ||
			!account.providerId ||
			account.providerId !== route.model.provider ||
			!validCredential(account.credential)
		) {
			throw new Error("ProviderAccount does not match AvailableModelRoute");
		}
		if (profile.trustedProviderRequired && account.trusted !== true) {
			throw new Error("AgentProfile requires a trusted provider");
		}
		const accountDir = path.join(this.credentialRoot, accountRef.slice(5));
		const writebackRoot = path.resolve(this.artifactCacheRoot, "..", "credential-writeback");
		await fs.mkdir(accountDir, { recursive: true });
		await fs.mkdir(writebackRoot, { recursive: true });
		const sourcePath = path.join(accountDir, "source.json");
		const authStorage = await AuthStorage.create(path.join(accountDir, "credentials.sqlite"));
		try {
			const source = await readJson(sourcePath);
			if (source?.contentHash !== cachedAccount.content_hash) {
				authStorage.upsertCredential(account.providerId, account.credential);
				await atomicWriteJson(sourcePath, { contentHash: cachedAccount.content_hash });
			}
			const modelRegistry = new ModelRegistry(authStorage, path.join(accountDir, "models.yml"), {
				ignoreLocalModelConfig: true,
				cacheDbPath: path.join(accountDir, "models.sqlite"),
			});
			const unsubscribeWriteback = authStorage.onGenerationChanged(() => {
				const credentials = authStorage.listStoredCredentials(account.providerId);
				if (credentials.length !== 1) return;
				const credential = credentials[0]?.credential;
				if (!credential) return;
				void atomicWriteJson(path.join(writebackRoot, `${accountRef.slice(5)}.json`), {
					schema: "grimoire.engine_credential_writeback.v1",
					artifactRef: accountRef,
					baseRevision: cachedAccount.revision,
					baseContentHash: cachedAccount.content_hash,
					credential,
					updatedAt: new Date().toISOString(),
				});
			});
			const model = buildModel(route.model) as Model;
			const restricted = profile.toolPolicy?.mode === "allowlist";
			return {
				options: {
					authStorage,
					modelRegistry,
					model,
					thinkingLevel: profile.generation?.thinkingLevel,
					toolNames: restricted ? uniqueStrings(profile.toolPolicy?.toolNames ?? []) : undefined,
					restrictToolNames: restricted,
					enableMCP: profile.mcpPolicy?.mode !== "disabled",
					enableLsp: true,
					maxSpawnDepth: maxSpawnDepth ?? 1,
				},
				dispose: () => {
					unsubscribeWriteback();
					authStorage.close();
				},
			};
		} catch (error) {
			authStorage.close();
			throw error;
		}
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

function requiredRef(value: unknown, field: string): string {
	if (typeof value !== "string" || !GCTX.test(value)) throw new Error(`${field} must be a gctx Artifact ref`);
	return value;
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
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(value), "utf8");
	await fs.rename(temp, file);
}
