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
	assertNoDuplicateJsonKeys,
	assertProviderCallExpectedDynamics,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	completeSimple,
	type FetchImpl,
	FileProviderCallJournal,
	HttpProviderCallAuthority,
	type Model,
	PROVIDER_CALL_ORIGIN_MANIFEST,
	type ProviderCallAuthority,
	type ProviderCallContext,
	type ProviderCallCredential,
	type ProviderCallExpectedDynamics,
	type ProviderCallExpectedDynamicsByConfig,
	type ProviderCallJournal,
	providerCallOriginAssignmentsEqual,
	readStrictOwnedFile,
	resolveProviderCallOriginBinding,
	validateProviderCallOriginAssignment,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	loadAuthBrokerAccountPool,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type CodexAuthorityDelegate,
	type CodexAuthorityDelegation,
	DEFAULT_AUTH_GATEWAY_BIND,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
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

/**
 * How often a long-lived `serve` rebuilds its catalog from the registry so
 * models discovered after boot become routable without a restart. `refresh()`
 * reuses the `models.db` cache and only hits the network when a provider's
 * cached row is stale, so a short interval stays cheap.
 */
const CATALOG_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

interface ProviderCallCredentialBinding {
	accountId: string;
	credentialGeneration: string;
}

export interface ProviderCallRuntime {
	authority: ProviderCallAuthority;
	journal: ProviderCallJournal;
	expectedDynamics: ProviderCallExpectedDynamicsByConfig;
	resolveCredential: (context: ProviderCallContext) => Promise<ProviderCallCredential>;
}

export interface ProviderCallRuntimeOptions {
	journalPath?: string;
	fetch?: FetchImpl;
}

export interface CodexAuthorityRuntime {
	delegate: CodexAuthorityDelegate;
	expectedDynamics: ProviderCallExpectedDynamicsByConfig;
}

export interface CodexAuthorityRuntimeOptions {
	fetch?: FetchImpl;
}

const PROVIDER_CALL_RUNTIME_ENV = [
	"OMP_PROVIDER_CALL_AUTHORITY_URL",
	"OMP_PROVIDER_CALL_AUTHORITY_GATEWAY_TOKEN",
	"OMP_PROVIDER_CALL_EXECUTION_TOKEN",
	"OMP_PROVIDER_CALL_POD_UID",
	"OMP_PROVIDER_CALL_CREDENTIAL_BINDINGS_JSON",
	"OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON",
] as const;

const CODEX_AUTHORITY_RUNTIME_ENV = [
	"OMP_CODEX_AUTHORITY_URL",
	"OMP_CODEX_AUTHORITY_TLS_CA_FILE",
	"OMP_CODEX_AUTHORITY_TLS_CLIENT_CERT_FILE",
	"OMP_CODEX_AUTHORITY_TLS_CLIENT_KEY_FILE",
	"OMP_CODEX_AUTHORITY_TLS_SERVER_NAME",
	"OMP_PROVIDER_CALL_EXECUTION_TOKEN",
	"OMP_CODEX_AUTHORITY_DELEGATION_MANIFESTS_JSON",
	"OMP_PROVIDER_CALL_EXPECTED_DYNAMICS_JSON",
] as const;

function parseProviderCallCredentialBindings(source: string): Map<string, ProviderCallCredentialBinding> {
	const parsed = JSON.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Provider-call credential bindings must be a JSON object");
	}
	const result = new Map<string, ProviderCallCredentialBinding>();
	for (const [configId, value] of Object.entries(parsed)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Provider-call credential binding ${configId} must be an object`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.length !== 2 ||
			keys[0] !== "account_id" ||
			keys[1] !== "credential_generation" ||
			typeof record.account_id !== "string" ||
			!record.account_id.trim() ||
			typeof record.credential_generation !== "string" ||
			!record.credential_generation.trim()
		) {
			throw new Error(`Provider-call credential binding ${configId} is invalid`);
		}
		result.set(configId, {
			accountId: record.account_id,
			credentialGeneration: record.credential_generation,
		});
	}
	return result;
}

function parseExpectedProviderCallDynamics(source: string): ProviderCallExpectedDynamicsByConfig {
	assertNoDuplicateJsonKeys(source);
	const parsed = JSON.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Provider-call expected dynamics must be a JSON object");
	}
	const result: Record<string, ProviderCallExpectedDynamics> = {};
	for (const [configId, value] of Object.entries(parsed)) {
		resolveProviderCallOriginBinding(configId, 0);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Provider-call expected dynamics ${configId} must be an object`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.join("\0") !==
				[
					"capability_generation",
					"credential_generation",
					"restricted_proxy_policy_sha256",
					"source_release_digest",
				].join("\0") ||
			typeof record.capability_generation !== "string" ||
			!/^[a-z0-9][a-z0-9._-]*$/.test(record.capability_generation) ||
			typeof record.credential_generation !== "string" ||
			!/^[a-z0-9][a-z0-9._-]*$/.test(record.credential_generation) ||
			typeof record.source_release_digest !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(record.source_release_digest) ||
			typeof record.restricted_proxy_policy_sha256 !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(record.restricted_proxy_policy_sha256)
		) {
			throw new Error(`Provider-call expected dynamics ${configId} is invalid`);
		}
		result[configId] = {
			capability_generation: record.capability_generation,
			credential_generation: record.credential_generation,
			source_release_digest: record.source_release_digest,
			restricted_proxy_policy_sha256: record.restricted_proxy_policy_sha256,
		};
	}
	return Object.freeze(result);
}

interface CodexDelegationManifest {
	schema: "terminal-bench/provider-delegation-manifest/v1";
	config_id: string;
	incoming_semantic_api_family: "openai-completions";
	physical_api_family: "openai-responses";
	translation_contract_sha256: string;
	logical_model_selector: string;
	physical_model_id: "gpt-5.6-sol";
}

function parseCodexDelegationManifests(source: string): Readonly<Record<string, CodexDelegationManifest>> {
	assertNoDuplicateJsonKeys(source);
	const parsed = JSON.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Codex authority delegation manifests must be a JSON object");
	}
	const gptBindings = PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "gpt-proxy");
	const expectedIds = new Set(gptBindings.map(binding => binding.configId));
	const actualIds = Object.keys(parsed);
	if (actualIds.length !== expectedIds.size || actualIds.some(configId => !expectedIds.has(configId))) {
		throw new Error("Codex authority delegation manifests must contain exactly the 20 frozen GPT configs");
	}
	const result: Record<string, CodexDelegationManifest> = {};
	for (const binding of gptBindings) {
		const value = (parsed as Record<string, unknown>)[binding.configId];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Codex authority delegation manifest ${binding.configId} must be an object`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.join("\0") !==
				[
					"config_id",
					"incoming_semantic_api_family",
					"logical_model_selector",
					"physical_api_family",
					"physical_model_id",
					"schema",
					"translation_contract_sha256",
				].join("\0") ||
			record.schema !== "terminal-bench/provider-delegation-manifest/v1" ||
			record.config_id !== binding.configId ||
			record.incoming_semantic_api_family !== "openai-completions" ||
			record.physical_api_family !== "openai-responses" ||
			record.logical_model_selector !== binding.modelSelector ||
			record.physical_model_id !== "gpt-5.6-sol" ||
			typeof record.translation_contract_sha256 !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(record.translation_contract_sha256)
		) {
			throw new Error(`Codex authority delegation manifest ${binding.configId} is invalid`);
		}
		result[binding.configId] = Object.freeze({
			schema: "terminal-bench/provider-delegation-manifest/v1",
			config_id: binding.configId,
			incoming_semantic_api_family: "openai-completions",
			physical_api_family: "openai-responses",
			translation_contract_sha256: record.translation_contract_sha256,
			logical_model_selector: binding.modelSelector,
			physical_model_id: "gpt-5.6-sol",
		});
	}
	return Object.freeze(result);
}

async function readProjectedPem(filePath: string, label: string): Promise<string> {
	const bytes = await readStrictOwnedFile(filePath, { mode: 0o600, maxBytes: 256 * 1024, label });
	const pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (
		!pem ||
		pem.includes("\0") ||
		!/-----BEGIN (?:CERTIFICATE|[^-]*PRIVATE KEY)-----/.test(pem) ||
		!/-----END (?:CERTIFICATE|[^-]*PRIVATE KEY)-----/.test(pem)
	) {
		throw new Error(`${label} is not a non-empty canonical PEM file`);
	}
	return pem;
}

function wireDimensions(context: ProviderCallContext): Array<Record<string, string | null>> {
	return context.expectedDimensions.map(dimension => ({
		dimension: dimension.dimension,
		window_id: dimension.windowId,
		amount: dimension.amount,
		unit_scale: dimension.unitScale,
		window_start: dimension.windowStart,
		window_end: dimension.windowEnd,
	}));
}

async function readBoundedCodexError(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let source = "";
	let bytes = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > 64 * 1024) {
			await reader.cancel();
			throw new Error("Codex authority error response exceeds the closed envelope limit");
		}
		source += decoder.decode(next.value, { stream: true });
	}
	source += decoder.decode();
	return source;
}

async function validateCodexAuthorityResponse(response: Response): Promise<Response> {
	if (response.headers.has("location") || (response.status >= 300 && response.status < 400)) {
		await response.body?.cancel();
		throw new Error("Codex authority redirects are forbidden");
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (response.status === 200) {
		if (contentType !== "text/event-stream" || !response.body) {
			await response.body?.cancel();
			throw new Error("Codex authority success response is not the closed SSE envelope");
		}
		return response;
	}
	if (response.status === 204) {
		if (contentType || response.body) {
			await response.body?.cancel();
			throw new Error("Codex authority completed response must be bodyless");
		}
		return response;
	}
	if (![400, 401, 403, 405, 413, 415, 502, 503].includes(response.status) || contentType !== "application/json") {
		await response.body?.cancel();
		throw new Error(`Codex authority returned an invalid closed response status ${response.status}`);
	}
	const source = await readBoundedCodexError(response);
	assertNoDuplicateJsonKeys(source);
	const decoded = JSON.parse(source) as unknown;
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || Object.keys(decoded).join() !== "error") {
		throw new Error("Codex authority returned an invalid error envelope");
	}
	const error = (decoded as Record<string, unknown>).error;
	if (!error || typeof error !== "object" || Array.isArray(error)) {
		throw new Error("Codex authority returned an invalid error envelope");
	}
	const fields = Object.keys(error).sort();
	const record = error as Record<string, unknown>;
	if (
		fields.join("\0") !== ["code", "message", "type"].join("\0") ||
		typeof record.message !== "string" ||
		!record.message ||
		typeof record.type !== "string" ||
		!record.type ||
		record.code !== record.type
	) {
		throw new Error("Codex authority returned an invalid error envelope");
	}
	return new Response(source, { status: response.status, headers: { "content-type": "application/json" } });
}

function oauthBearerToken(source: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return source;
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		for (const key of ["token", "accessToken", "access_token", "access"]) {
			const value = (parsed as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	throw new Error("Projected OAuth credential JSON has no bearer token");
}
async function readProjectedAuthorityToken(filePath: string, label: string): Promise<string> {
	const bytes = await readStrictOwnedFile(filePath, { mode: 0o600, maxBytes: 16 * 1024, label });
	const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
	if (!token || /\s/.test(token)) throw new Error(`${label} must contain exactly one non-empty token`);
	return token;
}

/**
 * Constructs the complete strict provider-call runtime only when all projected
 * authority inputs are present. Partial configuration fails boot rather than
 * leaving a production gateway that can parse strict requests but never run one.
 */
export function createProviderCallRuntimeFromEnv(
	env: Record<string, string | undefined> = process.env,
	options: ProviderCallRuntimeOptions = {},
): ProviderCallRuntime | undefined {
	const configured = PROVIDER_CALL_RUNTIME_ENV.map(name => env[name]?.trim() ?? "");
	if ([configured[0], configured[1], configured[3], configured[4]].every(value => value === "")) return undefined;
	if (configured.some(value => value === "")) {
		throw new Error("Incomplete provider-call authority configuration");
	}
	const [baseUrl, gatewayTokenFile, executionTokenFile, podUid, bindingsJson, expectedDynamicsJson] = configured;
	const bindings = parseProviderCallCredentialBindings(bindingsJson);
	const expectedDynamics = parseExpectedProviderCallDynamics(expectedDynamicsJson);
	for (const [configId, binding] of bindings) {
		const expected = expectedDynamics[configId];
		if (!expected || expected.credential_generation !== binding.credentialGeneration) {
			throw new Error(`Provider-call expected dynamics are missing or divergent for ${configId}`);
		}
	}
	const authority = new HttpProviderCallAuthority({
		baseUrl,
		getGatewayToken: () => readProjectedAuthorityToken(gatewayTokenFile, "Provider-call gateway token"),
		getExecutionToken: () => readProjectedAuthorityToken(executionTokenFile, "Provider-call execution token"),
		fetch: options.fetch,
	});
	const journal = new FileProviderCallJournal(
		options.journalPath ?? path.join(getConfigRootDir(), "provider-call-journal.json"),
		{ expectedPodUid: podUid },
	);
	return {
		authority,
		journal,
		expectedDynamics,
		async resolveCredential(context) {
			const assignment = validateProviderCallOriginAssignment(context.originAssignment);
			const manifest = resolveProviderCallOriginBinding(assignment.config_id, assignment.route_ordinal);
			if (
				context.configId !== assignment.config_id ||
				context.credentialGeneration !== assignment.credential_generation ||
				manifest.provider !== context.provider ||
				manifest.modelId !== context.modelId ||
				manifest.apiFamily !== context.apiFamily
			) {
				throw new Error(`Provider-call credential manifest identity mismatch for ${context.configId}`);
			}
			if (manifest.authorityOwner !== "generic-omp-auth-gateway" || !manifest.credential) {
				throw new Error("GPT credentials are held only by the dedicated Codex authority backend");
			}
			assertProviderCallExpectedDynamics(assignment, expectedDynamics[assignment.config_id]);
			const binding = bindings.get(context.configId);
			if (!binding) throw new Error(`Provider-call credential binding is missing for ${context.configId}`);
			if (binding.accountId !== context.accountId) throw new Error("Provider-call credential account mismatch");
			if (binding.credentialGeneration !== context.credentialGeneration) {
				throw new Error("Provider-call credential generation mismatch");
			}
			const source = env[manifest.credential.environmentVariable]?.trim();
			if (!source) {
				throw new Error(
					`Provider-call credential environment ${manifest.credential.environmentVariable} is unavailable`,
				);
			}
			return {
				accountId: binding.accountId,
				credentialGeneration: binding.credentialGeneration,
				apiKey: source,
				bearerToken: manifest.credential.mechanism === "oauth-bearer" ? oauthBearerToken(source) : source,
			};
		},
	};
}

export function createCodexAuthorityRuntimeFromEnv(
	env: Record<string, string | undefined> = process.env,
	options: CodexAuthorityRuntimeOptions = {},
): CodexAuthorityRuntime | undefined {
	const configured = CODEX_AUTHORITY_RUNTIME_ENV.map(name => env[name]?.trim() ?? "");
	if ([...configured.slice(0, 5), configured[6]].every(value => value === "")) return undefined;
	if (configured.some(value => value === "")) throw new Error("Incomplete Codex authority configuration");
	const [
		baseUrl,
		caFile,
		clientCertFile,
		clientKeyFile,
		serverName,
		executionTokenFile,
		manifestsJson,
		expectedDynamicsJson,
	] = configured;
	let endpoint: URL;
	try {
		endpoint = new URL(baseUrl);
	} catch {
		throw new Error("Codex authority URL is invalid");
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== "/v1/authority/openai-completions" ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.hostname !== serverName
	) {
		throw new Error("Codex authority URL/server identity must be the exact reviewed HTTPS endpoint");
	}
	const manifests = parseCodexDelegationManifests(manifestsJson);
	const expectedDynamics = parseExpectedProviderCallDynamics(expectedDynamicsJson);
	const gptBindings = PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "gpt-proxy");
	for (const binding of gptBindings) {
		if (!expectedDynamics[binding.configId]) {
			throw new Error(`Codex authority expected dynamics are missing for ${binding.configId}`);
		}
	}
	const transport = options.fetch ?? coworkFetch;
	const delegate: CodexAuthorityDelegate = async (delegation: CodexAuthorityDelegation) => {
		const assignment = validateProviderCallOriginAssignment(delegation.assignment);
		const binding = resolveProviderCallOriginBinding(assignment.config_id, assignment.route_ordinal);
		if (
			delegation.authorityOwner !== "dedicated-codex-backend" ||
			binding.authorityOwner !== "dedicated-codex-backend" ||
			delegation.model.provider !== "gpt-proxy" ||
			delegation.model.id !== "gpt-5.6-sol"
		) {
			throw new Error("Codex authority delegation is not a frozen GPT route");
		}
		assertProviderCallExpectedDynamics(assignment, expectedDynamics[assignment.config_id]);
		const context = delegation.parsed.options.providerCallContext;
		if (!context || context.originAssignment !== delegation.assignment) {
			throw new Error("Codex authority delegation lost the exact parsed assignment identity");
		}
		assertNoDuplicateJsonKeys(delegation.rawRequestBody);
		const raw = JSON.parse(delegation.rawRequestBody) as Record<string, unknown>;
		const rawOptions =
			raw && typeof raw === "object" && !Array.isArray(raw) && raw.options && typeof raw.options === "object"
				? (raw.options as Record<string, unknown>)
				: undefined;
		const rawContext =
			rawOptions?.providerCallContext &&
			typeof rawOptions.providerCallContext === "object" &&
			!Array.isArray(rawOptions.providerCallContext)
				? (rawOptions.providerCallContext as Record<string, unknown>)
				: undefined;
		const rawOriginAssignment = validateProviderCallOriginAssignment(rawContext?.originAssignment);
		if (!providerCallOriginAssignmentsEqual(rawOriginAssignment, assignment)) {
			throw new Error("Codex authority raw request assignment evidence mismatch");
		}
		const codex = context.codexAuthority;
		const codexKeys = codex && typeof codex === "object" && !Array.isArray(codex) ? Object.keys(codex).sort() : [];
		if (
			!codex ||
			codexKeys.join("\0") !==
				[
					"assignedAt",
					"capabilitySetId",
					"logicalBodyBase64",
					"logicalContentType",
					"logicalHeaders",
					"providerRouteAssignmentId",
					"solverEpoch",
					"translationContractSha256",
				].join("\0")
		) {
			throw new Error("Codex authority controller envelope evidence is missing or open");
		}
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
		const assignmentSha256 = context.assignmentSha256;
		const manifest = manifests[assignment.config_id];
		if (
			!manifest ||
			!uuid.test(codex.providerRouteAssignmentId) ||
			!uuid.test(codex.capabilitySetId) ||
			!/^[1-9][0-9]*$/.test(codex.solverEpoch) ||
			!timestamp.test(codex.assignedAt) ||
			!/^sha256:[0-9a-f]{64}$/.test(assignmentSha256) ||
			codex.translationContractSha256 !== manifest.translation_contract_sha256 ||
			codex.logicalContentType !== "application/json"
		) {
			throw new Error("Codex authority controller envelope evidence mismatch");
		}
		const logicalHeaderKeys = Object.keys(codex.logicalHeaders).sort();
		if (
			logicalHeaderKeys.some(name => name !== "accept" && name !== "content-type") ||
			codex.logicalHeaders["content-type"] !== "application/json" ||
			(codex.logicalHeaders.accept !== undefined && codex.logicalHeaders.accept !== "text/event-stream")
		) {
			throw new Error("Codex authority logical headers are not the closed reviewed set");
		}
		let logicalBytes: Buffer;
		try {
			logicalBytes = Buffer.from(codex.logicalBodyBase64, "base64");
			if (logicalBytes.toString("base64") !== codex.logicalBodyBase64) throw new Error("noncanonical base64");
			const logicalSource = new TextDecoder("utf-8", { fatal: true }).decode(logicalBytes);
			assertNoDuplicateJsonKeys(logicalSource);
			JSON.parse(logicalSource);
		} catch {
			throw new Error("Codex authority logical body is not canonical base64 UTF-8 JSON");
		}
		const delegationManifestSha256 = `sha256:${crypto
			.createHash("sha256")
			.update(JSON.stringify(manifest))
			.digest("hex")}`;
		const envelope = {
			schema: "terminal-bench/codex-authority-worker-call/v1",
			task_reservation_id: context.taskReservationId,
			provider_route_assignment_id: codex.providerRouteAssignmentId,
			execution_binding_id: context.executionBindingId,
			pod_uid: context.podUid,
			call_sequence: context.callSequence,
			idempotency_key: context.idempotencyKey,
			provider: context.provider,
			delegation_manifest: manifest,
			delegation_manifest_sha256: delegationManifestSha256,
			incoming_semantic_api_family: "openai-completions",
			account_id: context.accountId,
			model_id: context.modelId,
			capability_set_id: codex.capabilitySetId,
			capability_id: context.capabilityId,
			snapshot_id: context.snapshotId,
			translation_contract_sha256: codex.translationContractSha256,
			solver_epoch: codex.solverEpoch,
			assignment_sha256: assignmentSha256,
			assigned_at: codex.assignedAt,
			tokenizer_contract_sha256: context.tokenizerContractSha256,
			expected_dimensions: wireDimensions(context),
			logical_content_type: codex.logicalContentType,
			logical_headers: codex.logicalHeaders,
			logical_body_base64: codex.logicalBodyBase64,
			...assignment,
		};
		const [ca, cert, key, executionToken] = await Promise.all([
			readProjectedPem(caFile, "Codex authority server CA"),
			readProjectedPem(clientCertFile, "Codex authority client certificate"),
			readProjectedPem(clientKeyFile, "Codex authority client key"),
			readProjectedAuthorityToken(executionTokenFile, "Codex authority execution token"),
		]);
		const init = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-terminal-bench-execution-token": executionToken,
			},
			body: JSON.stringify(envelope),
			redirect: "manual",
			tls: { ca, cert, key, rejectUnauthorized: true, serverName },
		} satisfies RequestInit & {
			tls: {
				ca: string;
				cert: string;
				key: string;
				rejectUnauthorized: true;
				serverName: string;
			};
		};
		const response = await transport(endpoint, init);
		return validateCodexAuthorityResponse(response);
	};
	return { delegate, expectedDynamics };
}
/**
 * Index generic models only when the broker holds their credentials. Dedicated
 * GPT routes are indexed by every frozen config selector only when the Codex
 * authority runtime is fully configured; no generic GPT credential is needed.
 */
export function indexModelsByRequestId(
	models: readonly Model<Api>[],
	providersWithCreds: ReadonlySet<string>,
	frozenGptDelegationEnabled = false,
): Map<string, Model<Api>> {
	const modelById = new Map<string, Model<Api>>();
	for (const model of models) {
		if (model.provider === "gpt-proxy" || !providersWithCreds.has(model.provider)) continue;
		modelById.set(`${model.provider}/${model.id}`, model);
		if (!modelById.has(model.id)) modelById.set(model.id, model);
	}
	if (frozenGptDelegationEnabled) {
		const gptModel = models.find(
			model => model.provider === "gpt-proxy" && model.api === "openai-completions" && model.id === "gpt-5.6-sol",
		);
		if (!gptModel) throw new Error("Frozen GPT model is unavailable for dedicated Codex delegation");
		for (const binding of PROVIDER_CALL_ORIGIN_MANIFEST.routes) {
			if (binding.provider === "gpt-proxy") modelById.set(binding.configId, gptModel);
		}
	}
	return modelById;
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
	const providerCallRuntime = createProviderCallRuntimeFromEnv();
	const codexAuthorityRuntime = createCodexAuthorityRuntimeFromEnv();
	const expectedProviderCallDynamics: Record<string, ProviderCallExpectedDynamics> = {};
	for (const source of [providerCallRuntime?.expectedDynamics, codexAuthorityRuntime?.expectedDynamics]) {
		for (const [configId, value] of Object.entries(source ?? {})) {
			const prior = expectedProviderCallDynamics[configId];
			if (prior && JSON.stringify(prior) !== JSON.stringify(value)) {
				throw new Error(`Provider-call expected dynamics disagree across runtimes for ${configId}`);
			}
			expectedProviderCallDynamics[configId] = value;
		}
	}
	if (providerCallRuntime) {
		try {
			await providerCallRuntime.journal.recoverPendingReceipts(providerCallRuntime.authority);
		} catch (error) {
			await providerCallRuntime.journal.close();
			throw error;
		}
	}

	// Build a broker-backed AuthStorage — same pattern as discoverAuthStorage()
	// in sdk.ts. The gateway never touches local SQLite.
	const accountPool = await loadAuthBrokerAccountPool();
	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		accountPool,
	});
	// Refresh + usage both flow through the store's broker hooks automatically —
	// `RemoteAuthCredentialStore.refreshOAuthCredential` and `.fetchUsageReports`.
	// AuthStorage discovers them when no explicit option overrides them, so the
	// gateway only needs to construct the store and pass it in.
	const storage = new AuthStorage(store, {
		sourceLabel: `broker ${brokerConfig.url}`,
	});
	await storage.reload();

	// Build the model resolver + catalog from the ModelRegistry — the same
	// component the TUI/CLI use — scoped to providers we hold credentials for.
	// `getAll()` is a superset of the bundled catalog (bundled first, then
	// cached + broker-discovered), so the discovery-only models omp itself
	// reaches become routable through the gateway instead of freezing on the
	// compiled snapshot. `ignoreLocalModelConfig` keeps the host's `models.yml`
	// out of the picture: client-side provider overrides (baseUrl/apiKey/headers/
	// transport) and custom models must never route a broker-backed gateway or
	// shadow broker credentials. Format handlers ask `resolveModel` to translate
	// a client-requested `model` field into a pi-ai `Model<Api>` before dispatch;
	// `listModels` powers `/v1/models`.
	const snapshot = storage.exportSnapshot();
	const providersWithCreds = new Set<string>();
	for (const entry of snapshot.credentials) providersWithCreds.add(entry.provider);
	const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true });
	await registry.refresh();
	let modelById = indexModelsByRequestId(registry.getAll(), providersWithCreds, codexAuthorityRuntime !== undefined);

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelById.get(id),
		listModels: () => modelById.values(),
		expectedProviderCallDynamics:
			Object.keys(expectedProviderCallDynamics).length > 0 ? expectedProviderCallDynamics : undefined,
		delegateCodexProviderCall: codexAuthorityRuntime?.delegate,
	});
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	if (gatewayToken) {
		process.stdout.write(`bearer token: ${getTokenFilePath()} (chmod 0600)\n`);
	} else {
		process.stdout.write(`auth: disabled (--no-auth) — any client can call this gateway\n`);
	}
	process.stdout.write(`upstream broker: ${brokerConfig.url}\n`);

	// `serve` is long-lived: rebuild the catalog periodically so models
	// discovered after boot become routable without a restart. A failed refresh
	// keeps serving the previous catalog. `unref()` so the timer never keeps the
	// process alive on its own.
	const catalogRefresh = setInterval(() => {
		void registry
			.refresh()
			.then(() => {
				modelById = indexModelsByRequestId(
					registry.getAll(),
					providersWithCreds,
					codexAuthorityRuntime !== undefined,
				);
			})
			.catch(error => {
				logger.warn("auth-gateway catalog refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}, CATALOG_REFRESH_INTERVAL_MS);
	catalogRefresh.unref();

	const stopped = Promise.withResolvers<void>();
	let shutdownStarted = false;
	const stop = async (signal: NodeJS.Signals): Promise<void> => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
		clearInterval(catalogRefresh);
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		}
		try {
			await providerCallRuntime?.journal.close();
		} catch (error) {
			closeError ??= error;
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

	const accountPool = await loadAuthBrokerAccountPool();
	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		accountPool,
	});
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
					const base =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					// Two subscriptions (orgs) can share one email — without the org a
					// failed row can't say which subscription needs re-login.
					const org = row.orgName ?? row.orgId;
					const identity = org && org !== base ? `${base} (${org})` : base;
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
