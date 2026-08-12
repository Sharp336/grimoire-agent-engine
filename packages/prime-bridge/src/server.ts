import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import {
	type PrimeBridgeConfig,
	type PrimeBridgeConfigOverrides,
	provisionPrimeBridgeConfig,
	resolveBridgeConfig,
} from "./config";
import { CommandResultUncertainError, PrimeDaemonClient } from "./prime/client";
import { BridgeStore, type ClaimedInboxMessage, type ClaimedPendingMessage } from "./store";
import { ensureBridgeToken } from "./token";

export interface PrimeBridgeLogger {
	error(message: string, context?: Record<string, unknown>): void;
}

export interface PrimeBridgeServerOptions {
	config?: PrimeBridgeConfig;
	stateDir?: string;
	databasePath?: string;
	tokenFile?: string;
	primeConfigFile?: string;
	port?: number;
	allowedOrigins?: readonly string[];
	token?: string;
	store?: BridgeStore;
	primeClient?: PrimeDaemonClient;
	peers?: () => unknown | Promise<unknown>;
	handleV1?: (request: Request) => Response | null | Promise<Response | null>;
	logger?: PrimeBridgeLogger;
}

export interface PrimeBridgeServer {
	readonly url: string;
	readonly token: string;
	readonly config: PrimeBridgeConfig;
	readonly tokenFile: string;
	stop(): Promise<void>;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function unauthorized(): Response {
	return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
}

function forbidden(): Response {
	return new Response("Forbidden", { status: 403 });
}

function resolveOptions(options: PrimeBridgeServerOptions): PrimeBridgeConfig {
	if (options.config) return options.config;
	const overrides: PrimeBridgeConfigOverrides = {
		...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
		...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
		...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
		...(options.primeConfigFile === undefined ? {} : { primeConfigFile: options.primeConfigFile }),
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
	};
	return resolveBridgeConfig(overrides);
}

const primeReceiptStatuses: Record<"delivered" | "queued", true> = {
	delivered: true,
	queued: true,
};
const MAX_POST_BODY_BYTES = 1_048_576;
const MAX_MESSAGE_FIELD_BYTES = 262_144;
export const MAX_INBOX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_WAIT_TIMEOUT_MS = 60_000;
export const MAX_ACTIVE_WAITERS = 100;
const DRAIN_BATCH_LIMIT = 100;
const DRAIN_CLAIM_LEASE_MS = 30_000;

class PayloadTooLargeError extends Error {}
class InvalidPrimeReceiptError extends Error {}
function sanitizeLogText(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return text
		.replace(/\bBearer\s+[^\s,;}\]]+/gi, "Bearer [REDACTED]")
		.replace(
			/\b(authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\s*[:=]\s*["']?[^,\s}"']+/gi,
			"$1=[REDACTED]",
		);
}

function tokenIdentifier(token: string): string {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJson(request: Request): Promise<unknown> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const declaredLength = Number(contentLength);
		if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
			throw new Error("content-length must be a non-negative integer");
		if (declaredLength > MAX_POST_BODY_BYTES) throw new PayloadTooLargeError("request body is too large");
	}
	if (request.body === null) throw new Error("request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_POST_BODY_BYTES) throw new PayloadTooLargeError("request body is too large");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(bytes);
	if (text.length === 0) throw new Error("request body is required");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("request body must be valid JSON");
	}
}

function assertBoundedString(field: string, value: string): void {
	if (new TextEncoder().encode(value).byteLength > MAX_MESSAGE_FIELD_BYTES)
		throw new PayloadTooLargeError(`message.${field} is too large`);
}

function parseBridgeMessage(value: unknown): BridgeMessage {
	if (!isRecord(value)) throw new Error("message must be an object");
	const requiredStrings = [
		"meshMessageId",
		"idempotencyKey",
		"originSessionId",
		"targetId",
		"body",
		"projectRoot",
		"createdAt",
	] as const;
	for (const field of requiredStrings) {
		if (typeof value[field] !== "string" || value[field].length === 0)
			throw new Error(`message.${field} must be a non-empty string`);
		assertBoundedString(field, value[field]);
	}
	const originSessionId = value.originSessionId;
	if (typeof originSessionId !== "string" || !originSessionId.isWellFormed())
		throw new Error("message.originSessionId must be well-formed Unicode");
	const targetId = value.targetId;
	if (typeof targetId !== "string" || !targetId.isWellFormed())
		throw new Error("message.targetId must be well-formed Unicode");
	if (value.originHarness !== "omp" && value.originHarness !== "prime")
		throw new Error("message.originHarness is invalid");
	if (value.targetHarness !== "omp" && value.targetHarness !== "prime")
		throw new Error("message.targetHarness is invalid");
	if (value.replyTo !== undefined) {
		if (typeof value.replyTo !== "string") throw new Error("message.replyTo must be a string");
		assertBoundedString("replyTo", value.replyTo);
	}
	return value as unknown as BridgeMessage;
}

function parseWaitRequest(value: unknown): { targetId: string; from?: string; timeoutMs: number } {
	if (
		!isRecord(value) ||
		typeof value.targetId !== "string" ||
		value.targetId.length === 0 ||
		!Number.isSafeInteger(value.timeoutMs) ||
		(value.timeoutMs as number) < 0
	) {
		throw new Error("targetId and timeoutMs are required");
	}
	assertBoundedString("targetId", value.targetId);
	if (value.from !== undefined) {
		if (typeof value.from !== "string") throw new Error("from must be a string");
		assertBoundedString("from", value.from);
	}
	const timeoutMs = value.timeoutMs as number;
	if (timeoutMs > MAX_WAIT_TIMEOUT_MS) throw new Error(`timeoutMs must be at most ${MAX_WAIT_TIMEOUT_MS}`);
	return {
		targetId: value.targetId,
		timeoutMs,
		...(value.from === undefined ? {} : { from: value.from }),
	};
}

function parseClaimToken(value: unknown): string {
	if (!isRecord(value) || typeof value.claimToken !== "string" || value.claimToken.length === 0)
		throw new Error("claimToken is required");
	assertBoundedString("claimToken", value.claimToken);
	return value.claimToken;
}

function parseTargetHarness(value: string | null): "omp" | "prime" {
	if (value === null || value === "prime") return "prime";
	if (value === "omp") return "omp";
	throw new Error("targetHarness must be omp or prime");
}

function mapPrimePeers(raw: unknown): ExternalPeer[] {
	const sessions = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
	const peers: ExternalPeer[] = [];
	for (const session of sessions) {
		if (!isRecord(session)) continue;
		const rawSessionId =
			typeof session.activeSessionId === "string"
				? session.activeSessionId
				: typeof session.sessionId === "string"
					? session.sessionId
					: typeof session.id === "string"
						? session.id
						: "";
		const activeSessionId = rawSessionId;
		if (activeSessionId.length === 0) continue;
		const id = `prime:${activeSessionId}`;
		const displayName =
			typeof session.displayName === "string"
				? session.displayName
				: typeof session.name === "string"
					? session.name
					: activeSessionId;
		const status =
			typeof session.status === "string"
				? session.status
				: typeof session.state === "string"
					? session.state
					: "active";
		peers.push({
			...session,
			id,
			activeSessionId,
			displayName,
			status,
		});
	}
	return peers;
}

function parsePeerRegistration(value: unknown): ExternalPeer {
	if (!isRecord(value) || value.targetHarness !== "omp")
		throw new Error("peer registration targetHarness must be omp");
	if (typeof value.id !== "string" || value.id.length === 0) throw new Error("peer registration id is required");
	const displayName =
		typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : value.id;
	const status = typeof value.status === "string" && value.status.length > 0 ? value.status : "running";
	assertBoundedString("id", value.id);
	assertBoundedString("displayName", displayName);
	assertBoundedString("status", status);
	return { id: value.id, displayName, status };
}

interface Waiter {
	targetId: string;
	from?: string;
	resolve: (claim: ClaimedInboxMessage | null) => void;
	timer?: Timer;
	abort?: () => void;
}

function sameMessage(left: BridgeMessage, right: BridgeMessage): boolean {
	const fields: Array<keyof BridgeMessage> = [
		"meshMessageId",
		"idempotencyKey",
		"originHarness",
		"originSessionId",
		"targetHarness",
		"targetId",
		"body",
		"replyTo",
		"projectRoot",
		"createdAt",
	];
	return fields.every(field => left[field] === right[field]);
}

function asReceipt(messageId: string, raw: unknown): BridgeReceipt {
	if (!isRecord(raw)) throw new InvalidPrimeReceiptError("Prime returned a malformed receipt");
	if (raw.meshMessageId !== undefined && raw.meshMessageId !== messageId) {
		throw new InvalidPrimeReceiptError("Prime returned a receipt for a different message");
	}
	const deliveryStatus = raw.deliveryStatus;
	const rawStatus = raw.status;
	if (
		deliveryStatus !== undefined &&
		(typeof deliveryStatus !== "string" || primeReceiptStatuses[deliveryStatus as "delivered" | "queued"] !== true)
	) {
		throw new InvalidPrimeReceiptError("Prime returned an unknown delivery status");
	}
	if (
		rawStatus !== undefined &&
		(typeof rawStatus !== "string" || primeReceiptStatuses[rawStatus as "delivered" | "queued"] !== true)
	) {
		throw new InvalidPrimeReceiptError("Prime returned an unknown receipt status");
	}
	const status =
		typeof deliveryStatus === "string"
			? (deliveryStatus as "delivered" | "queued")
			: typeof rawStatus === "string"
				? (rawStatus as "delivered" | "queued")
				: undefined;
	if (status === undefined) throw new InvalidPrimeReceiptError("Prime returned a receipt without a status");
	return { ...raw, meshMessageId: messageId, status } as BridgeReceipt;
}

export async function startPrimeBridgeServer(options: PrimeBridgeServerOptions = {}): Promise<PrimeBridgeServer> {
	const config = resolveOptions(options);
	await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	await fs.chmod(config.stateDir, 0o700);
	const token = await ensureBridgeToken(config.tokenFile);
	if (options.token !== undefined && options.token !== token)
		throw new Error("provided bridge token does not match token file");
	const auditTokenIdentifier = tokenIdentifier(token);
	const store = options.store ?? BridgeStore.open(config.databasePath);
	const ownsStore = options.store === undefined;
	const primeClient = options.primeClient ?? new PrimeDaemonClient({ store });
	const ownsPrimeClient = options.primeClient === undefined;
	const waiters: Waiter[] = [];
	let stopping = false;
	let drainRunning = false;
	let drainQueued = false;
	let drainPromise: Promise<void> | undefined;
	let retryTimer: Timer | undefined;

	const removeWaiter = (waiter: Waiter): void => {
		const index = waiters.indexOf(waiter);
		if (index >= 0) waiters.splice(index, 1);
		clearTimeout(waiter.timer);
		waiter.abort?.();
		waiter.abort = undefined;
	};
	const wakeWaiters = (): void => {
		for (const waiter of [...waiters]) {
			const claim = store.claimInboxForTarget(waiter.targetId, waiter.from);
			if (claim === null) continue;
			removeWaiter(waiter);
			waiter.resolve(claim);
		}
	};
	const scheduleDrainAt = (atMs: number): void => {
		if (stopping) return;
		const delay = Math.max(0, atMs - Date.now());
		clearTimeout(retryTimer);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void requestDrain().catch(error => {
				options.logger?.error("Prime bridge outbox drain failed", { error: sanitizeLogText(error) });
			});
		}, delay);
	};
	const scheduleRetry = (): void => scheduleDrainAt(Date.now() + DRAIN_CLAIM_LEASE_MS);
	const scheduleNextClaim = (): void => {
		const nextClaimAt = store.nextClaimAt();
		if (nextClaimAt !== null) scheduleDrainAt(nextClaimAt);
	};
	const appendDeliveryAudit = (
		message: BridgeMessage,
		action: "message_sent" | "message_failed",
		error?: unknown,
	): void => {
		store.appendAudit({
			action,
			direction: "outbound",
			tokenIdentifier: auditTokenIdentifier,
			originHarness: message.originHarness,
			originSessionId: message.originSessionId,
			preview: {
				meshMessageId: message.meshMessageId,
				idempotencyKey: message.idempotencyKey,
				originHarness: message.originHarness,
				targetHarness: message.targetHarness,
				targetId: message.targetId,
				...(error === undefined ? {} : { error: sanitizeLogText(error) }),
			},
		});
	};
	const deliverClaim = async (claim: ClaimedPendingMessage): Promise<BridgeReceipt> => {
		const message = claim.message;
		try {
			const receipt = asReceipt(
				message.meshMessageId,
				await primeClient.sendMessage(message.targetId, message.body, undefined, message.meshMessageId),
			);
			if (!store.recordReceipt(receipt, claim.claimToken)) return receipt;
			appendDeliveryAudit(message, "message_sent");
			try {
				await primeClient.acknowledgeBridgeMessage(message.meshMessageId);
			} catch (error) {
				options.logger?.error("Prime bridge receipt acknowledgement failed", {
					meshMessageId: message.meshMessageId,
					error: sanitizeLogText(error),
				});
			}
			return receipt;
		} catch (error) {
			if (error instanceof CommandResultUncertainError) {
				const receipt: BridgeReceipt = {
					meshMessageId: message.meshMessageId,
					status: "failed",
					error: error.message,
				};
				if (store.recordReceipt(receipt, claim.claimToken)) appendDeliveryAudit(message, "message_failed", error);
				try {
					if (typeof primeClient.acknowledgeBridgeMessage === "function")
						await primeClient.acknowledgeBridgeMessage(message.meshMessageId);
				} catch (ackError) {
					options.logger?.error("Prime bridge uncertain receipt acknowledgement failed", {
						meshMessageId: message.meshMessageId,
						error: sanitizeLogText(ackError),
					});
				}
				options.logger?.error("Prime bridge outbox delivery failed with uncertain Prime command result", {
					meshMessageId: message.meshMessageId,
					error: sanitizeLogText(error),
				});
				return receipt;
			}
			if (error instanceof InvalidPrimeReceiptError) {
				const receipt: BridgeReceipt = {
					meshMessageId: message.meshMessageId,
					status: "failed",
					error: error.message,
				};
				if (store.recordReceipt(receipt, claim.claimToken)) appendDeliveryAudit(message, "message_failed", error);
				try {
					if (typeof primeClient.acknowledgeBridgeMessage === "function")
						await primeClient.acknowledgeBridgeMessage(message.meshMessageId);
				} catch (ackError) {
					options.logger?.error("Prime bridge terminal receipt acknowledgement failed", {
						meshMessageId: message.meshMessageId,
						error: sanitizeLogText(ackError),
					});
				}
				options.logger?.error("Prime bridge outbox delivery returned an invalid Prime receipt", {
					meshMessageId: message.meshMessageId,
					error: sanitizeLogText(error),
				});
				return receipt;
			}
			if (store.recordDeliveryFailure(message.meshMessageId, claim.claimToken)) {
				appendDeliveryAudit(message, "message_failed", error);
				scheduleRetry();
			}
			options.logger?.error("Prime bridge outbox delivery failed", {
				meshMessageId: message.meshMessageId,
				error: sanitizeLogText(error),
			});
			throw error;
		}
	};
	const drainBatch = async (): Promise<void> => {
		const pending = store.claimPendingMessages({ limit: DRAIN_BATCH_LIMIT, leaseMs: DRAIN_CLAIM_LEASE_MS });
		let firstFailure: unknown;
		for (const claim of pending) {
			try {
				await deliverClaim(claim);
			} catch (error) {
				firstFailure ??= error;
			}
		}
		if (pending.length === DRAIN_BATCH_LIMIT && firstFailure === undefined) drainQueued = true;
		if (pending.length === 0 || firstFailure === undefined) scheduleNextClaim();
		if (firstFailure !== undefined) throw firstFailure;
	};
	const requestDrain = (): Promise<void> => {
		if (stopping) return Promise.resolve();
		if (drainRunning) {
			drainQueued = true;
			return drainPromise ?? Promise.resolve();
		}
		drainRunning = true;
		const running = drainBatch().finally(() => {
			drainRunning = false;
			drainPromise = undefined;
			if (drainQueued && !stopping) {
				drainQueued = false;
				void requestDrain().catch(error => {
					options.logger?.error("Prime bridge outbox drain failed", { error: sanitizeLogText(error) });
				});
			}
		});
		drainPromise = running;
		return running;
	};

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: async (request): Promise<Response> => {
			const url = new URL(request.url);
			if (request.headers.get("host") !== new URL(server.url).host)
				return new Response("Bad Request", { status: 400 });
			if (url.pathname === "/health") return jsonResponse({ ok: true });

			if (url.pathname.startsWith("/v1/")) {
				const origin = request.headers.get("origin");
				if (origin !== null && origin.length > 0 && !config.allowedOrigins.includes(origin)) return forbidden();
				let currentToken: string;
				try {
					currentToken = (await fs.readFile(config.tokenFile, "utf8")).trim();
				} catch {
					return unauthorized();
				}
				if (currentToken.length === 0 || request.headers.get("authorization") !== `Bearer ${currentToken}`)
					return unauthorized();
				try {
					const custom = await options.handleV1?.(request);
					if (custom !== null && custom !== undefined) return custom;
					if (url.pathname === "/v1/peers" && request.method === "GET") {
						let targetHarness: "omp" | "prime";
						try {
							targetHarness = parseTargetHarness(url.searchParams.get("targetHarness"));
						} catch (error) {
							return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
						}
						if (targetHarness === "omp") return jsonResponse(store.listOmpPeers());
						const peers = options.peers ? await options.peers() : await primeClient.listSessions();
						return jsonResponse(mapPrimePeers(peers));
					}
					if (url.pathname === "/v1/peers" && request.method === "POST") {
						try {
							const peer = parsePeerRegistration(await parseJson(request));
							store.registerOmpPeer(peer);
							return jsonResponse(peer);
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
					}
					if (url.pathname === "/v1/messages" && request.method === "POST") {
						let message: BridgeMessage;
						try {
							message = parseBridgeMessage(await parseJson(request));
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
						const existingMessage = store.findMessageByIdempotencyKey(message.idempotencyKey);
						if (existingMessage !== null) {
							if (!sameMessage(existingMessage, message))
								return jsonResponse({ error: "idempotency key conflicts with an existing message" }, 409);
							const existingReceipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
							if (existingReceipt !== null) return jsonResponse(existingReceipt);
							try {
								await requestDrain();
							} catch {
								// A duplicate observes the durable pending state below.
							}
							const retriedReceipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
							return retriedReceipt === null
								? jsonResponse({ error: "message remains pending delivery" }, 503)
								: jsonResponse(retriedReceipt);
						}

						if (message.targetHarness === "omp") {
							const inserted = store.putInbox(message);
							if (!inserted) return jsonResponse({ error: "meshMessageId already exists" }, 409);
							const receipt = { meshMessageId: message.meshMessageId, status: "injected" } as BridgeReceipt;
							store.recordReceipt(receipt);
							wakeWaiters();
							store.appendAudit({
								action: "message_injected",
								direction: "inbound",
								tokenIdentifier: auditTokenIdentifier,
								originHarness: message.originHarness,
								originSessionId: message.originSessionId,
								preview: {
									meshMessageId: message.meshMessageId,
									idempotencyKey: message.idempotencyKey,
									originHarness: message.originHarness,
									targetHarness: message.targetHarness,
									targetId: message.targetId,
								},
							});
							return jsonResponse(receipt);
						}

						if (!store.enqueueMessage(message)) {
							const racedMessage = store.findMessageByIdempotencyKey(message.idempotencyKey);
							if (racedMessage === null) return jsonResponse({ error: "meshMessageId already exists" }, 409);
							if (!sameMessage(racedMessage, message))
								return jsonResponse({ error: "idempotency key conflicts with an existing message" }, 409);
							const racedReceipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
							if (racedReceipt !== null) return jsonResponse(racedReceipt);
							try {
								await requestDrain();
							} catch {
								// A concurrent winner may still be completing its durable attempt.
							}
							const retriedReceipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
							return retriedReceipt === null
								? jsonResponse({ error: "message remains pending delivery" }, 503)
								: jsonResponse(retriedReceipt);
						}
						try {
							await requestDrain();
						} catch (error) {
							const receipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
							if (receipt !== null) return jsonResponse(receipt);
							if (error instanceof InvalidPrimeReceiptError) return jsonResponse({ error: error.message }, 502);
							throw error;
						}
						const receipt = store.getReceiptForIdempotencyKey(message.idempotencyKey);
						return receipt === null
							? jsonResponse({ error: "message remains pending delivery" }, 503)
							: jsonResponse(receipt);
					}
					if (url.pathname === "/v1/inbox" && request.method === "GET") {
						const peek = url.searchParams.get("peek");
						const targetId = url.searchParams.get("targetId");
						if (peek !== null && peek !== "true" && peek !== "false")
							return jsonResponse({ error: "peek must be true or false" }, 400);
						if (targetId === null || targetId.length === 0)
							return jsonResponse({ error: "targetId is required" }, 400);
						try {
							assertBoundedString("targetId", targetId);
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
						return jsonResponse(
							store.listInbox({
								targetId,
								peek: peek !== "false",
								maxBytes: MAX_INBOX_RESPONSE_BYTES,
							}),
						);
					}
					if (url.pathname === "/v1/wait/ack" && request.method === "POST") {
						try {
							const claimToken = parseClaimToken(await parseJson(request));
							return jsonResponse({ ok: store.ackInboxClaim(claimToken) });
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
					}
					if (url.pathname === "/v1/wait/release" && request.method === "POST") {
						try {
							const claimToken = parseClaimToken(await parseJson(request));
							return jsonResponse({ ok: store.releaseInboxClaim(claimToken) });
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
					}
					if (url.pathname === "/v1/wait" && request.method === "POST") {
						let waitRequest: { targetId: string; from?: string; timeoutMs: number };
						try {
							waitRequest = parseWaitRequest(await parseJson(request));
						} catch (error) {
							return jsonResponse(
								{ error: error instanceof Error ? error.message : String(error) },
								error instanceof PayloadTooLargeError ? 413 : 400,
							);
						}
						const existing = store.claimInboxForTarget(waitRequest.targetId, waitRequest.from);
						if (existing !== null) return jsonResponse(existing);
						if (waiters.length >= MAX_ACTIVE_WAITERS)
							return jsonResponse({ error: "too many active waiters" }, 429);
						return new Promise<Response>(resolve => {
							const waiter: Waiter = {
								targetId: waitRequest.targetId,
								...(waitRequest.from === undefined ? {} : { from: waitRequest.from }),
								resolve: claim => resolve(jsonResponse(claim)),
							};
							const onAbort = (): void => {
								removeWaiter(waiter);
								resolve(jsonResponse(null));
							};
							waiter.abort = () => request.signal.removeEventListener("abort", onAbort);
							request.signal.addEventListener("abort", onAbort, { once: true });
							if (waitRequest.timeoutMs > 0) {
								waiter.timer = setTimeout(() => {
									removeWaiter(waiter);
									resolve(jsonResponse(null));
								}, waitRequest.timeoutMs);
							}
							waiters.push(waiter);
							if (request.signal.aborted) {
								onAbort();
								return;
							}
							const raced = store.claimInboxForTarget(waitRequest.targetId, waitRequest.from);
							if (raced !== null) {
								removeWaiter(waiter);
								waiter.resolve(raced);
							}
						});
					}
					if (url.pathname === "/v1/audit" && request.method === "GET") return jsonResponse(store.listAudit());
					return new Response("Not Found", { status: 404 });
				} catch (error) {
					options.logger?.error("Prime bridge request failed", {
						error: sanitizeLogText(error),
					});
					return jsonResponse({ error: "internal server error" }, 500);
				}
			}

			return new Response("Not Found", { status: 404 });
		},
	});

	const url = server.url.origin;
	try {
		await provisionPrimeBridgeConfig(options.primeConfigFile ?? config.primeConfigFile, {
			url,
			tokenFile: config.tokenFile,
		});
	} catch (error) {
		await server.stop(true);
		if (ownsPrimeClient) primeClient.close();
		if (ownsStore) store.close();
		throw error;
	}

	void requestDrain().catch(error => {
		options.logger?.error("Prime bridge outbox drain failed", { error: sanitizeLogText(error) });
	});
	let stopPromise: Promise<void> | undefined;
	return {
		url,
		token,
		config,
		tokenFile: config.tokenFile,
		stop(): Promise<void> {
			if (stopPromise !== undefined) return stopPromise;
			stopping = true;
			if (retryTimer !== undefined) {
				clearTimeout(retryTimer);
				retryTimer = undefined;
			}
			for (const waiter of [...waiters]) {
				removeWaiter(waiter);
				waiter.resolve(null);
			}
			stopPromise = (async () => {
				try {
					await server.stop(false);
					if (drainPromise !== undefined) await drainPromise;
				} finally {
					if (ownsPrimeClient) primeClient.close();
					if (ownsStore) store.close();
				}
			})();
			return stopPromise;
		},
	};
}
