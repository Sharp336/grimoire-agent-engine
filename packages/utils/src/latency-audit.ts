import { AsyncLocalStorage } from "node:async_hooks";
import * as logger from "./logger";

// Private, opt-in Artel measurement data. Never pass payloads, URLs or errors here.
interface AuditIdentity {
	commandId?: string;
	clientMessageId?: string;
	agentInstanceId?: string;
	attemptId?: string;
	executionId?: string;
	engineGeneration?: number;
	effectId?: string;
	modelCallId?: string;
}

interface AuditFields extends AuditIdentity {
	physicalRequestOrdinal?: number;
	api?: string;
	providerId?: string;
	modelId?: string;
	routeRef?: string;
	transport?: string;
	statusCode?: number;
	stream?: string;
	contentIndex?: number;
	chars?: number;
	parsedAt?: number;
	sourceCorrelation?: string;
	messageId?: string;
	blockId?: string;
	eventId?: number;
	cursor?: number;
}

const processStart = `${process.pid}:${performance.timeOrigin}`;
let writtenRecords = 0;
let writtenBytes = 0;
let limitReported = false;

function clockPair() {
	const wallBeforeMs = Date.now();
	const monoMs = performance.now();
	return { wallBeforeMs, monoMs, wallAfterMs: Date.now() };
}

export class LatencyAudit {
	readonly marks: Array<AuditFields & { stage: string; at: number }> = [];
	readonly #start = clockPair();
	#dropped = 0;
	#finished = false;

	constructor(readonly identity: AuditIdentity) {}

	mark(stage: string, fields: AuditFields = {}, at = performance.now()): void {
		if (this.#finished) return;
		// ponytail: bounded audit runs; increase only with an explicit longer trial.
		if (this.marks.length >= 256) {
			this.#dropped++;
			return;
		}
		this.marks.push({ ...fields, stage, at });
	}

	finish(outcome: string): void {
		if (this.#finished) return;
		for (const request of this.marks.filter(mark => mark.stage === "fetch_start")) {
			if (
				!this.marks.some(
					mark =>
						mark.stage === "normalized_first" && mark.physicalRequestOrdinal === request.physicalRequestOrdinal,
				)
			) {
				this.mark("no_content_on_terminal", { physicalRequestOrdinal: request.physicalRequestOrdinal });
			}
		}
		this.#finished = true;
		try {
			const record = {
				schema: "artel.latency.v1",
				component: "engine",
				processStart,
				pid: process.pid,
				unit: "monotonic_ms",
				...this.identity,
				outcome,
				clockStart: this.#start,
				clockEnd: clockPair(),
				dropped: this.#dropped,
				marks: this.marks,
			};
			const bytes = Buffer.byteLength(JSON.stringify(record));
			if (writtenRecords >= 1024 || writtenBytes + bytes > 4 * 1024 * 1024) {
				if (!limitReported) {
					limitReported = true;
					logger.info("artel.latency.limit", { processStart, dropped: true });
				}
				return;
			}
			writtenRecords++;
			writtenBytes += bytes;
			logger.info("artel.latency", record);
		} catch {
			/* Diagnostics never change execution or persistence outcomes. */
		}
	}
}

export function createLatencyAudit(identity: AuditIdentity): LatencyAudit | undefined {
	return process.env.ARTEL_LATENCY_AUDIT_ROOT ? new LatencyAudit(identity) : undefined;
}

export interface LatencyRequest {
	readonly audit: LatencyAudit;
	readonly fields: AuditFields;
	readonly first: Set<string>;
}

export interface LatencySource {
	readonly request: LatencyRequest;
	readonly parsedAt: number;
	readonly sourceCorrelation?: "direct" | "unknown";
}

export const latencyPhysicalRequest = new AsyncLocalStorage<LatencyRequest>();
// Only entered for an enabled Engine model audit; carries no prompt or session data.
export const latencyPreparation = new AsyncLocalStorage<LatencyAudit>();

export function latencyFetch(
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const request = latencyPhysicalRequest.getStore();
	if (!request) return fetch(input, init);
	request.audit.mark("fetch_start", request.fields);
	return fetch(input, init).then(
		response => {
			request.audit.mark("response_headers", { ...request.fields, statusCode: response.status });
			return response;
		},
		error => {
			request.audit.mark(init?.signal?.aborted ? "fetch_aborted" : "fetch_error", request.fields);
			throw error;
		},
	);
}

const responses = new WeakMap<Response, LatencyRequest>();
const parsed = new WeakMap<object, LatencySource>();
const normalized = new WeakMap<object, LatencySource>();
const persisted = new WeakMap<object, LatencySource>();

export function attachLatencyResponse(response: Response, request: LatencyRequest | undefined): void {
	if (request) responses.set(response, request);
}

export function latencyParsedObserver(response: Response, transport: string): ((value: unknown) => void) | undefined {
	const request = responses.get(response);
	if (!request) return undefined;
	request.audit.mark("parser_bound", { ...request.fields, transport });
	return value => {
		if (value && typeof value === "object") parsed.set(value, { request, parsedAt: performance.now() });
	};
}

export function latencyParsedSource(value: object): LatencySource | undefined {
	return parsed.get(value);
}

export function latencyFirst(
	source: LatencySource | undefined,
	stage: string,
	stream: string,
	fields: AuditFields = {},
	at?: number,
): boolean {
	if (!source || source.request.first.has(`${stage}:${stream}`)) return false;
	source.request.first.add(`${stage}:${stream}`);
	source.request.audit.mark(stage, { ...source.request.fields, stream, ...fields }, at);
	return true;
}

export function latencyNormalized(
	event: object,
	source: LatencySource | undefined,
	stream: string,
	text: string,
	contentIndex: number,
	direct: boolean,
): void {
	if (!source || !text.trim()) return;
	if (
		latencyFirst(source, "normalized_first", stream, {
			chars: text.length,
			contentIndex,
			parsedAt: direct ? source.parsedAt : undefined,
			sourceCorrelation: direct ? "direct" : "unknown",
		})
	) {
		normalized.set(event, { ...source, sourceCorrelation: direct ? "direct" : "unknown" });
	}
}

export function latencyProjected(
	event: object,
	source: LatencySource | undefined,
	stream: string,
	text: string,
	contentIndex: number,
	unchanged: boolean,
): void {
	if (!source || !text.trim()) return;
	const projected = unchanged ? source : { ...source, sourceCorrelation: "unknown" as const };
	if (
		latencyFirst(projected, "projected_first", stream, {
			chars: text.length,
			contentIndex,
			parsedAt: projected.sourceCorrelation === "direct" ? projected.parsedAt : undefined,
			sourceCorrelation: projected.sourceCorrelation,
		})
	) {
		normalized.set(event, projected);
	}
}

export function latencyNormalizedSource(event: object): LatencySource | undefined {
	return normalized.get(event);
}

// These are only the first substantive source events, blocks and payloads, never text itself.
export function attachLatencyPersistence(target: object, source: LatencySource | undefined, unchanged = true): void {
	if (source) persisted.set(target, unchanged ? source : { ...source, sourceCorrelation: "unknown" });
}

export function latencyPersistenceSource(target: object): LatencySource | undefined {
	return persisted.get(target);
}
