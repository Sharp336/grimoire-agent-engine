/**
 * `omp auth-gateway` command handlers.
 *
 * Boots a forward-proxy server that lets less-trusted clients (the macOS
 * usage widget, robomp containers, …) make provider API calls without ever
 * seeing the access token. The gateway is itself a broker client and
 * resolves credentials through the configured broker (via the same
 * `OMP_AUTH_BROKER_URL` / `auth.broker.url` precedence used elsewhere).
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the gateway against the configured broker.
 *   - `token` / `token --regenerate` — manages the gateway bearer token file.
 *   - `status` — prints the locally-stored gateway token and bind hint.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	AuthStorage,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	completeSimple,
	DEFAULT_CATALOG_CACHE_TTL_MS,
	type Model,
	type ModelsConfigResponse,
	readAuthBrokerCatalogCache,
	writeAuthBrokerCatalogCache,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker";
import { DEFAULT_AUTH_GATEWAY_BIND, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	buildCustomModelOverlay,
	finalizeCustomModel,
	type ModelPatch,
	mergeCompat,
} from "../config/custom-model-builder";
import type { ProviderAuthMode } from "../config/models-config-schema";
import { settings } from "../config/settings";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthGatewayAction = "serve" | "token" | "status" | "check";

export interface AuthGatewayCommandArgs {
	action: AuthGatewayAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		/**
		 * Disable bearer-token auth on inbound requests. Useful when the gateway
		 * is bound to loopback (the default `127.0.0.1:4000`) and you don't want
		 * to wire token-paste plumbing into every local client.
		 */
		noAuth?: boolean;
		/**
		 * Strict mode for `check` — additionally exercise every credential
		 * against its provider's chat-completion endpoint. The usage probe (run
		 * unconditionally) can pass while the chat endpoint still 401s the same
		 * bearer, so strict mode is the definitive "is this credential
		 * actually usable" signal. Slower and consumes a tiny amount of quota.
		 */
		strict?: boolean;
	};
}

const ACTIONS: readonly AuthGatewayAction[] = ["serve", "token", "status", "check"];

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.token");
}

const DEFAULT_GATEWAY_CATALOG_POLL_INTERVAL_MS = 60_000;

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
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Atomically create the token file, refusing to clobber an existing one.
 * Returns `true` on success, `false` when the file already existed (so the
 * caller re-reads it instead of racing another concurrent `ensureToken`).
 */
async function createTokenExclusive(token: string): Promise<boolean> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		// `wx` = O_CREAT | O_EXCL — fails with EEXIST if the file is already there.
		await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	return true;
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	if (await createTokenExclusive(token)) return token;
	// Another concurrent invocation won the create race; read what they wrote.
	const fromRace = await readToken();
	if (fromRace) return fromRace;
	// File existed-then-disappeared between EEXIST and read; last resort, write
	// our generated token unconditionally so callers don't see an empty string.
	await writeToken(token);
	return token;
}

function createBrokerClient(brokerConfig: AuthBrokerClientConfig): AuthBrokerClient {
	return new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
}

async function fetchBrokerSnapshot(client: AuthBrokerClient): Promise<SnapshotResponse> {
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("Auth broker returned no initial snapshot");
	return result.snapshot;
}

export interface GatewayCatalogConfig {
	enabled: boolean;
	allowedBaseUrls: readonly string[];
}

export type GatewayCatalogModel = Model<Api> & { auth?: "none" };

export interface GatewayModelIndex {
	models: GatewayCatalogModel[];
	byId: Map<string, GatewayCatalogModel>;
}

function addGatewayModel(
	qualifiedModels: Map<string, GatewayCatalogModel>,
	bareModels: Map<string, GatewayCatalogModel>,
	model: GatewayCatalogModel,
): void {
	const key = `${model.provider}/${model.id}`;
	const replacesExistingQualified = qualifiedModels.has(key);
	qualifiedModels.set(key, model);
	if (replacesExistingQualified || !bareModels.has(model.id)) bareModels.set(model.id, model);
}

export function isGatewayCatalogBaseUrlAllowed(baseUrl: string, allowlist: readonly string[]): boolean {
	if (allowlist.length === 0) return true;
	let candidate: URL;
	try {
		candidate = new URL(baseUrl);
	} catch {
		return false;
	}
	return allowlist.some(entry => {
		let allowed: URL;
		try {
			allowed = new URL(entry);
		} catch {
			return false;
		}
		if (candidate.protocol !== allowed.protocol) return false;
		if (candidate.hostname !== allowed.hostname) return false;
		if (candidate.port !== allowed.port) return false;
		const prefix = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
		return candidate.pathname === allowed.pathname || candidate.pathname.startsWith(prefix);
	});
}

function providerHasCredential(snapshot: SnapshotResponse, provider: string): boolean {
	return snapshot.credentials.some(entry => entry.provider === provider);
}

function toModelPatch(
	patch: NonNullable<ModelsConfigResponse["providers"][string]["modelOverrides"]>[string] | undefined,
): ModelPatch | undefined {
	if (!patch) return undefined;
	return {
		name: patch.name,
		reasoning: patch.reasoning,
		thinking: patch.thinking,
		input: patch.input,
		supportsTools: patch.supportsTools,
		cost: patch.cost,
		contextWindow: patch.contextWindow ?? undefined,
		maxTokens: patch.maxTokens ?? undefined,
		omitMaxOutputTokens: patch.omitMaxOutputTokens,
		headers: patch.headers,
		compat: patch.compat,
		contextPromotionTarget: patch.contextPromotionTarget,
		premiumMultiplier: patch.premiumMultiplier,
	};
}

function applyModelPatch(model: GatewayCatalogModel, patch: ModelPatch | undefined): GatewayCatalogModel {
	if (!patch) return model;
	const patched = finalizeCustomModel(
		{
			id: model.id,
			provider: model.provider,
			api: model.api,
			requestModelId: model.requestModelId,
			baseUrl: model.baseUrl,
			name: patch.name ?? model.name,
			reasoning: patch.reasoning ?? model.reasoning,
			thinking: patch.thinking ?? model.thinking,
			input: patch.input ?? model.input,
			supportsTools: patch.supportsTools ?? model.supportsTools,
			cost: patch.cost ? { ...(model.cost ?? {}), ...patch.cost } : model.cost,
			contextWindow: patch.contextWindow ?? model.contextWindow ?? undefined,
			maxTokens: patch.maxTokens ?? model.maxTokens ?? undefined,
			omitMaxOutputTokens: patch.omitMaxOutputTokens ?? model.omitMaxOutputTokens,
			headers: { ...(model.headers ?? {}), ...(patch.headers ?? {}) },
			compat: mergeCompat(model.compatConfig, patch.compat),
			contextPromotionTarget: patch.contextPromotionTarget ?? model.contextPromotionTarget,
			premiumMultiplier: patch.premiumMultiplier ?? model.premiumMultiplier,
			isOAuth: model.isOAuth,
		},
		{ useDefaults: false },
	);
	return model.auth === "none" ? { ...patched, auth: "none" } : patched;
}

export function buildGatewayModelIndex(
	snapshot: SnapshotResponse,
	catalog: ModelsConfigResponse | undefined,
	config: GatewayCatalogConfig,
): GatewayModelIndex {
	const qualifiedModels = new Map<string, GatewayCatalogModel>();
	const bareModels = new Map<string, GatewayCatalogModel>();
	const providersWithCreds = new Set<string>();
	for (const entry of snapshot.credentials) providersWithCreds.add(entry.provider);

	for (const provider of getBundledProviders()) {
		if (!providersWithCreds.has(provider)) continue;
		for (const model of getBundledModels(provider as GeneratedProvider))
			addGatewayModel(qualifiedModels, bareModels, model);
	}

	if (config.enabled && catalog) {
		for (const [provider, providerConfig] of Object.entries(catalog.providers)) {
			if (providerConfig.auth !== "none" && !providerHasCredential(snapshot, provider)) continue;
			if (providerConfig.baseUrl && !isGatewayCatalogBaseUrlAllowed(providerConfig.baseUrl, config.allowedBaseUrls))
				continue;
			const providerCompat = providerConfig.disableStrictTools
				? mergeCompat(providerConfig.compat, { disableStrictTools: true })
				: providerConfig.compat;
			const overrides = providerConfig.modelOverrides ?? {};
			for (const modelDef of providerConfig.models ?? []) {
				const modelBaseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
				if (!modelBaseUrl || !isGatewayCatalogBaseUrlAllowed(modelBaseUrl, config.allowedBaseUrls)) continue;
				const overlay = buildCustomModelOverlay(
					provider,
					modelBaseUrl,
					providerConfig.api,
					providerConfig.headers,
					undefined,
					providerConfig.authHeader,
					providerCompat,
					providerConfig.auth as ProviderAuthMode | undefined,
					{
						id: modelDef.id,
						api: modelDef.api,
						baseUrl: modelDef.baseUrl,
						requestModelId: modelDef.requestModelId,
						name: modelDef.name,
						reasoning: modelDef.reasoning,
						thinking: modelDef.thinking,
						input: modelDef.input,
						supportsTools: modelDef.supportsTools,
						cost: modelDef.cost,
						contextWindow: modelDef.contextWindow ?? undefined,
						maxTokens: modelDef.maxTokens ?? undefined,
						omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
						headers: modelDef.headers,
						compat: mergeCompat(providerCompat, modelDef.compat),
						contextPromotionTarget: modelDef.contextPromotionTarget,
						premiumMultiplier: modelDef.premiumMultiplier,
					},
				);
				if (!overlay) continue;
				const model = finalizeCustomModel(overlay, { useDefaults: true });
				const gatewayModel = providerConfig.auth === "none" ? { ...model, auth: "none" as const } : model;
				addGatewayModel(
					qualifiedModels,
					bareModels,
					applyModelPatch(gatewayModel, toModelPatch(overrides[model.id])),
				);
			}
		}
	}

	const byId = new Map<string, GatewayCatalogModel>();
	for (const [id, model] of qualifiedModels) byId.set(id, model);
	for (const [id, model] of bareModels) if (!byId.has(id)) byId.set(id, model);
	return { models: [...qualifiedModels.values()], byId };
}

function resolveGatewayCatalogConfig(): GatewayCatalogConfig {
	try {
		return {
			enabled: settings.get("auth.broker.catalog.enabled"),
			allowedBaseUrls: settings.get("auth.broker.catalog.allowedBaseUrls"),
		};
	} catch {
		return { enabled: false, allowedBaseUrls: [] };
	}
}

function getGatewayCatalogCachePath(): string {
	return (
		process.env.OMP_AUTH_BROKER_CATALOG_CACHE ?? path.join(getConfigRootDir(), "cache", "auth-broker-catalog.enc")
	);
}

function resolveCatalogCacheTtlMs(): number {
	const raw = process.env.OMP_AUTH_BROKER_CATALOG_TTL_MS;
	if (raw === undefined) return DEFAULT_CATALOG_CACHE_TTL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_CATALOG_CACHE_TTL_MS;
	const ttlMs = Number(value);
	if (Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
	logger.warn("Invalid OMP_AUTH_BROKER_CATALOG_TTL_MS; using default", { value: raw });
	return DEFAULT_CATALOG_CACHE_TTL_MS;
}

function resolveGatewayCatalogPollIntervalMs(): number {
	const raw = process.env.OMP_AUTH_BROKER_CATALOG_POLL_INTERVAL_MS;
	if (raw === undefined) return DEFAULT_GATEWAY_CATALOG_POLL_INTERVAL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_GATEWAY_CATALOG_POLL_INTERVAL_MS;
	const intervalMs = Number(value);
	if (Number.isFinite(intervalMs) && intervalMs >= 0) return intervalMs;
	logger.warn("Invalid OMP_AUTH_BROKER_CATALOG_POLL_INTERVAL_MS; using default", { value: raw });
	return DEFAULT_GATEWAY_CATALOG_POLL_INTERVAL_MS;
}

export interface GatewayCatalogPollingOptions {
	intervalMs: number;
	refresh: () => Promise<void>;
}

export function startGatewayCatalogPolling(opts: GatewayCatalogPollingOptions): (() => void) | undefined {
	if (opts.intervalMs <= 0) return undefined;
	let refreshing = false;
	const timer: NodeJS.Timeout = setInterval(() => {
		if (refreshing) return;
		refreshing = true;
		opts
			.refresh()
			.catch(error => {
				logger.warn("auth-gateway catalog poll refresh failed", { error: String(error) });
			})
			.finally(() => {
				refreshing = false;
			});
	}, opts.intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

async function fetchBrokerCatalogWithCache(
	client: AuthBrokerClient,
	brokerConfig: AuthBrokerClientConfig,
	cachePath: string,
): Promise<ModelsConfigResponse> {
	try {
		const catalog = await client.fetchCatalog();
		void writeAuthBrokerCatalogCache({
			path: cachePath,
			token: brokerConfig.token,
			url: brokerConfig.url,
			catalog,
		}).catch(error => {
			logger.debug("auth-broker catalog cache write failed", { error: String(error) });
		});
		return catalog;
	} catch (error) {
		const ttlMs = resolveCatalogCacheTtlMs();
		const cached =
			ttlMs > 0
				? await readAuthBrokerCatalogCache({
						path: cachePath,
						token: brokerConfig.token,
						url: brokerConfig.url,
						ttlMs,
					}).catch(readError => {
						logger.debug("auth-broker catalog cache read failed", { error: String(readError) });
						return null;
					})
				: null;
		if (cached) return cached;
		throw error;
	}
}

async function fetchBrokerCatalogIfEnabled(
	client: AuthBrokerClient,
	brokerConfig: AuthBrokerClientConfig,
	cachePath: string,
	config: GatewayCatalogConfig,
): Promise<ModelsConfigResponse | undefined> {
	if (!config.enabled) return undefined;
	return fetchBrokerCatalogWithCache(client, brokerConfig, cachePath);
}

export interface GatewayCatalogRefreshStore {
	readonly snapshot: SnapshotResponse;
	refreshSnapshot(): Promise<SnapshotResponse>;
}

export interface GatewayCatalogRefreshOptions {
	catalogConfig: GatewayCatalogConfig;
	store: GatewayCatalogRefreshStore;
	fetchCatalog: () => Promise<ModelsConfigResponse>;
	onCatalog: (catalog: ModelsConfigResponse) => void;
	onModelIndex: (index: GatewayModelIndex) => void;
}

export async function refreshGatewayCatalogIndex(opts: GatewayCatalogRefreshOptions): Promise<void> {
	if (!opts.catalogConfig.enabled) return;
	const [catalog, snapshot] = await Promise.all([opts.fetchCatalog(), opts.store.refreshSnapshot()]);
	opts.onCatalog(catalog);
	opts.onModelIndex(buildGatewayModelIndex(snapshot, catalog, opts.catalogConfig));
}

async function runServe(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`omp auth-gateway serve` requires OMP_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). The gateway is itself a broker client.",
		);
	}
	const bind = flags.bind ?? DEFAULT_AUTH_GATEWAY_BIND;
	const gatewayToken = flags.noAuth ? null : await ensureToken();

	// Build a broker-backed AuthStorage — same pattern as discoverAuthStorage()
	// in sdk.ts. The gateway never touches local SQLite.
	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const catalogConfig = resolveGatewayCatalogConfig();
	const catalogCachePath = getGatewayCatalogCachePath();
	void Bun.file(catalogCachePath)
		.arrayBuffer()
		.catch(() => undefined);
	let currentCatalog = await fetchBrokerCatalogIfEnabled(client, brokerConfig, catalogCachePath, catalogConfig);
	let modelIndex = buildGatewayModelIndex(initialSnapshot, currentCatalog, catalogConfig);
	let store: RemoteAuthCredentialStore;
	const refreshCatalog = async (): Promise<void> => {
		await refreshGatewayCatalogIndex({
			catalogConfig,
			store,
			fetchCatalog: () => fetchBrokerCatalogWithCache(client, brokerConfig, catalogCachePath),
			onCatalog: catalog => {
				currentCatalog = catalog;
			},
			onModelIndex: index => {
				modelIndex = index;
			},
		});
	};
	store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		onSnapshot: snapshot => {
			modelIndex = buildGatewayModelIndex(snapshot, currentCatalog, catalogConfig);
		},
		onCatalogChanged: () => {
			void refreshCatalog().catch(error => {
				logger.warn("auth-gateway catalog refresh failed", { error: String(error) });
			});
		},
	});
	const stopCatalogPolling = catalogConfig.enabled
		? startGatewayCatalogPolling({ intervalMs: resolveGatewayCatalogPollIntervalMs(), refresh: refreshCatalog })
		: undefined;
	// Refresh + usage both flow through the store's broker hooks automatically —
	// `RemoteAuthCredentialStore.refreshOAuthCredential` and `.fetchUsageReports`.
	// AuthStorage discovers them when no explicit option overrides them, so the
	// gateway only needs to construct the store and pass it in.
	const storage = new AuthStorage(store, {
		sourceLabel: `broker ${brokerConfig.url}`,
	});
	await storage.reload();

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelIndex.byId.get(id),
		listModels: () => modelIndex.models,
	});
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	if (gatewayToken) {
		process.stdout.write(`bearer token: ${getTokenFilePath()} (chmod 0600)\n`);
	} else {
		process.stdout.write(`auth: disabled (--no-auth) — any client can call this gateway\n`);
	}
	process.stdout.write(`upstream broker: ${brokerConfig.url}\n`);

	const stopped = Promise.withResolvers<void>();
	let shutdownStarted = false;
	const stop = async (signal: NodeJS.Signals): Promise<void> => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
		let closeError: unknown;
		try {
			stopCatalogPolling?.();
			await handle.close();
		} catch (error) {
			closeError = error;
		} finally {
			storage.close();
		}
		if (closeError) {
			stopped.reject(closeError);
		} else {
			stopped.resolve();
		}
	};
	const onSigint = (): void => {
		void stop("SIGINT");
	};
	const onSigterm = (): void => {
		void stop("SIGTERM");
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	try {
		await stopped.promise;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

async function runToken(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
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

async function runStatus(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const token = await readToken();
	const brokerConfig = await resolveAuthBrokerConfig();
	const tokenFile = getTokenFilePath();
	if (!brokerConfig) {
		const status = {
			ready: false,
			reason: "not_configured",
			tokenFile,
			tokenPresent: token !== null,
			broker: null,
			brokerConfigured: false,
			brokerAuthenticated: false,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.yellow("No broker configured.")} Set OMP_AUTH_BROKER_URL.\n`);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
		return;
	}

	try {
		const snapshot = await fetchBrokerSnapshot(createBrokerClient(brokerConfig));
		const tokenPresent = token !== null;
		const status = {
			ready: tokenPresent,
			reason: tokenPresent ? null : "token_missing",
			tokenFile,
			tokenPresent,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: true,
			credentialCount: snapshot.credentials.length,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const brokerLine = `upstream broker: ${brokerConfig.url} (${snapshot.credentials.length} credential${
				snapshot.credentials.length === 1 ? "" : "s"
			})`;
			process.stdout.write(`${tokenPresent ? chalk.green("ready") : chalk.yellow("not ready")} ${brokerLine}\n`);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
			if (!tokenPresent) {
				process.stdout.write(
					"Run `omp auth-gateway token` or `omp auth-gateway serve` to create a bearer token.\n",
				);
			}
		}
		if (!tokenPresent) process.exitCode = 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = {
			ready: false,
			reason: "broker_unavailable",
			tokenFile,
			tokenPresent: token !== null,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: false,
			error: message,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} upstream broker: ${brokerConfig.url}: ${message}\n`);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
	}
}

export async function runAuthGatewayCommand(cmd: AuthGatewayCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "check":
			await runCheck(cmd.flags);
			return;
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Providers whose chat endpoint expects a JSON-serialized credential blob
 * (`{ token, projectId, refreshToken, expiresAt, … }`) rather than the raw
 * access token. Mirrors `getOAuthApiKey` in `packages/ai/src/registry/oauth`.
 */
const STRUCTURED_API_KEY_PROVIDERS: ReadonlySet<string> = new Set([
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

/**
 * Provider API types that strict-mode chat probes intentionally skip:
 * - `bedrock-converse-stream` resolves credentials from the AWS env/profile, not the broker bearer.
 * - `google-vertex` uses Application Default Credentials; the broker bearer is not the right key.
 * - `cursor-agent` and `pi-native` (gateway forwarding) have transport quirks
 *   that make a bearer-only "ping" a poor signal.
 */
const STRICT_PROBE_SKIPPED_APIS: ReadonlySet<Api> = new Set<Api>([
	"bedrock-converse-stream",
	"google-vertex",
	"cursor-agent",
]);

/** Max chat models to try per credential before reporting failure. */
const STRICT_PROBE_MAX_CANDIDATES = 4;

/** Per-attempt deadline. Each candidate gets its own slice instead of sharing one budget. */
const STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Overall per-credential budget passed to {@link AuthStorage.checkCredentials}.
 * Big enough to walk every candidate at the per-attempt cap with a small
 * margin for refresh/network overhead.
 */
const STRICT_PROBE_OVERALL_TIMEOUT_MS = STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS * (STRICT_PROBE_MAX_CANDIDATES + 1);

/** Match upstream errors that mean "this model is gone, try a different one" so we walk the catalog instead of declaring the credential bad. */
const RETRYABLE_MODEL_ERROR_RE =
	/not[_ -]found|invalid[_ -]model|model[_ -]is[_ -]not[_ -]valid|no longer supported|deprecated|404|decommissioned/i;

/**
 * Rank bundled models for a provider in probe order: cheapest first, then by
 * id for determinism. Filters out non-bearer-auth APIs (Vertex/Bedrock),
 * pi-native transport (would loop through the gateway), and placeholder /
 * router entries with negative/missing cost.
 */
function pickProbeCandidates(provider: string): Model<Api>[] {
	const bundled = getBundledModels(provider as GeneratedProvider);
	if (bundled.length === 0) return [];
	const candidates = bundled.filter(model => {
		if (model.transport === "pi-native") return false;
		if (STRICT_PROBE_SKIPPED_APIS.has(model.api)) return false;
		if (!model.input.includes("text")) return false;
		const totalCost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
		if (!Number.isFinite(totalCost) || totalCost < 0) return false;
		if (model.maxTokens !== null && model.maxTokens <= 0) return false;
		return true;
	});
	candidates.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id));
	return candidates;
}

/**
 * Compose the apiKey bytes a provider's chat endpoint expects, given a
 * post-refresh probe credential. Mirrors `getOAuthApiKey` for the providers
 * that require a structured blob; otherwise returns the raw access token /
 * API key.
 */
function composeProbeApiKey(provider: string, credential: CompletionProbeInput["credential"]): string {
	if (credential.type === "api_key") return credential.apiKey;
	if (!STRUCTURED_API_KEY_PROVIDERS.has(provider)) return credential.accessToken;
	return JSON.stringify({
		token: credential.accessToken,
		enterpriseUrl: credential.enterpriseUrl,
		projectId: credential.projectId,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		email: credential.email,
		accountId: credential.accountId,
	});
}

async function probeOneModel(
	model: Model<Api>,
	apiKey: string,
	outerSignal: AbortSignal,
): Promise<CredentialCompletionResult> {
	const start = Date.now();
	const attemptTimeoutSignal = AbortSignal.timeout(STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS);
	const attemptSignal = AbortSignal.any([outerSignal, attemptTimeoutSignal]);
	// `systemPrompt` is mandatory for some providers (Codex 400s "Instructions
	// are required" without it). `disableReasoning` is intentionally NOT set:
	// providers like Fireworks reject the "none" effort it maps to, and we'd
	// rather burn 16 reasoning tokens than misdiagnose a healthy credential.
	const response = await completeSimple(
		model,
		{
			systemPrompt: ["Connectivity check. Reply with the single word 'pong'."],
			messages: [{ role: "user", content: "ping", timestamp: start }],
		},
		{
			apiKey,
			maxTokens: 32,
			signal: attemptSignal,
		},
	);
	const latencyMs = Date.now() - start;
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			ok: false,
			reason: response.errorMessage ?? `chat probe ended with stopReason=${response.stopReason}`,
			modelId: model.id,
			latencyMs,
		};
	}
	return { ok: true, modelId: model.id, latencyMs };
}

/**
 * Build the {@link CompletionProbe} consumed by
 * {@link AuthStorage.checkCredentials} in `--strict` mode. Walks the cheapest
 * candidates per provider, retrying on "model not found / invalid model"
 * errors so a stale catalog entry doesn't masquerade as a bad credential.
 * Stops as soon as one model returns a successful response (the credential
 * authenticated against at least one model in the catalog).
 */
function createStrictCompletionProbe(): CompletionProbe {
	return async (input: CompletionProbeInput): Promise<CredentialCompletionResult> => {
		const candidates = pickProbeCandidates(input.provider).slice(0, STRICT_PROBE_MAX_CANDIDATES);
		if (candidates.length === 0) {
			return { ok: null, reason: `no bearer-compatible probe model bundled for provider ${input.provider}` };
		}
		const apiKey = composeProbeApiKey(input.provider, input.credential);
		let lastFailure: CredentialCompletionResult | undefined;
		for (const model of candidates) {
			if (input.signal.aborted) {
				return {
					ok: false,
					reason: "aborted",
					modelId: model.id,
				};
			}
			const result = await probeOneModel(model, apiKey, input.signal);
			if (result.ok === true) return result;
			lastFailure = result;
			if (!RETRYABLE_MODEL_ERROR_RE.test(result.reason ?? "")) {
				// Non-model error (401, 403, 5xx, network) — the credential is the
				// issue, not the catalog. Stop walking.
				return result;
			}
		}
		return (
			lastFailure ?? {
				ok: false,
				reason: `all ${candidates.length} probe models failed for provider ${input.provider}`,
			}
		);
	};
}

function formatCompletionStatus(completion: CredentialCompletionResult | undefined): string {
	if (!completion) return "";
	if (completion.ok === true) return chalk.green(" [chat: ok]");
	if (completion.ok === false) return chalk.red(" [chat: FAIL]");
	return chalk.yellow(" [chat: skip]");
}

/**
 * `omp auth-gateway check` — probe each broker-supplied credential and print
 * per-credential auth health. Use this when the gateway is returning 401s and
 * you need to find which row in a multi-account pool is the bad one. The
 * aggregate `/v1/usage` endpoint silently drops failed credentials, so a
 * dedicated diagnostic is the only way to see which credentials failed.
 *
 * Strict mode (`--strict`) additionally exercises each credential against a
 * cheap chat model from its provider's bundled catalog. This catches the case
 * where the usage endpoint reports 200 but the chat endpoint 401s the same
 * bearer (revoked OAuth scope, mislabeled provider row, etc).
 */
async function runCheck(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`omp auth-gateway check` requires OMP_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). It probes the same credentials the gateway would serve.",
		);
	}

	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({ client, initialSnapshot });
	const storage = new AuthStorage(store, { sourceLabel: `broker ${brokerConfig.url}` });
	try {
		await storage.reload();
		const results = await storage.checkCredentials(
			flags.strict
				? { completionProbe: createStrictCompletionProbe(), completionTimeoutMs: STRICT_PROBE_OVERALL_TIMEOUT_MS }
				: undefined,
		);

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({ broker: brokerConfig.url, strict: flags.strict === true, credentials: results }, null, 2)}\n`,
			);
		} else {
			const grouped = new Map<string, typeof results>();
			for (const row of results) {
				const list = grouped.get(row.provider) ?? [];
				list.push(row);
				grouped.set(row.provider, list);
			}
			const providers = [...grouped.keys()].sort();
			process.stdout.write(`broker: ${brokerConfig.url}${flags.strict ? chalk.dim(" [strict]") : ""}\n`);
			for (const provider of providers) {
				const rows = grouped.get(provider) ?? [];
				process.stdout.write(`\n${chalk.bold(provider)} (${rows.length})\n`);
				for (const row of rows) {
					const status =
						row.ok === true
							? chalk.green("ok      ")
							: row.ok === false
								? chalk.red("FAIL    ")
								: chalk.yellow("unknown ");
					const identity =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					const remote = row.remoteRefresh ? chalk.dim(" [remote-refresh]") : "";
					const reasonParts: string[] = [];
					if (row.reason) reasonParts.push(row.reason);
					if (row.completion?.reason) reasonParts.push(`chat: ${row.completion.reason}`);
					const reason = reasonParts.length > 0 ? chalk.dim(` — ${reasonParts.join("; ")}`) : "";
					const chat = formatCompletionStatus(row.completion);
					process.stdout.write(
						`  ${status}${chat} id=${row.id.toString().padStart(3)} ${row.type.padEnd(7)} ${identity}${remote}${reason}\n`,
					);
				}
			}
			const failed = results.filter(row => row.ok === false).length;
			const unverifiable = results.filter(row => row.ok === null).length;
			const passing = results.filter(row => row.ok === true).length;
			const chatFailed = flags.strict ? results.filter(row => row.completion?.ok === false).length : 0;
			const summaryParts = [
				chalk.green(`${passing} ok`),
				chalk.red(`${failed} failed`),
				chalk.yellow(`${unverifiable} unverifiable`),
			];
			if (flags.strict) summaryParts.push(chalk.red(`${chatFailed} chat-failed`));
			summaryParts.push(`${results.length} total`);
			process.stdout.write(`\n${summaryParts.join(", ")}\n`);
			if (failed > 0 || chatFailed > 0) process.exitCode = 1;
		}
	} finally {
		storage.close();
	}
}

export { ACTIONS as AUTH_GATEWAY_ACTIONS };
