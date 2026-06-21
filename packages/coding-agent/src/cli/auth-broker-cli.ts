/**
 * `omp auth-broker` command handlers.
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the broker against the local SQLite store.
 *   - `token` / `token --regenerate` — manages the bearer token file.
 *   - `login <provider> [--via=user@host]` — logs into a provider locally, or
 *     via SSH tunnel into a remote broker host.
 *   - `import <file|dir>` — imports CLIProxyAPI-style JSON credentials into
 *     the local SQLite store (typical use: `import ~/.cliproxy/auth`).
 *   - `migrate --from-local [--include-env] [--include-oauth] [--dry-run]` —
 *     uploads local SQLite + env API keys to the broker, skipping anything
 *     the broker already has.
 *   - `status` — health-pings the configured remote broker.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	type AuthCredential,
	AuthStorage,
	type CredentialDisabledEvent,
	type FetchImpl,
	getEnvApiKey,
	getOAuthProviders,
	listProvidersWithEnvKey,
	type Model,
	type ModelsConfigResponse,
	type OAuthCredential,
	type OAuthProvider,
	type OAuthProviderInfo,
	PROVIDER_REGISTRY,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, DEFAULT_AUTH_BROKER_BIND, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { $which, APP_NAME, getAgentDbPath, getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { $ } from "bun";
import chalk from "chalk";
import { looksLikeLiteralSecret, resolveConfigHeaders, resolveConfigValue } from "../config/custom-model-builder";
import { discoverModelsByProviderType } from "../config/model-discovery";
import { ModelsConfigFile } from "../config/models-config";
import type { ModelsConfig } from "../config/models-config-schema";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthBrokerAction = "serve" | "token" | "login" | "logout" | "status" | "import" | "migrate" | "list";

export interface AuthBrokerCommandArgs {
	action: AuthBrokerAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		via?: string;
		provider?: string;
		dryRun?: boolean;
		/** `login`/`logout`: provider id. `import`: filesystem path. */
		source?: string;
		/** `import`: keep credentials whose JSON had `disabled: true`. */
		includeDisabled?: boolean;
		/** `migrate`: also upload local OAuth (default: api_key only, since OAuth is via cliproxy import). */
		includeOauth?: boolean;
		/** `migrate`: also capture env-var API keys for providers not yet on broker. */
		includeEnv?: boolean;
		/** `migrate`: required `--from-local` source. Reserved for future sources. */
		fromLocal?: boolean;
		dangerouslyAllowLocalRawKeys?: boolean;
		catalogRefreshIntervalMs?: number;
	};
}

const ACTIONS: readonly AuthBrokerAction[] = [
	"serve",
	"token",
	"login",
	"logout",
	"import",
	"migrate",
	"status",
	"list",
];

/** Callback ports baked from the per-provider OAuth flow modules. */
const CALLBACK_PORTS: Record<string, number> = Object.fromEntries(
	PROVIDER_REGISTRY.flatMap(provider =>
		provider.callbackPort != null ? [[provider.id, provider.callbackPort] as [string, number]] : [],
	),
);

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function readToken(): Promise<string | null> {
	try {
		const raw = await Bun.file(getTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeToken(token: string): Promise<void> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await Bun.write(file, token);
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	await writeToken(token);
	return token;
}

export type BrokerOwnedCredentialMap = Map<string, Set<number>>;

export interface SharedBrokerCatalogLoad {
	catalog: ModelsConfigResponse;
	brokerOwnedCredentials: BrokerOwnedCredentialMap;
}

export interface SharedBrokerCatalogLoadOptions {
	dangerouslyAllowLocalRawKeys?: boolean;
	fetch?: FetchImpl;
}

type SharedProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type SharedModelDefinition = NonNullable<SharedProviderConfig["models"]>[number];
type SharedModelOverride = NonNullable<SharedProviderConfig["modelOverrides"]>[string];
type SanitizedModelDefinition = NonNullable<ModelsConfigResponse["providers"][string]["models"]>[number];
type SanitizedModelOverride = NonNullable<ModelsConfigResponse["providers"][string]["modelOverrides"]>[string];

function getDefaultSharedCatalogPath(): string {
	return path.join(getConfigRootDir(), "models-shared.yml");
}

function isSecretReference(value: string): boolean {
	if (value.startsWith("!")) return true;
	if (looksLikeLiteralSecret(value)) return true;
	return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function resolveSharedApiKey(value: string, opts: SharedBrokerCatalogLoadOptions = {}): string | undefined {
	if (value.startsWith("!")) return resolveConfigValue(value);
	if (looksLikeLiteralSecret(value) && opts.dangerouslyAllowLocalRawKeys) return value;
	return Bun.env[value];
}

function isSupportedApiKeyReference(value: string): boolean {
	if (value.startsWith("!")) return true;
	return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function isSecretHeaderName(header: string): boolean {
	const normalized = header.toLowerCase();
	return (
		normalized === "authorization" ||
		normalized === "proxy-authorization" ||
		normalized === "api-key" ||
		normalized === "x-api-key" ||
		normalized === "x-auth-token" ||
		normalized === "x-access-token"
	);
}

function validateSharedHeaders(context: string, headers: Record<string, string> | undefined): void {
	for (const [header, value] of Object.entries(headers ?? {})) {
		if (isSecretHeaderName(header) || isSecretReference(value)) {
			throw new Error(`${context} header ${header} is not allowed in broker shared catalog`);
		}
	}
}

function validateNoNestedApiKey(context: string, value: object): void {
	if ("apiKey" in value) throw new Error(`${context} apiKey is not allowed in broker shared catalog`);
}

function validateNoSecretUnknownProviderFields(provider: string, providerConfig: SharedProviderConfig): void {
	const knownFields = new Set([
		"baseUrl",
		"api",
		"apiKey",
		"headers",
		"authHeader",
		"auth",
		"discovery",
		"models",
		"modelOverrides",
		"disableStrictTools",
		"compat",
		"transport",
	]);
	for (const [field, value] of Object.entries(providerConfig)) {
		if (knownFields.has(field) || typeof value !== "string") continue;
		if (isSecretReference(value)) {
			throw new Error(`Provider ${provider}: unknown field ${field} is not allowed in broker shared catalog`);
		}
	}
}

function sanitizeProviderConfig(providerConfig: SharedProviderConfig): ModelsConfigResponse["providers"][string] {
	const { baseUrl, api, headers, authHeader, auth, discovery, disableStrictTools, compat } = providerConfig;
	return {
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(api !== undefined ? { api } : {}),
		...(headers !== undefined ? { headers } : {}),
		...(authHeader === false ? { authHeader } : {}),
		...(auth !== undefined ? { auth } : {}),
		...(discovery !== undefined ? { discovery } : {}),
		...(disableStrictTools !== undefined ? { disableStrictTools } : {}),
		...(compat !== undefined ? { compat: compat as ModelsConfigResponse["providers"][string]["compat"] } : {}),
	};
}

function sanitizeModelDefinition(model: SharedModelDefinition): SanitizedModelDefinition {
	const {
		id,
		requestModelId,
		name,
		api,
		baseUrl,
		reasoning,
		thinking,
		input,
		supportsTools,
		cost,
		premiumMultiplier,
		contextWindow,
		maxTokens,
		omitMaxOutputTokens,
		headers,
		compat,
		contextPromotionTarget,
	} = model;
	return {
		id,
		...(requestModelId !== undefined ? { requestModelId } : {}),
		...(name !== undefined ? { name } : {}),
		...(api !== undefined ? { api } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(input !== undefined ? { input } : {}),
		...(supportsTools !== undefined ? { supportsTools } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(premiumMultiplier !== undefined ? { premiumMultiplier } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(omitMaxOutputTokens !== undefined ? { omitMaxOutputTokens } : {}),
		...(headers !== undefined ? { headers } : {}),
		...(compat !== undefined ? { compat } : {}),
		...(contextPromotionTarget !== undefined ? { contextPromotionTarget } : {}),
	};
}

function sanitizeModelOverride(override: SharedModelOverride): SanitizedModelOverride {
	const {
		name,
		reasoning,
		thinking,
		input,
		supportsTools,
		cost,
		premiumMultiplier,
		contextWindow,
		maxTokens,
		omitMaxOutputTokens,
		headers,
		compat,
		contextPromotionTarget,
	} = override;
	const sanitized = {
		...(name !== undefined ? { name } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(input !== undefined ? { input } : {}),
		...(supportsTools !== undefined ? { supportsTools } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(premiumMultiplier !== undefined ? { premiumMultiplier } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(omitMaxOutputTokens !== undefined ? { omitMaxOutputTokens } : {}),
		...(headers !== undefined ? { headers } : {}),
		...(compat !== undefined ? { compat } : {}),
		...(contextPromotionTarget !== undefined ? { contextPromotionTarget } : {}),
	};
	return sanitized as SanitizedModelOverride;
}

export function validateSharedBrokerCatalog(config: ModelsConfig, opts: SharedBrokerCatalogLoadOptions = {}): void {
	for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
		const apiKey = providerConfig.apiKey;
		if (apiKey !== undefined) {
			if (apiKey.length === 0)
				throw new Error(`Provider ${provider}: empty apiKey is not allowed in models-shared.yml`);
			if (looksLikeLiteralSecret(apiKey)) {
				if (!opts.dangerouslyAllowLocalRawKeys) {
					throw new Error(`Provider ${provider}: apiKey appears to be a literal secret`);
				}
			} else if (!isSupportedApiKeyReference(apiKey)) {
				throw new Error(`Provider ${provider}: apiKey reference must be an environment variable or !cmd`);
			}
		}
		if (providerConfig.transport !== undefined) {
			throw new Error(`Provider ${provider}: transport is not supported in broker shared catalog`);
		}
		if (providerConfig.authHeader === true && !opts.dangerouslyAllowLocalRawKeys) {
			throw new Error(`Provider ${provider}: authHeader is not supported in broker shared catalog`);
		}
		validateSharedHeaders(`Provider ${provider}: secret-bearing`, providerConfig.headers);
		validateNoSecretUnknownProviderFields(provider, providerConfig);
		for (const model of providerConfig.models ?? []) {
			validateNoNestedApiKey(`Provider ${provider}: model ${model.id}`, model);
			validateSharedHeaders(`Provider ${provider}: model ${model.id}`, model.headers);
		}
		for (const [modelId, override] of Object.entries(providerConfig.modelOverrides ?? {})) {
			validateNoNestedApiKey(`Provider ${provider}: model override ${modelId}`, override);
			validateSharedHeaders(`Provider ${provider}: model override ${modelId}`, override.headers);
		}
	}
}

async function materializeSharedCatalogDiscovery(
	config: ModelsConfig,
	resolvedApiKeys: Map<string, string>,
	opts: SharedBrokerCatalogLoadOptions,
): Promise<ModelsConfig> {
	const providers = { ...(config.providers ?? {}) };
	const fetchImpl = opts.fetch ?? fetch;
	for (const [provider, providerConfig] of Object.entries(providers)) {
		if (!providerConfig.discovery) continue;
		if (!providerConfig.api && providerConfig.discovery.type !== "proxy") continue;
		const headers = resolveConfigHeaders(providerConfig.headers) ?? {};
		const apiKey = resolvedApiKeys.get(provider);
		const discoveryHeaders =
			providerConfig.authHeader && apiKey ? { ...headers, Authorization: `Bearer ${apiKey}` } : headers;
		let discovered: Model[];
		try {
			discovered = await discoverModelsByProviderType(
				{
					provider,
					api: providerConfig.api ?? "openai-completions",
					baseUrl: providerConfig.baseUrl,
					headers: discoveryHeaders,
					compat: providerConfig.compat,
					discovery: providerConfig.discovery,
				},
				{
					fetch: fetchImpl,
					getBearerApiKeyResolver: async id =>
						id === provider && !providerConfig.authHeader ? apiKey : undefined,
				},
			);
		} catch (error) {
			logger.warn("auth-broker shared catalog discovery failed", { provider, error: String(error) });
			continue;
		}
		const discoveredModels: NonNullable<NonNullable<ModelsConfig["providers"]>[string]["models"]> = discovered.map(
			model => ({
				id: model.id,
				name: model.name,
				api: model.api as NonNullable<
					NonNullable<NonNullable<ModelsConfig["providers"]>[string]["models"]>[number]["api"]
				>,
				baseUrl: model.baseUrl === providerConfig.baseUrl ? undefined : model.baseUrl,
				reasoning: model.reasoning,
				thinking: model.thinking,
				input: model.input,
				cost: model.cost,
				supportsTools: model.supportsTools,
				contextWindow: model.contextWindow ?? undefined,
				maxTokens: model.maxTokens ?? undefined,
				omitMaxOutputTokens: model.omitMaxOutputTokens,
				compat: model.compatConfig,
				contextPromotionTarget: model.contextPromotionTarget,
				premiumMultiplier: model.premiumMultiplier,
				requestModelId: model.requestModelId,
			}),
		);
		const configuredModels = providerConfig.models ?? [];
		const configuredIds = new Set(configuredModels.map(model => model.id));
		providers[provider] = {
			...providerConfig,
			models: [...configuredModels, ...discoveredModels.filter(model => !configuredIds.has(model.id))],
		};
	}
	return { ...config, providers };
}

function sanitizeSharedCatalog(config: ModelsConfig, generatedAt: number): ModelsConfigResponse {
	const providers: ModelsConfigResponse["providers"] = {};
	for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
		const { models, modelOverrides, compat } = providerConfig;
		const providerResponse = sanitizeProviderConfig(providerConfig);
		if (models) providerResponse.models = models.map(sanitizeModelDefinition);
		if (modelOverrides) {
			providerResponse.modelOverrides = Object.fromEntries(
				Object.entries(modelOverrides).map(([modelId, override]) => [modelId, sanitizeModelOverride(override)]),
			);
		}
		if (compat) providerResponse.compat = compat as ModelsConfigResponse["providers"][string]["compat"];
		providers[provider] = providerResponse;
	}
	return {
		generatedAt,
		schemaVersion: 1,
		providers,
		...(config.equivalence ? { equivalence: config.equivalence } : {}),
	};
}

function getBrokerOwnedCredentialsPath(sharedPath: string): string {
	const hash = crypto.createHash("sha256").update(path.resolve(sharedPath)).digest("hex").slice(0, 16);
	return path.join(getConfigRootDir(), `auth-broker-shared-credentials.${hash}.json`);
}

async function readBrokerOwnedCredentials(sharedPath: string): Promise<BrokerOwnedCredentialMap> {
	try {
		const parsed = (await Bun.file(getBrokerOwnedCredentialsPath(sharedPath)).json()) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
		const map: BrokerOwnedCredentialMap = new Map();
		for (const [provider, ids] of Object.entries(parsed)) {
			if (!Array.isArray(ids)) continue;
			const numericIds = ids.filter((id): id is number => Number.isSafeInteger(id));
			if (numericIds.length > 0) map.set(provider, new Set(numericIds));
		}
		return map;
	} catch (error) {
		if (!isEnoent(error))
			logger.debug("auth-broker shared credential ownership unreadable", { error: String(error) });
		return new Map();
	}
}

async function writeBrokerOwnedCredentials(sharedPath: string, credentials: BrokerOwnedCredentialMap): Promise<void> {
	const payload = Object.fromEntries([...credentials].map(([provider, ids]) => [provider, [...ids]]));
	await Bun.write(getBrokerOwnedCredentialsPath(sharedPath), JSON.stringify(payload));
}

function hasBrokerOwnedCredentials(credentials: BrokerOwnedCredentialMap): boolean {
	for (const ids of credentials.values()) if (ids.size > 0) return true;
	return false;
}

async function removeStaleBrokerOwnedKeys(
	storage: AuthStorage,
	previous: BrokerOwnedCredentialMap,
	next: BrokerOwnedCredentialMap,
): Promise<void> {
	for (const [provider, ids] of previous) {
		const kept = next.get(provider);
		for (const id of ids) {
			if (kept?.has(id)) continue;
			await storage.removeCredential(provider, id);
		}
	}
}

export async function loadSharedBrokerCatalog(
	sharedPath: string,
	storage: AuthStorage,
	previousBrokerOwnedCredentials: BrokerOwnedCredentialMap = new Map(),
	opts: SharedBrokerCatalogLoadOptions = {},
): Promise<SharedBrokerCatalogLoad | undefined> {
	const file = ModelsConfigFile.relocate(sharedPath);
	file.invalidate();
	const previousCredentials = hasBrokerOwnedCredentials(previousBrokerOwnedCredentials)
		? previousBrokerOwnedCredentials
		: await readBrokerOwnedCredentials(sharedPath);
	const result = await file.tryLoadAsync();
	if (result.status === "not-found") {
		await removeStaleBrokerOwnedKeys(storage, previousCredentials, new Map());
		await writeBrokerOwnedCredentials(sharedPath, new Map());
		return {
			catalog: { generatedAt: Date.now(), schemaVersion: 1, providers: {} },
			brokerOwnedCredentials: new Map(),
		};
	}
	if (result.status === "error") throw result.error;
	const config = result.value;
	validateSharedBrokerCatalog(config, opts);
	const brokerOwnedCredentials: BrokerOwnedCredentialMap = new Map();
	const resolvedApiKeys = new Map<string, string>();
	for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
		if (!providerConfig.apiKey) continue;
		const resolved = resolveSharedApiKey(providerConfig.apiKey, opts);
		if (!resolved) throw new Error(`Unable to resolve apiKey for shared provider ${provider}`);
		resolvedApiKeys.set(provider, resolved);
	}
	for (const [provider, resolved] of resolvedApiKeys) {
		const entries = storage.upsertCredential(provider, { type: "api_key", key: resolved });
		const brokerOwnedIds = entries
			.filter(entry => entry.credential.type === "api_key" && entry.credential.key === resolved)
			.map(entry => entry.id);
		brokerOwnedCredentials.set(provider, new Set(brokerOwnedIds));
	}
	await removeStaleBrokerOwnedKeys(storage, previousCredentials, brokerOwnedCredentials);
	await writeBrokerOwnedCredentials(sharedPath, brokerOwnedCredentials);
	const materializedConfig = await materializeSharedCatalogDiscovery(config, resolvedApiKeys, opts);
	return { catalog: sanitizeSharedCatalog(materializedConfig, Date.now()), brokerOwnedCredentials };
}

export interface SharedCatalogAutoRefreshOptions {
	intervalMs?: number;
	reload: () => Promise<ModelsConfigResponse>;
	onReload?: (catalog: ModelsConfigResponse) => void;
}

export function startSharedCatalogAutoRefresh(opts: SharedCatalogAutoRefreshOptions): (() => void) | undefined {
	const intervalMs = opts.intervalMs;
	if (intervalMs === undefined || intervalMs <= 0) return undefined;
	let reloading = false;
	const timer: NodeJS.Timeout = setInterval(() => {
		if (reloading) return;
		reloading = true;
		opts
			.reload()
			.then(catalog => {
				opts.onReload?.(catalog);
				logger.info("auth-broker shared catalog auto-refresh completed", { generatedAt: catalog.generatedAt });
			})
			.catch(error => {
				logger.warn("auth-broker shared catalog auto-refresh failed", { error: String(error) });
			})
			.finally(() => {
				reloading = false;
			});
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

export interface AuthBrokerShutdownHandlers {
	done: Promise<void>;
	shutdown(signal: NodeJS.Signals): Promise<void>;
}

export function createAuthBrokerShutdownHandlers(
	shutdown: (signal: NodeJS.Signals) => Promise<void>,
): AuthBrokerShutdownHandlers {
	const done = Promise.withResolvers<void>();
	let shuttingDown = false;
	const runShutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return done.promise;
		shuttingDown = true;
		try {
			await shutdown(signal);
			done.resolve();
		} catch (error) {
			done.reject(error);
		}
		return done.promise;
	};
	process.once("SIGINT", () => void runShutdown("SIGINT"));
	process.once("SIGTERM", () => void runShutdown("SIGTERM"));
	return { done: done.promise, shutdown: runShutdown };
}

async function runServe(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	// The broker is a long-running headless service: route structured logs to
	// stdout so a process supervisor (pm2, journald, k8s) captures them, and
	// skip the rotating ~/.omp/logs/ file the TUI default would have used.
	setLoggerTransports({ console: true, file: false });

	const bind = flags.bind ?? DEFAULT_AUTH_BROKER_BIND;
	const token = await ensureToken();
	const dbPath = getAgentDbPath();
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = new AuthStorage(store);
	await storage.reload();
	const sharedCatalogPath = Bun.env.OMP_BROKER_SHARED_CONFIG ?? getDefaultSharedCatalogPath();
	if (flags.dangerouslyAllowLocalRawKeys) {
		logger.warn("auth-broker accepting literal apiKey values from shared catalog for local ingestion only");
	}
	let sharedCatalog = await loadSharedBrokerCatalog(sharedCatalogPath, storage, new Map(), flags);
	const reloadSharedCatalog = async (): Promise<ModelsConfigResponse> => {
		const reloaded = await loadSharedBrokerCatalog(
			sharedCatalogPath,
			storage,
			sharedCatalog?.brokerOwnedCredentials ?? new Map(),
			flags,
		);
		if (!reloaded) throw new Error(`Shared catalog not found: ${sharedCatalogPath}`);
		sharedCatalog = reloaded;
		return reloaded.catalog;
	};

	const handle = startAuthBroker({
		storage,
		bind,
		bearerTokens: [token],
		version: VERSION,
		getSharedCatalog: () => sharedCatalog?.catalog,
		reloadSharedCatalog,
	});
	const stopCatalogAutoRefresh = startSharedCatalogAutoRefresh({
		intervalMs: flags.catalogRefreshIntervalMs,
		reload: reloadSharedCatalog,
		onReload: catalog => handle.emitCatalogChanged(catalog.generatedAt),
	});
	logger.info("auth-broker listening", { url: handle.url });
	logger.info("auth-broker bearer token loaded", { path: getTokenFilePath(), mode: "0600" });
	if (sharedCatalog) {
		logger.info("auth-broker shared catalog loaded", {
			path: sharedCatalogPath,
			providers: Object.keys(sharedCatalog.catalog.providers).length,
			generatedAt: sharedCatalog.catalog.generatedAt,
		});
	}

	const credentialDisabledUnsub = storage.onCredentialDisabled((event: CredentialDisabledEvent) => {
		logger.warn("auth-broker credential disabled", { ...event });
	});

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		logger.info("auth-broker shutting down", { signal });
		stopCatalogAutoRefresh?.();
		credentialDisabledUnsub();
		await handle.close();
	};

	const shutdownHandlers = createAuthBrokerShutdownHandlers(shutdown);

	// Block until signal-driven shutdown finishes.
	await shutdownHandlers.done;
}

async function runToken(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeToken(next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runLogin(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	let providerArg = flags.provider;
	if (!providerArg) {
		if (flags.via) {
			throw new Error(
				"Usage: omp auth-broker login <provider> --via=user@host (provider required for remote login)",
			);
		}
		providerArg = await pickProviderInteractively(providers);
	}
	if (!providers.some(p => p.id === providerArg)) {
		throw new Error(
			`Unknown OAuth provider '${providerArg}'. Known: ${providers
				.map(p => p.id)
				.sort()
				.join(", ")}`,
		);
	}
	if (flags.via) {
		await runRemoteLogin(providerArg, flags.via, flags.dryRun ?? false);
		return;
	}
	await runLocalLogin(providerArg as OAuthProvider);
}

async function runLocalLogin(provider: OAuthProvider): Promise<void> {
	// Drive the per-provider OAuth dance in-process. Persists into the same
	// SQLite store the broker uses.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (msg: string) => promptLine(rl, `${msg} `);
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	try {
		await storage.login(provider, {
			onAuth({ url, instructions }) {
				process.stdout.write(`\nOpen this URL in your browser:\n${url}\n`);
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("\n");
			},
			onProgress(message) {
				process.stdout.write(`${message}\n`);
			},
			onPrompt(p) {
				return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
		});
		process.stdout.write(`\nCredentials saved to ${getAgentDbPath()}\n`);
	} finally {
		store.close();
		rl.close();
	}
}

/**
 * Interactive `readline` prompt that cleanly tears down on Ctrl-C / Escape so
 * cancelling a half-finished login flow doesn't leave the terminal in raw mode.
 */
function promptLine(rl: readline.Interface, question: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("Login cancelled")));
	};

	const onSigint = () => {
		cancel();
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.question(question, answer => {
		finish(() => resolve(answer));
	});
	return promise;
}

async function pickProviderInteractively(providers: readonly OAuthProviderInfo[]): Promise<string> {
	if (providers.length === 0) {
		throw new Error("No OAuth providers registered");
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("Select a provider:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i].name}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `Enter number (1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`Invalid selection: ${choice}`);
		}
		return providers[index].id;
	} finally {
		rl.close();
	}
}

async function runRemoteLogin(provider: string, via: string, dryRun: boolean): Promise<void> {
	const port = CALLBACK_PORTS[provider];
	if (port === undefined) {
		throw new Error(
			`No known OAuth callback port for '${provider}'. Use device-code flow on the broker host directly.`,
		);
	}
	const sshArgs = [
		"-L",
		`${port}:127.0.0.1:${port}`,
		"-o",
		"ExitOnForwardFailure=yes",
		via,
		`${APP_NAME} auth-broker login ${provider}`,
	];
	if (dryRun) {
		process.stdout.write(`ssh ${sshArgs.map(a => (a.includes(" ") ? `'${a}'` : a)).join(" ")}\n`);
		return;
	}
	const sshBin = $which("ssh");
	if (!sshBin) {
		throw new Error("ssh binary not found in PATH");
	}
	const proc = Bun.spawn({
		cmd: [sshBin, ...sshArgs],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`ssh exited with code ${exitCode}`);
	}
}

async function runLogout(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	let providerArg = flags.provider;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		if (!providerArg) {
			const stored = store.listProviders();
			if (stored.length === 0) {
				process.stdout.write("No credentials stored.\n");
				return;
			}
			providerArg = await pickStoredProviderInteractively(stored);
		}
		store.deleteAuthCredentialsForProvider(providerArg, "logged out by user");
		process.stdout.write(`Logged out of ${providerArg}\n`);
	} finally {
		store.close();
	}
}

async function pickStoredProviderInteractively(providers: string[]): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("Select a provider to logout:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i]}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `Enter number (1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`Invalid selection: ${choice}`);
		}
		return providers[index];
	} finally {
		rl.close();
	}
}

async function runList(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(providers.map(p => ({ id: p.id, name: p.name })))}\n`);
		return;
	}
	process.stdout.write("Available providers:\n\n");
	for (const p of providers) {
		process.stdout.write(`  ${p.id.padEnd(20)} ${p.name}\n`);
	}
}

// ─── CLIProxyAPI import ─────────────────────────────────────────────────

/**
 * Maps the `type` field of a CLIProxyAPI credential JSON to the omp provider id.
 * The filename also encodes the type (e.g. `claude-foo@bar.json`), but the
 * in-file `type` is authoritative — we only fall back to filename if absent.
 */
const CLIPROXY_TYPE_TO_PROVIDER: Record<string, string> = {
	claude: "anthropic",
	codex: "openai-codex",
	gemini: "google-gemini-cli",
	antigravity: "google-antigravity",
	"gemini-cli": "google-gemini-cli",
};

interface CliProxyCredentialJson {
	type?: string;
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expired?: string;
	last_refresh?: string;
	email?: string;
	account_id?: string;
	disabled?: boolean;
}

interface ImportPlanEntry {
	sourceFile: string;
	provider: string;
	email: string | null;
	accountId: string | null;
	expiresAt: number;
	disabled: boolean;
	credential: OAuthCredential;
}

function resolveCliProxyProvider(json: CliProxyCredentialJson, filename: string, overrideId?: string): string | null {
	if (overrideId && overrideId.length > 0) return overrideId;
	const typeField = json.type?.trim().toLowerCase();
	if (typeField && CLIPROXY_TYPE_TO_PROVIDER[typeField]) return CLIPROXY_TYPE_TO_PROVIDER[typeField];
	// Fall back to filename prefix: `<type>-<email>.json`
	const base = path.basename(filename, ".json").toLowerCase();
	for (const prefix in CLIPROXY_TYPE_TO_PROVIDER) {
		const providerId = CLIPROXY_TYPE_TO_PROVIDER[prefix];
		if (base.startsWith(`${prefix}-`) || base === prefix) return providerId;
	}
	return null;
}

function parseCliProxyExpiry(raw: string | undefined): number | null {
	if (!raw) return null;
	// CLIProxyAPI writes RFC3339-ish dates. `Date.parse` handles both `Z` and offsets.
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

async function collectImportSources(target: string): Promise<string[]> {
	const stat = await fs.stat(target);
	if (stat.isFile()) return [target];
	if (!stat.isDirectory()) {
		throw new Error(`Import source is neither file nor directory: ${target}`);
	}
	const entries = await fs.readdir(target, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		files.push(path.join(target, entry.name));
	}
	files.sort();
	return files;
}

async function loadImportPlan(
	target: string,
	overrideProvider: string | undefined,
	includeDisabled: boolean,
): Promise<{ entries: ImportPlanEntry[]; skipped: Array<{ file: string; reason: string }> }> {
	const files = await collectImportSources(target);
	const entries: ImportPlanEntry[] = [];
	const skipped: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		let json: CliProxyCredentialJson;
		try {
			json = (await Bun.file(file).json()) as CliProxyCredentialJson;
		} catch (err) {
			skipped.push({ file, reason: `unreadable JSON: ${String(err)}` });
			continue;
		}
		if (json.disabled === true && !includeDisabled) {
			skipped.push({ file, reason: "credential marked disabled (use --include-disabled to import anyway)" });
			continue;
		}
		const provider = resolveCliProxyProvider(json, file, overrideProvider);
		if (!provider) {
			skipped.push({
				file,
				reason: `cannot determine omp provider from type=${json.type ?? "?"} (pass --provider to override)`,
			});
			continue;
		}
		if (!json.access_token || !json.refresh_token) {
			skipped.push({ file, reason: "missing access_token or refresh_token" });
			continue;
		}
		const expiresAt = parseCliProxyExpiry(json.expired);
		if (expiresAt === null) {
			skipped.push({ file, reason: `cannot parse expired=${json.expired ?? "?"}` });
			continue;
		}
		const email = typeof json.email === "string" && json.email.length > 0 ? json.email : null;
		const accountId = typeof json.account_id === "string" && json.account_id.length > 0 ? json.account_id : null;
		const credential: OAuthCredential = {
			type: "oauth",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: expiresAt,
			...(email !== null ? { email } : {}),
			...(accountId !== null ? { accountId } : {}),
		};
		entries.push({
			sourceFile: file,
			provider,
			email,
			accountId,
			expiresAt,
			disabled: json.disabled === true,
			credential,
		});
	}
	return { entries, skipped };
}

function describeImportEntry(entry: ImportPlanEntry): string {
	const ident = entry.email ?? entry.accountId ?? "(no identity)";
	const stale = entry.expiresAt < Date.now() ? " [expired]" : "";
	const disabled = entry.disabled ? " [disabled]" : "";
	return `${entry.provider}: ${ident}${stale}${disabled} from ${entry.sourceFile}`;
}

async function runImport(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const target = flags.source;
	if (!target) {
		throw new Error("Usage: omp auth-broker import <file|dir> [--provider=<id>] [--include-disabled] [--dry-run]");
	}
	const resolvedTarget = path.resolve(target.startsWith("~") ? target.replace(/^~/, os.homedir()) : target);
	const { entries, skipped } = await loadImportPlan(resolvedTarget, flags.provider, flags.includeDisabled === true);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				imported: flags.dryRun
					? []
					: entries.map(e => ({ provider: e.provider, email: e.email, file: e.sourceFile })),
				plan: entries.map(e => ({
					provider: e.provider,
					email: e.email,
					accountId: e.accountId,
					expiresAt: e.expiresAt,
					disabled: e.disabled,
					file: e.sourceFile,
				})),
				skipped,
			})}\n`,
		);
	}

	if (!flags.json) {
		for (const skip of skipped) {
			process.stdout.write(`${chalk.yellow("skip")} ${skip.file}: ${skip.reason}\n`);
		}
	}

	if (entries.length === 0) {
		if (!flags.json) process.stdout.write(`No importable credentials in ${resolvedTarget}.\n`);
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`Dry run — would import ${entries.length} credential(s):\n`);
			for (const entry of entries) process.stdout.write(`  ${describeImportEntry(entry)}\n`);
		}
		return;
	}

	const brokerConfig = await resolveAuthBrokerConfig();
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		for (const entry of entries) {
			try {
				await client.uploadCredential(entry.provider, entry.credential);
				if (!flags.json) {
					process.stdout.write(`${chalk.green("uploaded")} ${describeImportEntry(entry)} → ${brokerConfig.url}\n`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ error: message, file: entry.sourceFile })}\n`);
				} else {
					process.stdout.write(`${chalk.red("failed")} ${describeImportEntry(entry)}: ${message}\n`);
				}
				process.exitCode = 1;
			}
		}
		return;
	}

	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		for (const entry of entries) {
			store.upsertAuthCredentialForProvider(entry.provider, entry.credential);
			if (!flags.json) process.stdout.write(`${chalk.green("imported")} ${describeImportEntry(entry)}\n`);
		}
	} finally {
		store.close();
	}
}

// ─── Migrate: local SQLite + env → broker ──────────────────────────────

interface MigratePlanEntry {
	source: "local-sqlite" | "env";
	provider: string;
	credential: AuthCredential;
	identity: string;
}

interface MigrateSkip {
	source: "local-sqlite" | "env";
	provider: string;
	identity: string;
	reason: string;
}

function credentialIdentity(provider: string, credential: AuthCredential): string {
	if (credential.type === "api_key") return "(api key)";
	return credential.email ?? credential.accountId ?? credential.projectId ?? `<${provider} oauth>`;
}

/**
 * Build the set of "identities already on the broker" so re-runs are idempotent.
 * For OAuth, identity = email|accountId|projectId. For api_key, we collapse
 * to a single marker per provider (broker has no concept of "multiple api keys
 * per provider with different identities"; upsert would coalesce them).
 */
function indexBrokerSnapshot(snapshot: {
	credentials: Array<{
		provider: string;
		credential: { type: string; email?: string; accountId?: string; projectId?: string };
	}>;
}): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const entry of snapshot.credentials) {
		const ids = out.get(entry.provider) ?? new Set<string>();
		if (entry.credential.type === "api_key") {
			ids.add("@api_key");
		} else {
			if (entry.credential.email) ids.add(`email:${entry.credential.email}`);
			if (entry.credential.accountId) ids.add(`accountId:${entry.credential.accountId}`);
			if (entry.credential.projectId) ids.add(`projectId:${entry.credential.projectId}`);
		}
		out.set(entry.provider, ids);
	}
	return out;
}

function brokerAlreadyHas(existing: Map<string, Set<string>>, provider: string, credential: AuthCredential): boolean {
	const ids = existing.get(provider);
	if (!ids) return false;
	if (credential.type === "api_key") return ids.has("@api_key");
	if (credential.email && ids.has(`email:${credential.email}`)) return true;
	if (credential.accountId && ids.has(`accountId:${credential.accountId}`)) return true;
	if (credential.projectId && ids.has(`projectId:${credential.projectId}`)) return true;
	return false;
}

async function runMigrate(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"OMP_AUTH_BROKER_URL must be set (or `auth.broker.url` in config.yml). `migrate` uploads local credentials to a configured broker.",
		);
	}
	if (flags.fromLocal !== true) {
		throw new Error(
			"`omp auth-broker migrate` requires an explicit source. Pass `--from-local` to migrate from the local SQLite store and env vars.",
		);
	}

	const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
	const snapshotResult = await client.fetchSnapshot();
	if (snapshotResult.status !== 200) throw new Error("Auth broker returned no snapshot");
	const existing = indexBrokerSnapshot(snapshotResult.snapshot);

	const plan: MigratePlanEntry[] = [];
	const skipped: MigrateSkip[] = [];

	// 1. Local SQLite rows.
	const localDbPath = getAgentDbPath();
	const localStore = await SqliteAuthCredentialStore.open(localDbPath);
	const plannedApiKeyProviders = new Set<string>();
	try {
		for (const row of localStore.listAuthCredentials()) {
			// Skip placeholder sentinels that pi-ai treats as "authenticated via
			// out-of-band mechanism" (Bedrock/Vertex `<authenticated>`). They
			// aren't real keys and uploading them would store garbage on the
			// broker. Mirrors the env-var path's guard below.
			if (row.credential.type === "api_key" && row.credential.key === "<authenticated>") {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity: "(api key)",
					reason: "placeholder sentinel '<authenticated>' is not a real key",
				});
				continue;
			}
			const identity = credentialIdentity(row.provider, row.credential);
			if (row.credential.type === "oauth" && flags.includeOauth !== true) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "OAuth from local SQLite skipped by default (use --include-oauth)",
				});
				continue;
			}
			if (brokerAlreadyHas(existing, row.provider, row.credential)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "already on broker",
				});
				continue;
			}
			if (row.credential.type === "api_key" && plannedApiKeyProviders.has(row.provider)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "another local api_key for this provider already planned",
				});
				continue;
			}
			if (row.credential.type === "api_key") plannedApiKeyProviders.add(row.provider);
			plan.push({ source: "local-sqlite", provider: row.provider, credential: row.credential, identity });
		}
	} finally {
		localStore.close();
	}

	// 2. Env-var API keys (opt-in).
	if (flags.includeEnv === true) {
		for (const provider of listProvidersWithEnvKey()) {
			const envValue = getEnvApiKey(provider);
			if (!envValue) continue;
			if (envValue === "<authenticated>") continue; // Bedrock/Vertex sentinels — not literal keys.
			const credential: AuthCredential = { type: "api_key", key: envValue };
			if (brokerAlreadyHas(existing, provider, credential)) {
				skipped.push({
					source: "env",
					provider,
					identity: "(api key)",
					reason: "already on broker (provider has an api_key)",
				});
				continue;
			}
			// Also skip if local SQLite already produced an entry for this provider in this batch.
			if (plan.some(p => p.provider === provider && p.credential.type === "api_key")) {
				skipped.push({
					source: "env",
					provider,
					identity: "(api key)",
					reason: "local SQLite already supplied an api_key for this provider",
				});
				continue;
			}
			plan.push({ source: "env", provider, credential, identity: "(api key)" });
		}
	}

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				plan: plan.map(p => ({ source: p.source, provider: p.provider, identity: p.identity })),
				skipped,
			})}\n`,
		);
	} else {
		for (const skip of skipped) {
			process.stdout.write(
				`${chalk.yellow("skip")} [${skip.source}] ${skip.provider} ${skip.identity}: ${skip.reason}\n`,
			);
		}
	}

	if (plan.length === 0) {
		if (!flags.json) process.stdout.write("Nothing to migrate.\n");
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`Dry run — would upload ${plan.length} credential(s):\n`);
			for (const entry of plan) {
				process.stdout.write(`  [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		}
		return;
	}

	for (const entry of plan) {
		try {
			await client.uploadCredential(entry.provider, entry.credential);
			if (!flags.json) {
				process.stdout.write(`${chalk.green("uploaded")} [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ error: message, provider: entry.provider })}\n`);
			} else {
				process.stdout.write(`${chalk.red("failed")} [${entry.source}] ${entry.provider}: ${message}\n`);
			}
			process.exitCode = 1;
		}
	}
}

async function runStatus(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const cfg = await resolveAuthBrokerConfig();
	if (!cfg) {
		const message = "No auth-broker configured (set OMP_AUTH_BROKER_URL to enable).";
		if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: "not_configured" })}\n`);
		else process.stdout.write(`${chalk.yellow(message)}\n`);
		return;
	}
	const client = new AuthBrokerClient({ url: cfg.url, token: cfg.token });
	try {
		const health = await client.healthz();
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ url: cfg.url, ...health })}\n`);
		} else {
			process.stdout.write(`${chalk.green("OK")} ${cfg.url} (version=${health.version ?? "unknown"})\n`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, url: cfg.url, error: message })}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} ${cfg.url}: ${message}\n`);
		}
		process.exitCode = 1;
	}
}

export async function runAuthBrokerCommand(cmd: AuthBrokerCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "login":
			await runLogin(cmd.flags);
			return;
		case "logout":
			await runLogout(cmd.flags);
			return;
		case "import":
			await runImport(cmd.flags);
			return;
		case "migrate":
			await runMigrate(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "list":
			await runList(cmd.flags);
			return;
		default: {
			// Exhaustive check.
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-broker action: ${String(_exhaustive)}`);
		}
	}
}

export { ACTIONS as AUTH_BROKER_ACTIONS };

// Touch `$` so Bun's tree-shaker keeps the shell helper imported (used by future verbs).
void $;
