import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
	type EngineAttemptState,
	type EngineEvent,
	type EngineInboxMutation,
	type EngineInboxSource,
	type EngineTarget,
	EngineTargetError,
} from "./contracts";
import { dispatchEngineCommand, type EngineCommandEnvelope, engineCommandIdentity } from "./nats-adapter";
import type { EngineRuntime } from "./runtime";
import { EngineCommandConflictError, type EngineCommandReceipt } from "./store";

export const ENGINE_CONTROL_QUERY_VERSION = "1.0";
export const ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES = 256 * 1024;
export const ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS = 48_000;

export type EngineControlQueryMethod =
	| "capabilities"
	| "snapshots.list"
	| "snapshots.get"
	| "events.list"
	| "result.get"
	| "session.context"
	| "session.history"
	| "session.usage"
	| "inbox.list"
	| "inbox.enqueue"
	| "inbox.read"
	| "inbox.mutate"
	| "inbox.reorder"
	| "command";

export interface EngineControlQueryRequest {
	schema: "grimoire.engine.control_query.request.v1";
	version: "1.0";
	requestId: string;
	token: string;
	method: EngineControlQueryMethod;
	params?: Record<string, unknown>;
}

export type EngineControlQueryResponse =
	| {
			schema: "grimoire.engine.control_query.response.v1";
			version: "1.0";
			requestId: string;
			ok: true;
			result: unknown;
	  }
	| {
			schema: "grimoire.engine.control_query.response.v1";
			version: "1.0";
			requestId: string;
			ok: false;
			error: { code: string; message: string; retryable: boolean };
	  };

export interface EnginePublicSnapshot {
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	bindingId: string;
	engineGeneration: number;
	bindingGeneration: number;
	authorityGeneration: number;
	state: EngineAttemptState;
	manualHold: boolean;
	intentRevision: number;
	retry?: import("./contracts").EngineRetryState;
	profileDigest?: string;
	transcriptRef?: string;
	updatedAt: number;
	controlReadiness: { steer: boolean; pause: boolean; resume: boolean; cancel: boolean };
}

export interface EngineControlQueryServer {
	endpoint: string;
	close(): Promise<void>;
}

interface ServerOptions {
	runtime: EngineRuntime;
	runtimeDir: string;
	deviceId: string;
	engineId: string;
	resolveLaunchProfile: Parameters<typeof dispatchEngineCommand>[0]["resolveLaunchProfile"];
	provisionMailbox?: (agentInstanceId: string) => void | Promise<void>;
}

export function engineControlQueryEndpoint(runtimeDir: string): string {
	if (process.platform !== "win32") return path.join(path.resolve(runtimeDir), "control-query.sock");
	const suffix = createHash("sha256").update(path.resolve(runtimeDir).toLowerCase()).digest("hex").slice(0, 24);
	return `\\\\.\\pipe\\grimoire-agent-engine-${suffix}`;
}

export async function startEngineControlQueryServer(options: ServerOptions): Promise<EngineControlQueryServer> {
	const token = await ensureToken(options.runtimeDir);
	const endpoint = engineControlQueryEndpoint(options.runtimeDir);
	if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
	const server = net.createServer(socket => serveSocket(socket, token, options));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		endpoint,
		async close() {
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
			if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
		},
	};
}

export class EngineControlQueryClient {
	readonly #runtimeDir: string;
	readonly #timeoutMs: number;

	constructor(runtimeDir: string, timeoutMs = 10_000) {
		this.#runtimeDir = path.resolve(runtimeDir);
		this.#timeoutMs = timeoutMs;
	}

	async request(method: EngineControlQueryMethod, params?: Record<string, unknown>): Promise<unknown> {
		const token = (await fs.readFile(path.join(this.#runtimeDir, "control-query.token"), "utf8")).trim();
		const request: EngineControlQueryRequest = {
			schema: "grimoire.engine.control_query.request.v1",
			version: ENGINE_CONTROL_QUERY_VERSION,
			requestId: randomUUID(),
			token,
			method,
			params,
		};
		return await requestOnce(engineControlQueryEndpoint(this.#runtimeDir), request, this.#timeoutMs);
	}
}

async function ensureToken(runtimeDir: string): Promise<string> {
	const tokenPath = path.join(runtimeDir, "control-query.token");
	try {
		const token = (await fs.readFile(tokenPath, "utf8")).trim();
		if (/^[0-9a-f]{64}$/.test(token)) return token;
		throw new Error("Engine Control + Query token file is invalid");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const token = randomBytes(32).toString("hex");
	try {
		await fs.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return token;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		return await ensureToken(runtimeDir);
	}
}

function serveSocket(socket: net.Socket, token: string, options: ServerOptions): void {
	let buffered = Buffer.alloc(0);
	let tail = Promise.resolve();
	socket.setTimeout(30_000, () => socket.destroy());
	socket.on("data", chunk => {
		buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
		if (buffered.byteLength > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES && !buffered.includes(10)) {
			writeResponse(socket, failure("", "frame_too_large", "Request frame exceeds 256 KiB", false));
			socket.end();
			return;
		}
		for (;;) {
			const newline = buffered.indexOf(10);
			if (newline < 0) break;
			const frame = buffered.subarray(0, newline);
			buffered = buffered.subarray(newline + 1);
			tail = tail.then(async () => {
				const response = await handleFrame(frame, token, options);
				writeResponse(socket, response);
			});
		}
	});
	tail.catch(() => socket.destroy());
}

async function handleFrame(frame: Buffer, token: string, options: ServerOptions): Promise<EngineControlQueryResponse> {
	if (frame.byteLength === 0 || frame.byteLength > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES) {
		return failure("", "frame_too_large", "Request frame is outside the accepted range", false);
	}
	let requestId = "";
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
		const request = validateRequest(value);
		requestId = request.requestId;
		if (!sameSecret(request.token, token)) return failure(requestId, "unauthorized", "Invalid local token", false);
		const result = await dispatchRequest(request, options);
		return success(requestId, result);
	} catch (error) {
		if (error instanceof EngineTargetError) return failure(requestId, error.code, error.message, false);
		if (error instanceof EngineCommandConflictError)
			return failure(requestId, "command_id_conflict", error.message, false);
		return failure(requestId, "invalid_request", error instanceof Error ? error.message : String(error), false);
	}
}

async function dispatchRequest(request: EngineControlQueryRequest, options: ServerOptions): Promise<unknown> {
	const params = request.params ?? {};
	switch (request.method) {
		case "capabilities":
			return capabilities(options);
		case "snapshots.list":
			return await listSnapshots(options.runtime, optionalString(params.cursor), optionalLimit(params.limit));
		case "snapshots.get":
			return await getSnapshot(options.runtime, requiredString(params, "attemptId"));
		case "events.list":
			return await listEvents(
				options.runtime,
				requiredString(params, "attemptId"),
				optionalString(params.cursor),
				optionalLimit(params.limit),
			);
		case "result.get":
			return await getResult(options.runtime, requiredString(params, "attemptId"));
		case "session.context":
			return await options.runtime.sessionContext(requiredTarget(params));
		case "session.history":
			return await listSessionHistory(
				options.runtime,
				requiredString(params, "agentInstanceId"),
				optionalString(params.cursor),
				optionalLimit(params.limit),
			);
		case "session.usage":
			return await options.runtime.sessionUsage(requiredTarget(params));
		case "inbox.list":
			return {
				items: await options.runtime.listInbox(requiredTarget(params), optionalBoolean(params.includeTerminal)),
			};
		case "inbox.enqueue":
			return await options.runtime.enqueueInbox(requiredTarget(params), requiredInboxSource(params));
		case "inbox.read":
			return await options.runtime.readInbox(requiredTarget(params), requiredString(params, "queueId"));
		case "inbox.mutate":
			return await options.runtime.mutateInbox(requiredTarget(params), requiredInboxMutation(params));
		case "inbox.reorder":
			return {
				items: await options.runtime.reorderInbox(
					requiredTarget(params),
					requiredString(params, "mutationId"),
					requiredStringArray(params, "expectedOrder"),
					requiredStringArray(params, "desiredOrder"),
				),
			};
		case "command":
			return await runCommand(options, validateCommand(params.command));
	}
}

async function runCommand(options: ServerOptions, command: EngineCommandEnvelope): Promise<EngineCommandReceipt> {
	if (command.deviceId !== options.deviceId || command.engineId !== options.engineId) {
		throw new EngineTargetError("invalid_request", "Command identity does not match this Engine service");
	}
	if (!(await options.runtime.store.isCurrentEngineGeneration(options.runtime.engineGeneration))) {
		throw new EngineTargetError("stale_target", "Engine generation lease is no longer current");
	}
	const identity = engineCommandIdentity(command);
	let admission = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
	for (let retry = 0; admission.status === "in_progress" && retry < 100; retry++) {
		await Bun.sleep(25);
		admission = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
	}
	if (admission.status === "replay") {
		if (admission.receipt.outcome === "rejected") {
			throw new EngineTargetError(
				"invalid_request",
				String(admission.receipt.detail?.message ?? "Command was rejected"),
			);
		}
		return admission.receipt;
	}
	if (admission.status === "in_progress") throw new EngineTargetError("agent_busy", "Command is still in progress");
	try {
		const detail = await dispatchEngineCommand({
			runtime: options.runtime,
			command,
			resolveLaunchProfile: options.resolveLaunchProfile,
			provisionMailbox: options.provisionMailbox,
		});
		const receipt: EngineCommandReceipt = {
			outcome: "applied",
			...(detail && typeof detail === "object" && !Array.isArray(detail)
				? { detail: detail as Record<string, unknown> }
				: {}),
		};
		await options.runtime.store.settleCommand(command.commandId, identity.canonicalHash, receipt);
		return receipt;
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048);
		await options.runtime.store.settleCommand(command.commandId, identity.canonicalHash, {
			outcome: "rejected",
			detail: { code: error instanceof EngineTargetError ? error.code : "invalid_request", message },
		});
		throw error;
	}
}

async function capabilities(options: ServerOptions): Promise<Record<string, unknown>> {
	return {
		contractVersion: ENGINE_CONTROL_QUERY_VERSION,
		compatibleVersions: [ENGINE_CONTROL_QUERY_VERSION],
		storeEpoch: await options.runtime.store.getStoreEpoch(),
		engineGeneration: options.runtime.engineGeneration,
		deviceId: options.deviceId,
		engineId: options.engineId,
		commands: [
			"start",
			"steer",
			"pause",
			"resume",
			"cancel",
			"compact",
			"release",
			"reconcile",
			"resolve_tool_approval",
			"resolve_input",
		],
		queries: [
			"snapshots.list",
			"snapshots.get",
			"events.list",
			"result.get",
			"session.context",
			"session.history",
			"session.usage",
			"inbox.list",
			"inbox.enqueue",
			"inbox.read",
			"inbox.mutate",
			"inbox.reorder",
		],
		limits: { frameBytes: ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES, resultChars: ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS },
		cursor: { opaque: true, order: "oldest_first", gapIsExplicit: true },
		historyCursor: { opaque: true, order: "page_chronological", direction: "older", gapIsExplicit: true },
		rawDiagnostics: false,
	};
}

async function listSnapshots(runtime: EngineRuntime, cursor: string | undefined, limit: number) {
	const epoch = await runtime.store.getStoreEpoch();
	const after = decodeCursor(cursor, "snapshots", epoch);
	if (after.resyncRequired)
		return { items: [], nextCursor: encodeCursor("snapshots", epoch, 0), hasMore: false, resyncRequired: true };
	const rows = await runtime.store.listAttempts(after.position, limit + 1);
	const projected = await Promise.all(rows.slice(0, limit).map(row => snapshotFromAttempt(runtime, row)));
	const items = fitResponsePage(projected);
	const position = rows[items.length - 1]?.row_id ?? after.position;
	return {
		items,
		nextCursor: encodeCursor("snapshots", epoch, position),
		hasMore: rows.length > items.length,
		resyncRequired: false,
	};
}

async function getSnapshot(runtime: EngineRuntime, attemptId: string): Promise<EnginePublicSnapshot | undefined> {
	const attempt = await runtime.store.getAttempt(attemptId);
	if (!attempt) return undefined;
	return await snapshotFromAttempt(runtime, attempt);
}

async function snapshotFromAttempt(
	runtime: EngineRuntime,
	attempt: Awaited<ReturnType<EngineRuntime["store"]["listAttempts"]>>[number],
): Promise<EnginePublicSnapshot> {
	const binding = await runtime.store.getBinding(attempt.agent_instance_id);
	const exactBinding = binding?.attemptId === attempt.attempt_id ? binding : undefined;
	return {
		agentInstanceId: attempt.agent_instance_id,
		executionId: attempt.execution_id,
		attemptId: attempt.attempt_id,
		bindingId: attempt.binding_id,
		engineGeneration: Number(attempt.engine_generation),
		bindingGeneration: Number(attempt.binding_generation),
		authorityGeneration: Number(attempt.authority_generation),
		state: attempt.state,
		manualHold: binding?.manualHold ?? false,
		intentRevision: binding?.intentRevision ?? 0,
		retry:
			attempt.retry_attempt > 0
				? {
						attempt: Number(attempt.retry_attempt),
						maxAttempts: Number(attempt.retry_max_attempts),
						...(attempt.retry_route ? { route: attempt.retry_route } : {}),
						...(attempt.retry_delay_ms === null ? {} : { delayMs: Number(attempt.retry_delay_ms) }),
						...(attempt.retry_scheduled_at === null ? {} : { scheduledAt: Number(attempt.retry_scheduled_at) }),
						...(attempt.retry_outcome ? { outcome: attempt.retry_outcome } : {}),
						...(attempt.retry_error ? { error: attempt.retry_error } : {}),
					}
				: undefined,
		profileDigest: exactBinding?.profileDigest,
		transcriptRef: attempt.transcript_session_id ? `history://${attempt.transcript_session_id}` : undefined,
		updatedAt: Number(attempt.updated_at),
		controlReadiness: controlReadiness(attempt.state),
	};
}

async function listEvents(runtime: EngineRuntime, attemptId: string, cursor: string | undefined, limit: number) {
	const epoch = await runtime.store.getStoreEpoch();
	const after = decodeCursor(cursor, "events", epoch, attemptId);
	const bounds = await runtime.store.eventBounds(attemptId);
	const gap =
		after.resyncRequired ||
		(cursor !== undefined &&
			(after.position > bounds.last || (bounds.first > 0 && after.position < bounds.first - 1)));
	if (gap) {
		return {
			events: [],
			nextCursor: encodeCursor("events", epoch, Math.max(0, bounds.first - 1), attemptId),
			hasMore: bounds.last >= bounds.first && bounds.first > 0,
			retentionStart: bounds.first,
			resyncRequired: true,
			snapshot: await getSnapshot(runtime, attemptId),
		};
	}
	const rows = await runtime.store.eventsAfter(attemptId, after.position, limit + 1);
	const events = fitResponsePage(rows.slice(0, limit).map(publicEvent));
	const position = rows[events.length - 1]?.eventId ?? after.position;
	return {
		events,
		nextCursor: encodeCursor("events", epoch, position, attemptId),
		hasMore: rows.length > events.length,
		retentionStart: bounds.first,
		resyncRequired: false,
	};
}

async function getResult(runtime: EngineRuntime, attemptId: string): Promise<Record<string, unknown> | undefined> {
	const event = await runtime.store.terminalEvent(attemptId);
	if (!event) return undefined;
	const raw = typeof event.payload?.assistantFinal === "string" ? event.payload.assistantFinal : "";
	const outputTruncated =
		raw.length > ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS || event.payload?.outputTruncated === true;
	const assistantText = raw.slice(0, ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS);
	let structuredOutput: unknown;
	try {
		structuredOutput = raw ? JSON.parse(raw) : undefined;
	} catch {}
	return {
		attemptId,
		state: event.kind,
		assistantText,
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		resultHash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
		transcriptRef: typeof event.payload?.transcriptRef === "string" ? event.payload.transcriptRef : undefined,
		outputTruncated,
		interruption: event.kind === "interrupted" ? { cause: "engine_lost", effectAmbiguity: true } : undefined,
	};
}

async function listSessionHistory(
	runtime: EngineRuntime,
	agentInstanceId: string,
	cursor: string | undefined,
	limit: number,
) {
	const epoch = await runtime.store.getStoreEpoch();
	const history = await runtime.sessionHistory(agentInstanceId);
	const decoded = decodeCursor(cursor, "history", epoch, agentInstanceId);
	const end = cursor ? decoded.position : history.entries.length;
	const anchorMatches =
		!cursor || (end === 0 ? decoded.anchor === undefined : history.entries[end - 1]?.entryId === decoded.anchor);
	if (decoded.resyncRequired || end > history.entries.length || !anchorMatches) {
		return {
			schema: "grimoire.engine.session_history.v1",
			agentInstanceId,
			sessionId: history.sessionId,
			leafEntryId: history.leafEntryId,
			entries: [],
			previousCursor: null,
			hasMore: history.entries.length > 0,
			resyncRequired: true,
		};
	}
	const start = Math.max(0, end - limit);
	const entries = fitResponsePage(history.entries.slice(start, end).reverse()).reverse();
	const pageStart = end - entries.length;
	return {
		schema: "grimoire.engine.session_history.v1",
		agentInstanceId,
		sessionId: history.sessionId,
		leafEntryId: history.leafEntryId,
		entries,
		previousCursor:
			pageStart > 0
				? encodeCursor("history", epoch, pageStart, agentInstanceId, history.entries[pageStart - 1]?.entryId)
				: null,
		hasMore: pageStart > 0,
		resyncRequired: false,
	};
}

function publicEvent(event: EngineEvent): EngineEvent {
	const payload = event.payload;
	if (!payload) return event;
	switch (event.kind) {
		case "trace_reasoning":
			return { ...event, payload: pick(payload, ["state"]) };
		case "trace_tool":
			return { ...event, payload: pick(payload, ["toolName", "status", "durationMs"]) };
		case "tool_started":
		case "tool_settled":
			return {
				...event,
				payload: pick(payload, ["invocationId", "toolCallId", "toolName", "policy", "status", "durationMs"]),
			};
		case "model_started":
		case "model_settled":
			return { ...event, payload: pick(payload, ["effectId", "modelCallId", "status"]) };
		case "failed":
			return { ...event, payload: { error: "attempt_failed" } };
		case "interrupted":
			return { ...event, payload: pick(payload, ["cause", "lostEngineGeneration"]) };
		case "completed":
			return {
				...event,
				payload: {
					assistantFinal: String(payload.assistantFinal ?? "").slice(0, ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS),
					...(typeof payload.transcriptRef === "string" ? { transcriptRef: payload.transcriptRef } : {}),
					...(payload.outputTruncated === true ? { outputTruncated: true } : {}),
				},
			};
		default:
			return { ...event, payload: boundedRecord(payload) };
	}
}

function controlReadiness(state: EngineAttemptState) {
	return {
		steer: state === "running" || state === "pause_requested" || state === "paused",
		pause: state === "running",
		resume: state === "paused",
		cancel: ["running", "pause_requested", "paused", "waiting_input"].includes(state),
	};
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(keys.flatMap(key => (record[key] === undefined ? [] : [[key, record[key]]])));
}

function boundedRecord(record: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.stringify(record);
	return json.length <= ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS
		? record
		: { truncated: true, digest: `sha256:${createHash("sha256").update(json).digest("hex")}` };
}

function fitResponsePage<T>(items: T[]): T[] {
	const page: T[] = [];
	let bytes = 4_096;
	for (const item of items) {
		const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
		if (page.length > 0 && bytes + itemBytes > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES) break;
		page.push(item);
		bytes += itemBytes;
	}
	return page;
}

function encodeCursor(
	kind: "snapshots" | "events" | "history",
	epoch: string,
	position: number,
	scope?: string,
	anchor?: string,
): string {
	return Buffer.from(
		JSON.stringify({ kind, epoch, position, ...(scope ? { scope } : {}), ...(anchor ? { anchor } : {}) }),
		"utf8",
	).toString("base64url");
}

function decodeCursor(
	cursor: string | undefined,
	kind: "snapshots" | "events" | "history",
	epoch: string,
	scope?: string,
): { position: number; anchor?: string; resyncRequired: boolean } {
	if (!cursor) return { position: 0, resyncRequired: false };
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
		if (
			value.kind !== kind ||
			value.epoch !== epoch ||
			(scope !== undefined && value.scope !== scope) ||
			!Number.isSafeInteger(value.position) ||
			Number(value.position) < 0
		) {
			return { position: 0, resyncRequired: true };
		}
		if (value.anchor !== undefined && (typeof value.anchor !== "string" || !value.anchor)) {
			return { position: 0, resyncRequired: true };
		}
		return {
			position: Number(value.position),
			...(typeof value.anchor === "string" ? { anchor: value.anchor } : {}),
			resyncRequired: false,
		};
	} catch {
		return { position: 0, resyncRequired: true };
	}
}

function validateRequest(value: unknown): EngineControlQueryRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be an object");
	const request = value as Record<string, unknown>;
	if (request.schema !== "grimoire.engine.control_query.request.v1") throw new Error("Unsupported request schema");
	if (request.version !== ENGINE_CONTROL_QUERY_VERSION) throw new Error("Unsupported Control + Query version");
	const method = requiredString(request, "method");
	if (
		![
			"capabilities",
			"snapshots.list",
			"snapshots.get",
			"events.list",
			"result.get",
			"session.context",
			"session.history",
			"session.usage",
			"inbox.list",
			"inbox.enqueue",
			"inbox.read",
			"inbox.mutate",
			"inbox.reorder",
			"command",
		].includes(method)
	) {
		throw new Error(`Unsupported method ${method}`);
	}
	const params = request.params;
	if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) {
		throw new Error("params must be an object");
	}
	return {
		schema: request.schema,
		version: request.version,
		requestId: requiredString(request, "requestId"),
		token: requiredString(request, "token"),
		method: method as EngineControlQueryMethod,
		params: params as Record<string, unknown> | undefined,
	};
}

function validateCommand(value: unknown): EngineCommandEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command must be an object");
	const command = value as Record<string, unknown>;
	if (command.schema !== "grimoire.engine.command.v1") throw new Error("Unsupported command schema");
	const op = requiredString(command, "op");
	if (
		![
			"start",
			"steer",
			"pause",
			"resume",
			"cancel",
			"compact",
			"release",
			"reconcile",
			"resolve_tool_approval",
			"resolve_input",
		].includes(op)
	) {
		throw new Error(`Unsupported command op ${op}`);
	}
	for (const key of ["commandId", "deviceId", "engineId", "agentInstanceId"] as const) requiredString(command, key);
	for (const key of ["engineGeneration", "authorityGeneration", "issuedAt"] as const) requiredInteger(command, key);
	if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
		throw new Error("command.payload must be an object");
	}
	return command as unknown as EngineCommandEnvelope;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
	return value;
}

function requiredTarget(record: Record<string, unknown>): EngineTarget {
	return {
		bindingId: requiredString(record, "bindingId"),
		agentInstanceId: requiredString(record, "agentInstanceId"),
		executionId: requiredString(record, "executionId"),
		attemptId: requiredString(record, "attemptId"),
		authorityGeneration: requiredInteger(record, "authorityGeneration"),
		engineGeneration: requiredInteger(record, "engineGeneration"),
		bindingGeneration: requiredInteger(record, "bindingGeneration"),
	};
}

function requiredInboxMutation(record: Record<string, unknown>): EngineInboxMutation {
	const op = requiredString(record, "op");
	if (!["edit", "annotate", "defer", "acknowledge", "drop"].includes(op)) {
		throw new Error(`Unsupported inbox mutation ${op}`);
	}
	const value = record.value;
	if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") {
		throw new Error("value must be a string, number or null");
	}
	return {
		mutationId: requiredString(record, "mutationId"),
		queueId: requiredString(record, "queueId"),
		expectedRevision: requiredInteger(record, "expectedRevision"),
		op: op as EngineInboxMutation["op"],
		...(value === undefined ? {} : { value }),
	};
}

function requiredInboxSource(record: Record<string, unknown>): EngineInboxSource {
	const sourceType = requiredString(record, "sourceType");
	if (sourceType !== "user" && sourceType !== "agent" && sourceType !== "runtime") {
		throw new Error("sourceType must be user, agent or runtime");
	}
	const deliverAt = record.deliverAt;
	if (deliverAt !== undefined && (!Number.isSafeInteger(deliverAt) || Number(deliverAt) < 0)) {
		throw new Error("deliverAt must be a non-negative safe integer");
	}
	return {
		sourceEventId: requiredString(record, "sourceEventId"),
		sourceType,
		...(typeof record.sender === "string" && record.sender.trim() ? { sender: record.sender } : {}),
		body: requiredString(record, "body"),
		createdAt: requiredInteger(record, "createdAt"),
		...(deliverAt === undefined ? {} : { deliverAt: Number(deliverAt) }),
		wakeIntent: record.wakeIntent === true,
	};
}

function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
		throw new Error(`${key} must be an array of non-empty strings`);
	}
	return value;
}

function optionalBoolean(value: unknown): boolean {
	return value === true;
}

function optionalString(value: unknown): string | undefined {
	return value === undefined ? undefined : typeof value === "string" ? value : undefined;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${key} must be a non-negative safe integer`);
	return Number(value);
}

function optionalLimit(value: unknown): number {
	return Number.isSafeInteger(value) ? Math.max(1, Math.min(1000, Number(value))) : 100;
}

function sameSecret(candidate: string, expected: string): boolean {
	const left = Buffer.from(candidate);
	const right = Buffer.from(expected);
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function success(requestId: string, result: unknown): EngineControlQueryResponse {
	return {
		schema: "grimoire.engine.control_query.response.v1",
		version: ENGINE_CONTROL_QUERY_VERSION,
		requestId,
		ok: true,
		result,
	};
}

function failure(requestId: string, code: string, message: string, retryable: boolean): EngineControlQueryResponse {
	return {
		schema: "grimoire.engine.control_query.response.v1",
		version: ENGINE_CONTROL_QUERY_VERSION,
		requestId,
		ok: false,
		error: { code, message: message.slice(0, 2_048), retryable },
	};
}

function writeResponse(socket: net.Socket, response: EngineControlQueryResponse): void {
	if (socket.destroyed) return;
	let serialized = JSON.stringify(response);
	if (Buffer.byteLength(serialized, "utf8") > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES) {
		serialized = JSON.stringify(failure(response.requestId, "response_too_large", "Response exceeds 256 KiB", false));
	}
	socket.write(`${serialized}\n`);
}

function requestOnce(endpoint: string, request: EngineControlQueryRequest, timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(endpoint);
		let buffered = Buffer.alloc(0);
		const fail = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error("Engine Control + Query request timed out")));
		socket.once("error", fail);
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", chunk => {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			if (buffered.byteLength > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES)
				return fail(new Error("Response exceeds 256 KiB"));
			const newline = buffered.indexOf(10);
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as EngineControlQueryResponse;
				socket.end();
				if (!response.ok)
					return reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
				resolve(response.result);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
