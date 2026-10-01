import { AsyncLocalStorage } from "node:async_hooks";
import type { Model, SimpleStreamOptions, UsageReport } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import {
	attachLatencyResponse,
	type LatencyAudit,
	type LatencyRequest,
	latencyPhysicalRequest,
	latencyPreparation,
} from "@oh-my-pi/pi-utils/latency-audit";
import type { ProviderRequestHook } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { ProviderExecutionError, parseBillingPoolProposal, type BillingPoolProposal, type ProviderExecutionIdentity } from "./provider-execution";
import type { ModelRequestState } from "./store";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;
const ADMISSION_TIMEOUT_MS = 10_000;
const OBSERVATION_FLUSH_BUDGET_MS = 250;
const SSE_EVENT_LIMIT = 64 * 1024;

class ProviderSseOutcome {
	#lineBuffer = "";
	#eventName = "";
	#data = "";
	readonly #decoder = new TextDecoder();

	push(chunk: Uint8Array, done = false): boolean {
		this.#lineBuffer += this.#decoder.decode(chunk, { stream: !done });
		if (this.#lineBuffer.length > SSE_EVENT_LIMIT) {
			this.#lineBuffer = this.#lineBuffer.slice(-SSE_EVENT_LIMIT);
		}
		let newline = this.#lineBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#lineBuffer.slice(0, newline).replace(/\r$/, "");
			this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
			if (this.#consumeLine(line)) return true;
			newline = this.#lineBuffer.indexOf("\n");
		}
		if (done) {
			if (this.#lineBuffer && this.#consumeLine(this.#lineBuffer.replace(/\r$/, ""))) return true;
			this.#lineBuffer = "";
			return this.#finishEvent();
		}
		return false;
	}

	#consumeLine(line: string): boolean {
		if (!line) return this.#finishEvent();
		if (line.startsWith("event:")) this.#eventName = line.slice(6).trim();
		else if (line.startsWith("data:") && this.#data.length < SSE_EVENT_LIMIT) {
			this.#data += `${this.#data ? "\n" : ""}${line.slice(5).trimStart()}`;
		}
		return false;
	}

	#finishEvent(): boolean {
		const eventName = this.#eventName;
		const data = this.#data;
		this.#eventName = "";
		this.#data = "";
		if (eventName === "error") return true;
		if (!data || data === "[DONE]" || data.length > SSE_EVENT_LIMIT) return false;
		try {
			const value = JSON.parse(data) as { type?: unknown; error?: unknown };
			return value.type === "error" || value.type === "response.failed" || value.error != null;
		} catch {
			return false;
		}
	}
}

export interface ProviderAdmissionIdentity extends Omit<ProviderExecutionIdentity, "modelId"> {
	executionPin?: string;
	providerKind: "openai_codex_subscription" | "anthropic_subscription" | "cursor_subscription";
	accountBindingId: string;
}

export interface ProviderApiKeyRouteIdentity extends ProviderExecutionIdentity {
	runtimeProviderId: string;
	baseUrl: string;
}

interface ProviderAdmissionDecision {
	allowed: boolean;
	executionPin?: string;
	status?: string;
	reason?: string;
	billing?: unknown;
}

/** Durable per-effect physical request facts; supplied by the Engine for every model effect. */
export interface ProviderRequestRecord {
	register(
		effectId: string,
		ordinal: number,
		frozen: { executionDigest: string; routeRef: string; accountRef: string },
	): Promise<void>;
	settle(
		effectId: string,
		ordinal: number,
		state: Exclude<ModelRequestState, "planned">,
		statusCode: number | null,
	): Promise<void>;
}

interface ProviderObservationContext {
	effectId: string;
	modelCallId: string;
	physicalRequestOrdinal: number;
	readonly pending: Set<Promise<unknown>>;
	readonly audit?: LatencyAudit;
	readonly record?: ProviderRequestRecord;
	pendingBillingRequest?: { reconciled: boolean };
}

type ProviderObservationOutcome = "success" | "rate_limited" | "timeout" | "provider_error" | "transport_error";

const providerObservationContext = new AsyncLocalStorage<ProviderObservationContext>();
const providerBillingRequest = new AsyncLocalStorage<{ reconciled: boolean }>();

/** Credential lookup may run before fetch; the next physical request adopts that same budget. */
export function withProviderBillingRequest<T>(work: () => Promise<T>): Promise<T> {
	if (providerBillingRequest.getStore()) return work();
	const observation = providerObservationContext.getStore();
	const budget = observation?.pendingBillingRequest ?? { reconciled: false };
	if (observation) observation.pendingBillingRequest = undefined;
	return providerBillingRequest.run(budget, work);
}

export async function reconcileProviderBilling(
	proposal: BillingPoolProposal | undefined,
	reconcile: ((proposal: BillingPoolProposal, signal?: AbortSignal) => Promise<void>) | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const observation = providerObservationContext.getStore();
	const budget = providerBillingRequest.getStore() ??
		(observation ? observation.pendingBillingRequest ??= { reconciled: false } : undefined);
	if (!budget || budget.reconciled || !proposal || !reconcile)
		throw new ProviderAdmissionError("billing_pool_changed", "Billing pool transition could not be reconciled");
	// Claim before awaiting the native mutation: nested/concurrent gates cannot spend it again.
	budget.reconciled = true;
	await reconcile(proposal, signal);
}

export async function withProviderObservationContext<T>(
	identity: { effectId: string; modelCallId: string },
	callback: () => Promise<T>,
	audit?: LatencyAudit,
	record?: ProviderRequestRecord,
): Promise<T> {
	return await providerObservationContext.run(
		{ ...identity, physicalRequestOrdinal: 0, pending: new Set(), audit, record },
		async () => {
			let completed = false;
			try {
				const value = await (audit ? latencyPreparation.run(audit, callback) : latencyPreparation.exit(callback));
				completed = true;
				return value;
			} finally {
				// Observation transport is auxiliary: it may briefly finish after a
				// successful answer, but must never delay a failed route's fallback.
				if (completed) {
					await settleWithin([...providerObservationContext.getStore()!.pending], OBSERVATION_FLUSH_BUDGET_MS);
				}
			}
		},
	);
}

/** A tool loop can contain several model responses inside one dispatched prompt. */
export function setProviderObservationModel(identity: { effectId: string; modelCallId: string }): void {
	const context = providerObservationContext.getStore();
	if (!context || context.effectId === identity.effectId) return;
	context.effectId = identity.effectId;
	context.modelCallId = identity.modelCallId;
	context.physicalRequestOrdinal = 0;
}

export function markProviderLatency(stage: string): void {
	const context = providerObservationContext.getStore();
	context?.audit?.mark(stage, { physicalRequestOrdinal: context.physicalRequestOrdinal + 1 });
}

export class ProviderAdmissionError extends Error {
	readonly retryable = false;

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ProviderAdmissionError";
	}
}

export class ProviderAdmissionClient {
	constructor(
		readonly endpoint: string,
		readonly token: string,
		readonly requestFetch: Fetch = globalThis.fetch,
	) {}

	async pin(identity: ProviderAdmissionIdentity, modelId: string, signal?: AbortSignal): Promise<string> {
		const decision = await this.#post({ phase: "pin", ...identity, modelId }, signal);
		if (!decision.allowed) {
			throw new ProviderAdmissionError(
				decision.status || "provider_admission_denied",
				"The admitted route could not be authorized",
			);
		}
		if (typeof decision.executionPin !== "string" || !/^[a-f0-9]{64}$/.test(decision.executionPin)) {
			throw new ProviderAdmissionError(
				"provider_admission_invalid_response",
				"The admitted route pin is unavailable",
			);
		}
		return decision.executionPin;
	}

	createHook(
		identity: ProviderAdmissionIdentity | undefined,
		authStorage: AuthStorage,
		baseUrl: string,
		apiKeyRoutes: readonly ProviderApiKeyRouteIdentity[] = [],
		localCredential?: { accountId: string; credentialId: number },
		onBillingPoolChanged?: (proposal: BillingPoolProposal, signal?: AbortSignal) => Promise<void>,
	): ProviderRequestHook {
		const admitted = <T>(model: Model, url: string, signal: AbortSignal | undefined,
			send: (selected: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity) => Promise<T>) =>
			this.#admitted(identity, authStorage, baseUrl, apiKeyRoutes, localCredential, onBillingPoolChanged,
				model, url, signal, send);
		return {
			wrapFetch: (model, fetch) => (input, init) =>
				admitted(model, requestUrl(input), init?.signal ?? undefined, selected =>
					this.#physical(selected, model, init?.signal ?? undefined, async (ordinal, startedAt, context, auditRequest) => {
						const response = auditRequest
							? await latencyPhysicalRequest.run(auditRequest, () => fetch(input, init))
							: await fetch(input, init);
						const observed = this.#observeResponse(selected, model, response, init?.signal, context,
							ordinal, startedAt, auditRequest);
						attachLatencyResponse(observed, auditRequest);
						return { status: response.status, value: observed };
					})),
			wrapRequest: (model, request) =>
				admitted(model, request.url, request.signal, selected =>
					this.#physical(selected, model, request.signal, async (ordinal, startedAt, context) => {
						const status = await request.send();
						this.#queueObservation(selected, model, context, ordinal, startedAt, {
							outcome: status === null || (status >= 200 && status < 300) ? "success"
								: status === 429 ? "rate_limited"
									: status === 408 || status === 504 ? "timeout" : "provider_error",
							...(status === null ? {} : { statusCode: status }),
						});
						return { status, value: status };
					})),
		};
	}

	/**
	 * One admission for both physical request shapes: exact route selection,
	 * request-boundary check, quota before-phase, one billing re-ask, and the
	 * after-phase. `send` performs the durable physical request.
	 */
	#admitted<T>(
		identity: ProviderAdmissionIdentity | undefined,
		authStorage: AuthStorage,
		baseUrl: string,
		apiKeyRoutes: readonly ProviderApiKeyRouteIdentity[],
		localCredential: { accountId: string; credentialId: number } | undefined,
		onBillingPoolChanged: ((proposal: BillingPoolProposal, signal?: AbortSignal) => Promise<void>) | undefined,
		model: Model,
		url: string,
		signal: AbortSignal | undefined,
		send: (selected: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity) => Promise<T>,
	): Promise<T> {
		return withProviderBillingRequest(async () => {
			const apiKeyRoute = apiKeyRoutes.find(route => matchesApiKeyRoute(model, route));
			const selected = apiKeyRoute ?? (identity && model.provider === identity.providerId ? identity : undefined);
			if (!selected) throw new ProviderAdmissionError(
				"provider_identity_mismatch", "The provider request does not match the admitted account");
			// Only model requests under the admitted descriptor base are physical model facts;
			// any other egress through the hook (token exchanges, ambient metadata) is refused.
			if (!isUnderAdmittedBase(url, selected === identity ? baseUrl : (selected as ProviderApiKeyRouteIdentity).baseUrl))
				throw new ProviderAdmissionError("provider_egress_unadmitted",
					"The provider request leaves the admitted provider endpoint");
			let report: UsageReport | undefined;
			if (selected === identity && localCredential) {
				const admissionSignal = signal
					? AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_TIMEOUT_MS)])
					: AbortSignal.timeout(ADMISSION_TIMEOUT_MS);
				markProviderLatency("usage_refresh_start");
				try {
					report = await raceWithSignal(authStorage.fetchCredentialUsageReport(identity.providerId,
						localCredential.credentialId, { baseUrl, signal: admissionSignal }), admissionSignal) ?? undefined;
					if (report?.metadata?.accountId !== localCredential.accountId) report = undefined;
				} catch (error) {
					if (signal?.aborted) throw error;
					// Usage endpoint availability is telemetry, not a denial of an admitted effect.
				}
				markProviderLatency("usage_refresh_done");
			}
			const before = () => ({
				phase: "before",
				...selected,
				modelId: model.id,
				...(selected === identity
					? report ? { usageReport: withoutRaw(report) } : { usageStatus: "unavailable" }
					: {}),
			});
			const reask = async (proposal: BillingPoolProposal | undefined): Promise<void> => {
				await reconcileProviderBilling(proposal, onBillingPoolChanged, signal);
				markProviderLatency("quota_before_start");
				const decision = await this.#post(before(), signal);
				markProviderLatency("quota_before_done");
				if (!decision.allowed)
					throw new ProviderAdmissionError(decision.status || "provider_admission_denied",
						decision.reason || "Provider quota admission was denied");
			};
			markProviderLatency("quota_before_start");
			const decision = await this.#post(before(), signal);
			markProviderLatency("quota_before_done");
			if (!decision.allowed) {
				if (decision.status === "billing_pool_changed") await reask(parseBillingPoolProposal(decision.billing));
				else throw new ProviderAdmissionError(decision.status || "provider_admission_denied",
					decision.reason || "Provider quota admission was denied");
			}
			try {
				try {
					return await send(selected);
				} catch (error) {
					if (!(error instanceof ProviderExecutionError) || error.code !== "billing_pool_changed")
						throw error;
					await reask(error.billing);
					return await send(selected);
				}
			} finally {
				if (selected === identity) {
					await authStorage.invalidateUsageCache(identity.providerId).catch(() => {});
					void this.#post({ phase: "after", ...identity, modelId: model.id }, undefined).catch(() => {});
				}
			}
		});
	}

	/**
	 * One physical request: its ordinal and frozen identity are durable before
	 * `send`; a failed write sends nothing. The settled state records whether the
	 * request was refused locally, answered, or has an unknown fate.
	 */
	async #physical<T>(
		identity: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity,
		model: Model,
		signal: AbortSignal | null | undefined,
		send: (
			ordinal: number,
			startedAt: number,
			context: ProviderObservationContext,
			auditRequest: LatencyRequest | undefined,
		) => Promise<{ status: number | null; value: T }>,
	): Promise<T> {
		const context = providerObservationContext.getStore();
		if (!context?.record)
			throw new ProviderAdmissionError("provider_effect_unadmitted",
				"A provider request requires an admitted model effect");
		const effectId = context.effectId;
		const ordinal = context.physicalRequestOrdinal + 1;
		await context.record.register(effectId, ordinal, {
			executionDigest: identity.executionDigest,
			routeRef: identity.routeRef,
			accountRef: identity.providerAccountRef,
		});
		context.physicalRequestOrdinal = ordinal;
		const auditRequest: LatencyRequest | undefined = context.audit
			? {
					audit: context.audit,
					first: new Set(),
					fields: {
						effectId,
						modelCallId: context.modelCallId,
						physicalRequestOrdinal: ordinal,
						api: model.api,
						modelId: model.id,
						providerId: model.provider,
						routeRef: identity.routeRef,
					},
				}
			: undefined;
		const startedAt = performance.now();
		let result: { status: number | null; value: T };
		try {
			result = await send(ordinal, startedAt, context, auditRequest);
		} catch (error) {
			if (error instanceof ProviderExecutionError || error instanceof ProviderAdmissionError) {
				await context.record.settle(effectId, ordinal, "not_sent", null);
				throw error;
			}
			const status = httpStatusFromError(error);
			await context.record.settle(effectId, ordinal, status ? "responded" : "send_unknown", status ?? null);
			if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
			this.#queueObservation(identity, model, context, ordinal, startedAt, {
				outcome:
					status === 429
						? "rate_limited"
						: status === 408 || status === 504
							? "timeout"
							: status
								? "provider_error"
								: "transport_error",
				statusCode: status,
			});
			throw error;
		}
		await context.record.settle(effectId, ordinal, result.status === null ? "send_unknown" : "responded", result.status);
		return result.value;
	}

	#observeResponse(
		identity: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity,
		model: Model,
		response: Response,
		signal: AbortSignal | null | undefined,
		context: ProviderObservationContext,
		ordinal: number,
		startedAt: number,
		auditRequest?: LatencyRequest,
	): Response {
		const outcome = response.ok
			? "success"
			: response.status === 429
				? "rate_limited"
				: response.status === 408 || response.status === 504
					? "timeout"
					: "provider_error";
		if (!response.body || !response.ok) {
			auditRequest?.audit.mark("response_terminal", { ...auditRequest.fields, statusCode: response.status });
			this.#queueObservation(identity, model, context, ordinal, startedAt, { outcome, statusCode: response.status });
			return response;
		}
		const reader = response.body.getReader();
		const detectsSse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
		const semanticOutcome = detectsSse ? new ProviderSseOutcome() : undefined;
		let settled = false;
		const settle = (next: { outcome: ProviderObservationOutcome; statusCode?: number }): void => {
			if (settled || signal?.aborted) return;
			settled = true;
			this.#queueObservation(identity, model, context, ordinal, startedAt, next);
		};
		const observed = new ReadableStream<Uint8Array>({
			pull: async controller => {
				try {
					const next = await reader.read();
					if (next.done) {
						auditRequest?.audit.mark("transport_eof", auditRequest.fields);
						if (semanticOutcome?.push(new Uint8Array(), true)) {
							settle({ outcome: "provider_error", statusCode: response.status });
						} else settle({ outcome, statusCode: response.status });
						controller.close();
					} else {
						if (semanticOutcome?.push(next.value)) {
							settle({ outcome: "provider_error", statusCode: response.status });
						}
						controller.enqueue(next.value);
					}
				} catch (error) {
					auditRequest?.audit.mark("transport_error", auditRequest.fields);
					settle({ outcome: "transport_error" });
					controller.error(error);
				}
			},
			cancel: reason => {
				auditRequest?.audit.mark(
					signal?.aborted ? "transport_aborted" : "transport_cancelled",
					auditRequest.fields,
				);
				if (signal?.aborted) settled = true;
				return reader.cancel(reason);
			},
		});
		const wrapped = new Response(observed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		for (const field of ["url", "redirected", "type"] as const) {
			Object.defineProperty(wrapped, field, { value: response[field] });
		}
		return wrapped;
	}

	#queueObservation(
		identity: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity,
		model: Model,
		context: ProviderObservationContext,
		ordinal: number,
		startedAt: number,
		outcome: { outcome: ProviderObservationOutcome; statusCode?: number },
	): void {
		const observationId = `${context.effectId}.${ordinal}.${identity.routeRef.slice(5)}`;
		const request = {
			phase: "observe",
			...providerObservationIdentity(identity),
			modelId: model.id,
			observationId,
			effectId: context.effectId,
			modelCallId: context.modelCallId,
			physicalRequestOrdinal: ordinal,
			...outcome,
			latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
		};
		const pending = this.#postObservation(request);
		context.pending.add(pending);
		void pending.then(
			() => context.pending.delete(pending),
			() => context.pending.delete(pending),
		);
	}

	async #postObservation(body: Record<string, unknown>): Promise<void> {
		let failureStatus = "provider_observation_unavailable";
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const decision = await this.#post(body, undefined);
				if (decision.allowed) return;
				failureStatus = decision.status || "provider_observation_rejected";
			} catch (error) {
				failureStatus =
					error instanceof ProviderAdmissionError ? error.code : "provider_observation_transport_error";
				// Retry once with the same observation id; Core deduplicates lost acknowledgements.
			}
		}
		logger.warn("Provider route observation was not recorded", {
			observationId: body.observationId,
			effectId: body.effectId,
			routeRef: body.routeRef,
			status: failureStatus,
			attempts: 2,
		});
	}

	async #post(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ProviderAdmissionDecision> {
		let response: Response;
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_TIMEOUT_MS)])
			: AbortSignal.timeout(ADMISSION_TIMEOUT_MS);
		try {
			response = await this.requestFetch(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ProviderAdmissionError(
				"provider_admission_unavailable",
				error instanceof Error ? error.message : "Provider admission is unavailable",
			);
		}
		if (!response.ok) {
			throw new ProviderAdmissionError(
				"provider_admission_unavailable",
				`Provider admission returned HTTP ${response.status}`,
			);
		}
		const value: unknown = await response.json().catch(() => undefined);
		if (!isDecision(value)) {
			throw new ProviderAdmissionError(
				"provider_admission_invalid_response",
				"Provider admission returned an invalid response",
			);
		}
		return value;
	}
}

function matchesApiKeyRoute(model: Model, route: ProviderApiKeyRouteIdentity): boolean {
	return model.provider === route.runtimeProviderId && model.id === route.modelId && model.baseUrl === route.baseUrl;
}

function requestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : String(input);
}

/** Same origin and the base path itself or a sub-path, after WHATWG dot-segment normalization. */
export function isUnderAdmittedBase(url: string, baseUrl: string): boolean {
	try {
		const request = new URL(url);
		const base = new URL(baseUrl);
		if (request.origin !== base.origin) return false;
		const basePath = base.pathname.replace(/\/+$/, "");
		return basePath === "" || request.pathname === basePath || request.pathname.startsWith(`${basePath}/`);
	} catch {
		return false;
	}
}

function providerObservationIdentity(identity: ProviderAdmissionIdentity | ProviderApiKeyRouteIdentity) {
	return {
		expectedPrincipalId: identity.expectedPrincipalId,
		agentInstanceRef: identity.agentInstanceRef,
		attemptId: identity.attemptId,
		bindingRevision: identity.bindingRevision,
		installationId: identity.installationId,
		dispatchRef: identity.dispatchRef,
		dispatchHash: identity.dispatchHash,
		executionDigest: identity.executionDigest,
		originReceiptId: identity.originReceiptId,
		providerAccountRef: identity.providerAccountRef,
		providerAccountContentHash: identity.providerAccountContentHash,
		credentialGeneration: identity.credentialGeneration,
		routeRef: identity.routeRef,
		routeContentHash: identity.routeContentHash,
		providerId: identity.providerId,
	};
}

function httpStatusFromError(error: unknown): number | undefined {
	const match = /\bHTTP\s+([1-5][0-9]{2})\b/.exec(error instanceof Error ? error.message : String(error));
	return match ? Number(match[1]) : undefined;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
	if (promises.length === 0) return;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(promises),
			new Promise<void>(resolve => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function withoutRaw(report: UsageReport): Omit<UsageReport, "raw"> {
	const { raw: _raw, ...safe } = report;
	return safe;
}

function isDecision(value: unknown): value is ProviderAdmissionDecision {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "allowed") === "boolean";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			error => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
