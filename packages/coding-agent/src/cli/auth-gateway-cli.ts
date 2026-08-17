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
import * as net from "node:net";
import * as path from "node:path";
import {
	type Api,
	AuthStorage,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	completeSimple,
	type Model,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	loadAuthBrokerAccountPool,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthGatewayAuthorizationDecision,
	type AuthGatewayAuthorizationRequest,
	type AuthGatewayObservation,
	DEFAULT_AUTH_GATEWAY_BIND,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
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
		policySocket?: string;
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

const AUTH_GATEWAY_POLICY_PROTOCOL_VERSION = 1;
const DEFAULT_POLICY_SOCKET_TIMEOUT_MS = 2_000;
const DEFAULT_POLICY_SOCKET_MAX_FRAME_BYTES = 64 * 1024;
const MAX_POLICY_SOCKET_TIMEOUT_MS = 30_000;
const MAX_POLICY_SOCKET_FRAME_BYTES = 1024 * 1024;

interface AuthGatewayPolicySocketClientOptions {
	timeoutMs?: number;
	maxFrameBytes?: number;
}

/**
 * Opt-in policy transport. Authorization opens one framed socket session per
 * gateway request; ordered content-free observations reuse it until denial,
 * error, or terminal settlement closes the session.
 */
export interface AuthGatewayPolicySocketClient {
	authorizeRequest(request: AuthGatewayAuthorizationRequest): Promise<AuthGatewayAuthorizationDecision>;
	observe(observation: AuthGatewayObservation): Promise<void>;
	probe(signal?: AbortSignal): Promise<boolean>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is Record<string, unknown> {
	if (!isJsonObject(value)) return false;
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	if (keys.length < required.length || keys.length > allowed.size) return false;
	for (const key of required) {
		if (!Object.hasOwn(value, key)) return false;
	}
	for (const key of keys) {
		if (!allowed.has(key)) return false;
	}
	return true;
}

function parsePolicyDecision(value: unknown): AuthGatewayAuthorizationDecision {
	if (hasExactKeys(value, ["authorized"], ["reasonCode"]) && value.authorized === false) {
		return value as unknown as AuthGatewayAuthorizationDecision;
	}
	if (
		hasExactKeys(value, [
			"authorized",
			"authorizationId",
			"requestedModelId",
			"resolvedModelId",
			"sessionId",
			"allowedOAuthCredentialIds",
		]) &&
		value.authorized === true
	) {
		return value as unknown as AuthGatewayAuthorizationDecision;
	}
	throw new Error("Gateway policy socket returned an invalid authorization decision");
}

function validatePositiveBoundedInteger(value: number, maximum: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
	}
}

export function validateAuthGatewayPolicySocketPath(socketPath: string): void {
	if (socketPath.length === 0 || socketPath.includes("\0") || !path.isAbsolute(socketPath)) {
		throw new Error("--policy-socket must be a non-empty absolute path without NUL bytes");
	}
	if (process.platform === "win32") {
		throw new Error("--policy-socket is only supported on Unix platforms");
	}
}

async function validatePolicySocketTrustAnchor(socketPath: string): Promise<string> {
	const effectiveUid = process.geteuid?.();
	if (effectiveUid === undefined) {
		throw new Error("Gateway policy socket ownership cannot be verified on this platform");
	}
	const socketStat = await fs.lstat(socketPath);
	if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
		throw new Error("Gateway policy socket path must name a Unix socket, not a symlink");
	}
	if (socketStat.uid !== effectiveUid) {
		throw new Error("Gateway policy socket must be owned by the current effective user");
	}

	const socketName = path.basename(socketPath);
	const canonicalParent = await fs.realpath(path.dirname(socketPath));
	const canonicalSocketStat = await fs.lstat(path.join(canonicalParent, socketName));
	if (canonicalSocketStat.dev !== socketStat.dev || canonicalSocketStat.ino !== socketStat.ino) {
		throw new Error("Gateway policy socket changed during trust validation");
	}
	let ancestor = canonicalParent;
	for (;;) {
		const stat = await fs.lstat(ancestor);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error("Gateway policy socket ancestor chain is not directory-only");
		}
		if (stat.uid !== effectiveUid && stat.uid !== 0) {
			throw new Error("Gateway policy socket ancestors must be owned by the current effective user or root");
		}
		const isGroupOrWorldWritable = (stat.mode & 0o022) !== 0;
		const hasStickyBit = (stat.mode & 0o1000) !== 0;
		if (isGroupOrWorldWritable && !hasStickyBit) {
			throw new Error("Gateway policy socket ancestor chain contains an unsafe writable directory");
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}

	// Node/Bun does not expose Unix peer credentials for net.Socket. This
	// validates the filesystem trust anchor immediately before each connect;
	// it intentionally does not claim kernel-authenticated peer identity.
	return path.join(canonicalParent, socketName);
}

interface PendingPolicySocketExchange {
	deferred: PromiseWithResolvers<unknown>;
	encoded: Buffer;
	chunks: Buffer[];
	payloadBytes: number;
	maxFrameBytes: number;
	sent: boolean;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort: () => void;
}

class PolicySocketConnection {
	readonly #socket = new net.Socket();
	#pending: PendingPolicySocketExchange | undefined;
	#closedError: Error | undefined;
	#connectStarted = false;
	readonly #socketPath: string;
	readonly #timeoutMs: number;

	constructor(socketPath: string, timeoutMs: number) {
		this.#socketPath = socketPath;
		this.#timeoutMs = timeoutMs;
		this.#socket.setNoDelay(true);
		this.#socket.on("connect", () => this.#sendPending());
		this.#socket.on("data", chunk => this.#handleData(chunk));
		this.#socket.on("error", () => this.#fail(new Error("Gateway policy socket is unavailable")));
		this.#socket.on("end", () => this.#fail(new Error("Gateway policy socket closed before a complete response")));
		this.#socket.on("close", () => this.#fail(new Error("Gateway policy socket closed before a complete response")));
	}

	async exchange(request: Record<string, unknown>, maxFrameBytes: number, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) return Promise.reject(new Error("Gateway policy socket exchange aborted"));
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (this.#pending) return Promise.reject(new Error("Gateway policy socket exchange is already in progress"));
		if (!this.#connectStarted) {
			let canonicalSocketPath: string;
			try {
				canonicalSocketPath = await validatePolicySocketTrustAnchor(this.#socketPath);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error("Gateway policy socket trust validation failed");
				this.#fail(failure);
				throw failure;
			}
			if (signal?.aborted) throw new Error("Gateway policy socket exchange aborted");
			this.#connectStarted = true;
			this.#socket.connect({ path: canonicalSocketPath });
		}

		const encoded = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
		if (encoded.byteLength - 1 > maxFrameBytes) {
			return Promise.reject(new Error("Gateway policy socket request exceeds the frame limit"));
		}

		const deferred = Promise.withResolvers<unknown>();
		const onAbort = (): void => this.#fail(new Error("Gateway policy socket exchange aborted"));
		const pending: PendingPolicySocketExchange = {
			deferred,
			encoded,
			chunks: [],
			payloadBytes: 0,
			maxFrameBytes,
			sent: false,
			timer: setTimeout(() => this.#fail(new Error("Gateway policy socket exchange timed out")), this.#timeoutMs),
			signal,
			onAbort,
		};
		this.#pending = pending;
		signal?.addEventListener("abort", pending.onAbort, { once: true });
		if (signal?.aborted) {
			pending.onAbort();
		} else {
			this.#sendPending();
		}
		return deferred.promise;
	}

	close(): void {
		this.#fail(new Error("Gateway policy socket connection closed"));
	}

	#sendPending(): void {
		const pending = this.#pending;
		if (!pending || pending.sent || this.#socket.connecting || this.#socket.destroyed) return;
		pending.sent = true;
		try {
			this.#socket.write(pending.encoded);
		} catch {
			this.#fail(new Error("Gateway policy socket write failed"));
		}
	}

	#handleData(chunk: Buffer | string): void {
		const pending = this.#pending;
		if (!pending) {
			this.#fail(new Error("Gateway policy socket returned unsolicited frame data"));
			return;
		}
		const chunkBytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		const newline = chunkBytes.indexOf(0x0a);
		if (newline === -1) {
			pending.payloadBytes += chunkBytes.byteLength;
			if (pending.payloadBytes > pending.maxFrameBytes) {
				this.#fail(new Error("Gateway policy socket response exceeds the frame limit"));
				return;
			}
			pending.chunks.push(chunkBytes);
			return;
		}
		if (pending.payloadBytes + newline > pending.maxFrameBytes) {
			this.#fail(new Error("Gateway policy socket response exceeds the frame limit"));
			return;
		}
		if (newline !== chunkBytes.byteLength - 1) {
			this.#fail(new Error("Gateway policy socket returned trailing frame data"));
			return;
		}
		pending.chunks.push(chunkBytes.subarray(0, newline));
		try {
			const bytes = Buffer.concat(pending.chunks, pending.payloadBytes + newline);
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			this.#succeed(JSON.parse(text));
		} catch {
			this.#fail(new Error("Gateway policy socket returned malformed JSON"));
		}
	}

	#succeed(value: unknown): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		this.#cleanupPending(pending);
		pending.deferred.resolve(value);
	}

	#fail(error: Error): void {
		this.#closedError ??= error;
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending) {
			this.#cleanupPending(pending);
			pending.deferred.reject(error);
		}
		if (!this.#socket.destroyed) this.#socket.destroy();
	}

	#cleanupPending(pending: PendingPolicySocketExchange): void {
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.onAbort);
	}
}

interface ActivePolicySocketSession {
	connection: PolicySocketConnection;
	tail: Promise<void>;
}

export function createAuthGatewayPolicySocketClient(
	socketPath: string,
	options: AuthGatewayPolicySocketClientOptions = {},
): AuthGatewayPolicySocketClient {
	validateAuthGatewayPolicySocketPath(socketPath);
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLICY_SOCKET_TIMEOUT_MS;
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_POLICY_SOCKET_MAX_FRAME_BYTES;
	validatePositiveBoundedInteger(timeoutMs, MAX_POLICY_SOCKET_TIMEOUT_MS, "Policy socket timeout");
	validatePositiveBoundedInteger(maxFrameBytes, MAX_POLICY_SOCKET_FRAME_BYTES, "Policy socket frame limit");
	const sessions = new Map<string, ActivePolicySocketSession>();

	const closeSession = (requestId: string, session: ActivePolicySocketSession): void => {
		if (sessions.get(requestId) === session) sessions.delete(requestId);
		session.connection.close();
	};

	return {
		authorizeRequest: async request => {
			const connection = new PolicySocketConnection(socketPath, timeoutMs);
			try {
				const response = await connection.exchange(
					{
						version: AUTH_GATEWAY_POLICY_PROTOCOL_VERSION,
						type: "authorize",
						request: {
							requestId: request.requestId,
							format: request.format,
							requestedModelId: request.requestedModelId,
							...(request.requestedSessionId === undefined
								? {}
								: { requestedSessionId: request.requestedSessionId }),
							method: request.method,
							path: request.path,
							payloadByteLength: request.payloadByteLength,
							payloadSha256: request.payloadSha256,
							authorization: request.authorization,
						},
					},
					maxFrameBytes,
					request.signal,
				);
				if (
					!hasExactKeys(response, ["version", "type", "decision"]) ||
					response.version !== AUTH_GATEWAY_POLICY_PROTOCOL_VERSION ||
					response.type !== "authorize_result"
				) {
					throw new Error("Gateway policy socket returned an invalid authorization response");
				}
				const decision = parsePolicyDecision(response.decision);
				if (sessions.has(request.requestId)) {
					throw new Error("Gateway policy socket request id is already active");
				}
				sessions.set(request.requestId, { connection, tail: Promise.resolve() });
				return decision;
			} catch (error) {
				connection.close();
				throw error;
			}
		},
		observe: observation => {
			const session = sessions.get(observation.requestId);
			if (!session) {
				return Promise.reject(new Error("Gateway policy socket has no active authorization session"));
			}
			const final =
				observation.type === "terminal" ||
				(observation.type === "authorization" && observation.outcome !== "authorized");
			const exchange = session.tail.then(async () => {
				const response = await session.connection.exchange(
					{
						version: AUTH_GATEWAY_POLICY_PROTOCOL_VERSION,
						type: "observe",
						observation,
					},
					maxFrameBytes,
				);
				if (
					!hasExactKeys(response, ["version", "type", "ack"]) ||
					response.version !== AUTH_GATEWAY_POLICY_PROTOCOL_VERSION ||
					response.type !== "observe_ack" ||
					response.ack !== true
				) {
					throw new Error("Gateway policy socket returned an invalid observation acknowledgement");
				}
			});
			const result = exchange.then(
				() => {
					if (final) closeSession(observation.requestId, session);
				},
				error => {
					closeSession(observation.requestId, session);
					throw error;
				},
			);
			session.tail = result.catch(() => {});
			return result;
		},
		probe: async signal => {
			const connection = new PolicySocketConnection(socketPath, timeoutMs);
			try {
				const response = await connection.exchange(
					{
						version: AUTH_GATEWAY_POLICY_PROTOCOL_VERSION,
						type: "probe",
					},
					maxFrameBytes,
					signal,
				);
				if (
					!hasExactKeys(response, ["version", "type", "ack"]) ||
					response.version !== AUTH_GATEWAY_POLICY_PROTOCOL_VERSION ||
					response.type !== "probe_ack" ||
					response.ack !== true
				) {
					throw new Error("Gateway policy socket returned an invalid readiness acknowledgement");
				}
				return true;
			} finally {
				connection.close();
			}
		},
	};
}

export interface AuthGatewayPolicyReadinessProbeOptions {
	cacheMs?: number;
	now?: () => number;
}

interface InFlightPolicyReadinessProbe {
	promise: Promise<boolean>;
}

export function createAuthGatewayPolicyReadinessProbe(
	client: AuthGatewayPolicySocketClient,
	options: AuthGatewayPolicyReadinessProbeOptions = {},
): (signal?: AbortSignal) => Promise<boolean> {
	const cacheMs = options.cacheMs ?? 250;
	const now = options.now ?? Date.now;
	validatePositiveBoundedInteger(cacheMs, 10_000, "Policy readiness cache");
	let cached = false;
	let cacheExpiresAt = 0;
	let inFlight: InFlightPolicyReadinessProbe | undefined;

	const startProbe = (): InFlightPolicyReadinessProbe => {
		// The shared probe has its own lifetime: HTTP caller cancellation stops
		// only that caller's wait and cannot bypass or poison the readiness cache.
		const probeSignal = new AbortController().signal;
		const probe = client.probe(probeSignal).then(
			result => {
				cached = result;
				cacheExpiresAt = now() + cacheMs;
				return result;
			},
			() => {
				cached = false;
				cacheExpiresAt = now() + cacheMs;
				return false;
			},
		);
		const state: InFlightPolicyReadinessProbe = { promise: probe };
		state.promise = probe.finally(() => {
			if (inFlight === state) inFlight = undefined;
		});
		inFlight = state;
		return state;
	};

	const waitForProbe = (state: InFlightPolicyReadinessProbe, signal?: AbortSignal): Promise<boolean> => {
		const deferred = Promise.withResolvers<boolean>();
		let settled = false;
		const finish = (result: boolean): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			deferred.resolve(result);
		};
		const onAbort = (): void => finish(false);
		if (signal?.aborted) {
			finish(false);
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
			void state.promise.then(finish);
		}
		return deferred.promise;
	};

	return signal => {
		if (now() < cacheExpiresAt) return Promise.resolve(cached);
		return waitForProbe(inFlight ?? startProbe(), signal);
	};
}

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

/**
 * Index resolvable models by the request ids clients may send: the
 * provider-qualified `provider/id` (always) and the bare `id` (first-write-wins
 * fallback for legacy clients). Scoped to providers the gateway holds broker
 * credentials for, since only those are routable.
 */
export function indexModelsByRequestId(
	models: readonly Model<Api>[],
	providersWithCreds: ReadonlySet<string>,
): Map<string, Model<Api>> {
	const modelById = new Map<string, Model<Api>>();
	for (const model of models) {
		if (!providersWithCreds.has(model.provider)) continue;
		modelById.set(`${model.provider}/${model.id}`, model);
		if (!modelById.has(model.id)) modelById.set(model.id, model);
	}
	return modelById;
}

async function runServe(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const policyClient = flags.policySocket ? createAuthGatewayPolicySocketClient(flags.policySocket) : undefined;
	const policyReadinessProbe = policyClient ? createAuthGatewayPolicyReadinessProbe(policyClient) : undefined;
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
	let modelById = indexModelsByRequestId(registry.getAll(), providersWithCreds);

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelById.get(id),
		listModels: () => modelById.values(),
		...(policyClient && policyReadinessProbe
			? {
					authorizeRequest: policyClient.authorizeRequest,
					observer: policyClient.observe,
					readinessProbe: policyReadinessProbe,
				}
			: {}),
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
				modelById = indexModelsByRequestId(registry.getAll(), providersWithCreds);
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
	if (cmd.flags.policySocket !== undefined) {
		validateAuthGatewayPolicySocketPath(cmd.flags.policySocket);
		if (cmd.action !== "serve") {
			throw new Error("--policy-socket is only valid with `auth-gateway serve`");
		}
	}
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
