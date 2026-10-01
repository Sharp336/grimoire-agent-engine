import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import {
	type ApprovalRequest,
	type EngineExecutionConfiguration,
	type EngineAttemptState,
	type EngineBindingGate,
	type EngineBindingResult,
	EngineBindingPendingError,
	EngineRoutingQueuedError,
	type EngineEvent,
	type EngineInboxMutation,
	type EngineInboxSource,
	type ExecutorRouteState,
	type EngineSemanticBindingSnapshot,
	type EngineTarget,
	EngineTargetError,
	sameSemanticBinding,
	USAGE_PROBE_MAX_TIMEOUT_MS,
} from "./contracts";
import { resolveCanonicalModelLimits } from "./model-limits";
import { dispatchEngineCommand, type EngineCommandEnvelope, engineCommandIdentity } from "./nats-adapter";
import { safeEngineErrorDetail } from "./public-error";
import { engineAgentId } from "./route";
import { retryFromAttempt } from "./rocks-runtime-projection";
import { type EngineRuntime, nativeArchiveUnsupported } from "./runtime";
import { storageCanonicalJson } from "../session/storage-client";
import type { EngineAttachmentStageRequest } from "./runtime-attachments";
import { RuntimeQueryError } from "./runtime-projection";
import {
	ENGINE_CONTROL_OPS,
	RUNTIME_PROTOCOL_HASH,
	RUNTIME_PROTOCOL_REVISION,
	type RuntimeAccess,
	type RuntimeEventsRequest,
	type RuntimeScope,
	type RuntimeWork,
	runtimeLimits,
	validateRuntimeValue,
} from "./runtime-protocol";
import type { RuntimeQueueRequest } from "./runtime-queue";
import type { RuntimePageRequest, RuntimeResourceRequest } from "./runtime-resources";
import { EngineCommandConflictError, type EngineCommandReceipt } from "./store";
import { waitForEngineWake } from "./wake";
import { runUsageProbe } from "./usage-probe";

export const ENGINE_CONTROL_QUERY_VERSION = "1.0";

const queuedCommandReplays = new WeakMap<EngineRuntime, Map<string, Promise<void>>>();

/** Control+Query has no broker redelivery; replay the exact pending command on native owner wakes. */
function replayQueuedCommand(
	options: Pick<ServerOptions, "runtime" | "deviceId" | "engineId" | "provisionMailbox">,
	command: EngineCommandEnvelope,
): void {
	let running = queuedCommandReplays.get(options.runtime);
	if (!running) queuedCommandReplays.set(options.runtime, running = new Map());
	if (running.has(command.commandId)) return;
	const pending = (async () => {
		for (;;) {
			await waitForEngineWake(options.runtime.store.changeSignal(), 1_000);
			if (!(await options.runtime.store.isCurrentEngineGeneration(options.runtime.engineGeneration))) return;
			try {
				await runEngineCommand(options, command);
				return;
			} catch (error) {
				if (error instanceof EngineRoutingQueuedError || error instanceof EngineBindingPendingError) continue;
				logger.warn("Queued Engine command replay failed", { commandId: command.commandId,
					error: error instanceof Error ? error.message : String(error) });
				return;
			}
		}
	})().catch(error => {
		logger.warn("Queued Engine command wake failed", { commandId: command.commandId,
			error: error instanceof Error ? error.message : String(error) });
	});
	running.set(command.commandId, pending);
	void pending.finally(() => running.delete(command.commandId));
}
export const ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES = 256 * 1024;
export const ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS = 48_000;

export type EngineControlQueryMethod =
	| "capabilities"
	| "installation.verify"
	| "binding.prepare"
	| "binding.census"
	| "binding.adopt"
	| "binding.activate"
	| "binding.abort"
	| "runtime.capabilities"
	| "runtime.snapshot"
	| "runtime.target"
	| "runtime.summary"
	| "runtime.input"
	| "runtime.holds"
	| "runtime.resource"
	| "runtime.messages"
	| "runtime.tools"
	| "runtime.events.wait"
	| "runtime.command.get"
	| "approval.get"
	| "approval.authorize"
	| "approval.grant"
	| "runtime.context"
	| "runtime.usage"
	| "runtime.queue"
	| "runtime.history"
	| "runtime.history.entry"
	| "snapshots.list"
	| "snapshots.get"
	| "events.list"
	| "result.get"
	| "session.context"
	| "session.history"
	| "session.archive"
	| "session.archive.verify"
	| "session.archive.retire"
	| "session.archive.restore"
	| "chat.lifecycle"
	| "chat.archived.list"
	| "storage.reclaim"
	| "session.restore.stage"
	| "attachments.stage"
	| "attachments.remove"
	| "session.restore.history"
	| "session.usage"
	| "models.reference"
	| "inbox.list"
	| "inbox.enqueue"
	| "inbox.read"
	| "inbox.mutate"
	| "inbox.reorder"
	| "usage_probe_binding.get"
	| "usage_probe_binding.set"
	| "usage_probe.run"
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
			error: { code: string; message: string; retryable: boolean; work?: RuntimeWork };
	  };

export interface EnginePublicSnapshot {
	bindingSnapshot?: EngineSemanticBindingSnapshot;
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
	executorRoute?: ExecutorRouteState;
	executionDigest?: string;
	continuationDigest?: string;
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
	const admission = { ordinary: 0, control: 0 };
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		serveSocket(socket, token, options, admission);
	});
	let closing: Promise<void> | undefined;
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
			closing ??= (async () => {
				const closed = new Promise<void>((resolve, reject) =>
					server.close(error => (error ? reject(error) : resolve())),
				);
				// Closing the listener alone retains 25-second observers and prevents orderly owner shutdown.
				for (const socket of sockets) socket.destroy();
				await closed;
				if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
			})();
			await closing;
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
		let timeoutMs = this.#timeoutMs;
		if (method === "usage_probe.run" && params?.kind === "module") {
			const binding = await this.request("usage_probe_binding.get", {
				principalId: params.principalId, accountRef: params.accountRef,
			}) as { timeoutMs: number };
			if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs < 1 ||
				binding.timeoutMs > USAGE_PROBE_MAX_TIMEOUT_MS)
				throw new Error("Engine returned an invalid usage probe timeout");
			timeoutMs = Math.max(timeoutMs, binding.timeoutMs + 5_000);
		}
		return await requestOnce(engineControlQueryEndpoint(this.#runtimeDir), request, timeoutMs);
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

function serveSocket(
	socket: net.Socket,
	token: string,
	options: ServerOptions,
	admission: { ordinary: number; control: number },
): void {
	let buffered = Buffer.alloc(0);
	let inFlight = 0;
	const cancellation = new AbortController();
	socket.on("end", () => cancellation.abort());
	socket.on("close", () => cancellation.abort());
	socket.on("error", error => {
		cancellation.abort(error);
		socket.destroy();
		// A cancelled reader may close after the writable check but before the OS write.
		// Keep unexpected socket failures visible; only disconnect errors belong to this request.
		if (!isSocketDisconnect(error)) throw error;
	});
	// Idle connections close; an in-flight request (e.g. a configured probe deadline beyond 30 s)
	// keeps its socket, and disconnect still cancels it.
	socket.setTimeout(30_000, () => {
		if (inFlight === 0) socket.destroy();
	});
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
			let control = false;
			let method = "";
			try {
				const parsed = JSON.parse(frame.toString("utf8"));
				method = typeof parsed.method === "string" ? parsed.method : "";
				control = parsed.method === "command" && Object.hasOwn(ENGINE_CONTROL_OPS, parsed.params?.command?.op);
			} catch {}
			const lane = control ? "control" : "ordinary";
			if (admission[lane] >= (control ? runtimeLimits.controlRpc : runtimeLimits.pendingRpc)) {
				writeResponse(socket, failure("", "queue_full", "Control + Query request budget is full", true));
				continue;
			}
			admission[lane]++;
			inFlight++;
			void handleFrame(frame, token, options, cancellation.signal)
				.then(response => writeResponse(socket, response, runtimeResponseBytes(method)))
				.catch(() => socket.destroy())
				.finally(() => {
					admission[lane]--;
					inFlight--;
				});
		}
	});
}

async function handleFrame(
	frame: Buffer,
	token: string,
	options: ServerOptions,
	signal?: AbortSignal,
): Promise<EngineControlQueryResponse> {
	if (frame.byteLength === 0 || frame.byteLength > ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES) {
		return failure("", "frame_too_large", "Request frame is outside the accepted range", false);
	}
	let requestId = "";
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
		const request = validateRequest(value);
		requestId = request.requestId;
		if (!sameSecret(request.token, token)) return failure(requestId, "unauthorized", "Invalid local token", false);
		const result = await options.runtime.runControlQuery(() => dispatchRequest(request, options, signal));
		return success(requestId, result);
	} catch (error) {
		if (error instanceof EngineBindingPendingError) return failure(requestId, error.code, error.message, true);
		if (error instanceof RuntimeQueryError) return failure(requestId, error.code, error.message, false, error.work);
		if (error instanceof EngineTargetError) return failure(requestId, error.code, error.message, false);
		if (error instanceof EngineCommandConflictError)
			return failure(requestId, "command_id_conflict", error.message, false);
		return failure(requestId, "invalid_request", error instanceof Error ? error.message : String(error), false);
	}
}

async function dispatchRequest(
	request: EngineControlQueryRequest,
	options: ServerOptions,
	signal?: AbortSignal,
): Promise<unknown> {
	const params = request.params ?? {};
	switch (request.method) {
		case "usage_probe_binding.get":
			return options.runtime.store.getUsageProbeBinding(
				requiredString(params, "principalId"), options.deviceId, requiredString(params, "accountRef"));
		case "usage_probe_binding.set": {
			const principal = requiredString(params, "principalId");
			const account = requiredString(params, "accountRef");
			const expectedRevision = requiredInteger(params, "expectedRevision");
			const modulePath = params.modulePath;
			if (modulePath !== null && (typeof modulePath !== "string" || !path.isAbsolute(modulePath)))
				throw new EngineTargetError("invalid_request", "Usage module path must be absolute");
			const normalized = modulePath === null ? null : path.normalize(modulePath);
			if (normalized !== null && !(await fs.stat(normalized).catch(() => null))?.isFile())
				throw new EngineTargetError("invalid_request", "Usage module path must name an existing regular file");
			const timeoutMs = params.timeoutMs;
			if (timeoutMs !== undefined &&
				(!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > USAGE_PROBE_MAX_TIMEOUT_MS))
				throw new EngineTargetError("invalid_request", `Usage probe timeoutMs must be an integer 1..${USAGE_PROBE_MAX_TIMEOUT_MS}`);
			return options.runtime.store.setUsageProbeBinding(principal, options.deviceId, account, expectedRevision, normalized,
				timeoutMs as number | undefined);
		}
		case "usage_probe.run":
			return runUsageProbe(options.runtime.store, options.deviceId, params, signal);
		case "installation.verify": {
			if (params.deviceId !== options.deviceId || params.engineId !== options.engineId ||
				params.runtimeContractRevision !== RUNTIME_PROTOCOL_REVISION || params.runtimeContractHash !== RUNTIME_PROTOCOL_HASH)
				throw new EngineTargetError("stale_target", "Installation verification contour mismatch");
			const installationId = requiredString(params, "installationId");
			options.runtime.verifyInstallation(installationId, requiredString(params, "principalId"));
			return { installationId, verified: true };
		}
		case "binding.prepare":
			return { gate: await options.runtime.prepareSemanticBinding(params.gate as EngineBindingGate) };
		case "binding.census":
			return options.runtime.store.bindingCensus({
				agentInstanceRef: requiredString(params, "agentInstanceRef"),
				installationId: requiredString(params, "installationId"),
				operationId: requiredString(params, "operationId"),
				proposalHash: requiredString(params, "proposalHash"),
				bindingRevision: requiredInteger(params, "bindingRevision"),
			}, options.runtime.engineGeneration);
		case "binding.adopt":
			return { gate: await options.runtime.adoptSemanticBinding(params.gate as EngineBindingGate, params.result as EngineBindingResult) };
		case "binding.activate":
		case "binding.abort":
			return { gate: await options.runtime.finishSemanticBinding(
				request.method === "binding.activate" ? "activate" : "abort", params.result as EngineBindingResult) };
		case "runtime.capabilities":
			return {
				...runtimeCapabilities(),
				ownershipMigration: await options.runtime.store.ownershipMigrationStatus(),
			};
		case "runtime.snapshot":
			return await options.runtime.store.runtimeSnapshot(
				runtimeScope(params),
				runtimeAccess(params),
				optionalString(params.cursor),
				optionalLimit(params.limit),
				params.maxBytes === undefined ? runtimeLimits.httpPageBytes : optionalNonNegativeInteger(params.maxBytes),
			);
		case "runtime.events.wait": {
			validateRuntimeValue("nativeEventsRequest", params);
			return await options.runtime.store.waitRuntimeEvents(params as unknown as RuntimeEventsRequest, signal);
		}
		case "runtime.target":
			return await runtimeAgent(options.runtime, params);
		case "runtime.summary":
			return await options.runtime.store.runtimeSummary({
				agentInstanceRef: requiredString(params, "agentInstanceRef"),
				...runtimeAccess(params),
			});
		case "runtime.input":
			return await options.runtime.store.runtimeInput(params as unknown as RuntimePageRequest);
		case "runtime.holds":
			return await options.runtime.store.runtimeHolds(params as unknown as RuntimePageRequest);
		case "runtime.resource":
			return await options.runtime.store.runtimeResource(params as unknown as RuntimeResourceRequest);
		case "runtime.messages":
			return await options.runtime.store.runtimeMessages(params as unknown as RuntimePageRequest);
		case "runtime.tools":
			return await options.runtime.store.runtimeTools(params as unknown as RuntimePageRequest);
		case "approval.grant": {
			const caller = params.callerContext as Record<string, unknown> | undefined;
			if (!caller || typeof caller.attemptId !== "string" || typeof caller.agentInstanceRef !== "string")
				throw new EngineTargetError("stale_target", "Grant requires its exact approving Attempt");
			const actor = await options.runtime.store.getAttempt(caller.attemptId);
			const start = actor && await options.runtime.store.getStartConversationIdentity(actor.command_id);
			if (!actor || !start?.principalId || actor.state !== "running" ||
				actor.binding_snapshot?.agentInstanceRef !== caller.agentInstanceRef ||
				!sameSemanticBinding(actor.binding_snapshot, caller.bindingSnapshot as EngineSemanticBindingSnapshot) ||
				actor.execution?.dispatch_hash !== caller.dispatchHash ||
				(params.principalId !== undefined && params.principalId !== start.principalId))
				throw new EngineTargetError("stale_target", "Grant approver binding is not live");
			const receipt = await options.runtime.store.runtimeCommand(actor.command_id, { principalId: start.principalId });
			if (receipt.stage !== "applied" || !receipt.lease ||
				typeof receipt.lease !== "object" || !("held" in receipt.lease) || receipt.lease.held !== true)
				throw new EngineTargetError("stale_target", "Grant requires the live approver lease");
			const kind = requiredString(params, "kind");
			if (kind !== "tool" && kind !== "spawn")
				throw new EngineTargetError("invalid_request", "Only tool and spawn support persistent grants");
			const grantReceipt = options.runtime.approvalGrant(actor.agent_instance_id, actor.attempt_id, kind,
				requiredString(params, "name"), requiredString(params, "ceiling_hash"), requiredString(params, "receiptId"));
			if (!grantReceipt) throw new EngineTargetError("stale_target", "Grant exceeds the current approver ceiling");
			return { receiptId: grantReceipt };
		}
		case "approval.get":
		case "approval.authorize": {
			const id = requiredString(params, "requestId");
			const principalId = requiredString(params, "principalId");
			const approval = await options.runtime.store.getApproval(id);
			const local = approval?.request;
			const supplied = request.method === "approval.authorize" && params.request !== undefined
				? params.request as ApprovalRequest : undefined;
			if (supplied) validateRuntimeValue("approvalRequest", supplied);
			if (supplied && local && storageCanonicalJson(supplied) !== storageCanonicalJson(local))
				throw new EngineTargetError("stale_target", "Approval differs from its requester Engine");
			const approvalRequest = supplied ?? local;
			if (!approvalRequest || approvalRequest.id !== id || approvalRequest.principal_id !== principalId)
				throw new EngineTargetError("agent_not_found", "Approval request is not accessible");
			const attempt = local && await options.runtime.store.getAttempt(approvalRequest.requester_attempt_id);
			if (local && (!attempt || !attempt.execution || attempt.execution.dispatch_hash !== approvalRequest.dispatch_hash))
				throw new EngineTargetError("stale_target", "Requester Attempt has no admitted approval");
			const inputRevision = attempt?.input_revision;
			if (params.expectedInputRevision !== undefined &&
				(inputRevision === undefined || requiredInteger(params, "expectedInputRevision") !== inputRevision))
				throw new EngineTargetError("stale_target", "Approval input revision changed");
			if (request.method === "approval.authorize" &&
				(!["pending", "waiting_human_paused", "waiting_human_pending"].includes(approvalRequest.status) ||
					(local && approval?.state !== "pending")))
				throw new EngineTargetError("too_late", "Approval request is no longer pending");
			let ceiling_hash = "ceiling_hash" in approvalRequest.subject
				? approvalRequest.subject.ceiling_hash : approvalRequest.settings_hash;
			if (request.method === "approval.authorize") {
				const caller = params.callerContext as Record<string, unknown> | undefined;
				if (!caller || approvalRequest.requires_human || approvalRequest.addressed_to.kind !== "attempt" ||
					caller.agentInstanceRef !== approvalRequest.addressed_to.agent_ref ||
					caller.attemptId !== approvalRequest.addressed_to.attempt_id ||
					caller.attemptId === approvalRequest.requester_attempt_id)
					throw new EngineTargetError("stale_target", "Caller is not the addressed ancestor");
				const ancestorDistance = requiredInteger(params, "ancestorDistance");
				if (ancestorDistance < 1 ||
					(local && attempt?.binding_snapshot?.parentAttemptId === caller.attemptId &&
						ancestorDistance !== 1))
					throw new EngineTargetError("stale_target", "Approver distance is not backed by the admitted chain");
				const actor = await options.runtime.store.getAttempt(String(caller.attemptId));
				const actorBinding = actor && await options.runtime.store.getBinding(actor.agent_instance_id);
				const actorCommand = actor && await options.runtime.store.getStartConversationIdentity(actor.command_id);
				const rawConfig = actorCommand?.serializedCommand &&
					(JSON.parse(actorCommand.serializedCommand) as EngineCommandEnvelope).payload.executionConfiguration;
				if (rawConfig) validateRuntimeValue("engineExecutionConfiguration", rawConfig);
				const actorConfig = rawConfig as EngineExecutionConfiguration | undefined;
				const actorReceipt = actor && await options.runtime.store.runtimeCommand(actor.command_id, { principalId });
				if (!actor || !actor.execution || !actorCommand || !actorConfig ||
					!actorBinding || actorBinding.attemptId !== actor.attempt_id ||
					actorBinding.engineGeneration !== options.runtime.engineGeneration ||
					!sameSemanticBinding(actorBinding.bindingSnapshot, actor.binding_snapshot) ||
					actor.state !== "running" ||
					actorCommand.agentInstanceRef !== caller.agentInstanceRef ||
					!sameSemanticBinding(actor.binding_snapshot, caller.bindingSnapshot as EngineSemanticBindingSnapshot) ||
					actor.execution.dispatch_hash !== caller.dispatchHash ||
					!actorReceipt || actorReceipt.stage !== "applied" ||
					!actorReceipt.lease || typeof actorReceipt.lease !== "object" ||
					!("held" in actorReceipt.lease) || actorReceipt.lease.held !== true)
					throw new EngineTargetError("stale_target", "Approving ancestor has no live admitted lease");
				const dispatch = actorConfig.dispatch;
				const current = actor.execution.executor_choice.selected;
				const route = actorConfig.routes.routes.find(candidate =>
					candidate.route_ref === current.route_ref && candidate.effort === current.effort &&
					candidate.service_tier === current.service_tier);
				const name = approvalRequest.kind === "consultant" ? "grimoire_consultant_run" : approvalRequest.name;
				const trusted = route?.execution.trusted === true;
				const toolCapable = (dispatch.tools === null || dispatch.tools.includes(name)) &&
					!dispatch.tools_permit.includes(name) && trusted;
				const spawnCapable = approvalRequest.kind === "spawn" &&
					dispatch.spawn.allowed === "auto" &&
					dispatch.spawn.max_depth >= ancestorDistance + 1 &&
					dispatch.spawn.max_children >= approvalRequest.subject.requested_child_ordinal;
				if (!((approvalRequest.kind === "tool" || approvalRequest.kind === "consultant")
					? toolCapable : spawnCapable))
					throw new EngineTargetError("stale_target", "Caller lacks the current approval ceiling");
				ceiling_hash = `sha256:${createHash("sha256").update(storageCanonicalJson({
					tools: dispatch.tools, tools_permit: dispatch.tools_permit, spawn: dispatch.spawn, trusted,
				})).digest("hex")}`;
				if (params.grant === true) {
					if (approvalRequest.requires_human || ancestorDistance !== 1 ||
						(approvalRequest.kind !== "tool" && approvalRequest.kind !== "spawn"))
						throw new EngineTargetError("stale_target", "Grant only covers a direct child's tool or spawn");
					const grantReceipt = options.runtime.approvalGrant(actor.agent_instance_id, actor.attempt_id,
						approvalRequest.kind, approvalRequest.name, ceiling_hash);
					if (!grantReceipt) throw new EngineTargetError("stale_target", "Live approver lacks the exact grant");
					return { request: approvalRequest, inputRevision, ceiling_hash,
						subject_hash: `sha256:${createHash("sha256").update(storageCanonicalJson(approvalRequest.subject)).digest("hex")}`,
						grant_receipt_id: grantReceipt };
				}
			}
			const subject_hash = `sha256:${createHash("sha256").update(storageCanonicalJson(approvalRequest.subject)).digest("hex")}`;
			return { request: approvalRequest, inputRevision, ceiling_hash, subject_hash };
		}
		case "runtime.command.get": {
			const effectProof = params.effectId === undefined ? undefined : {
				effectId: requiredString(params, "effectId"),
				toolCallId: requiredString(params, "toolCallId"),
				toolName: requiredString(params, "toolName"),
			};
			return await options.runtime.store.runtimeCommand(
				requiredString(params, "commandId"),
				runtimeAccess(params),
				optionalString(params.browserPayloadHash),
				effectProof,
				params.includeStartCommand === true,
			);
		}
		case "runtime.context":
			return await options.runtime.sessionContext(await runtimeTarget(options.runtime, params));
		case "runtime.usage":
			return await options.runtime.sessionUsage(await runtimeTarget(options.runtime, params), signal);
		case "runtime.queue":
			return await options.runtime.store.runtimeQueue(params as unknown as RuntimeQueueRequest);
		case "runtime.history": {
			const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...request } = params;
			validateRuntimeValue("historyReadRequest", request);
			const agent = await runtimeAgent(options.runtime, params);
			const readStarted = performance.now();
			const agentInstanceId = requiredString(agent, "agentInstanceId");
			const agentInstanceRef = requiredString(params, "agentInstanceRef");
			const limit = optionalLimit(params.limit) ?? runtimeLimits.httpPageRecords;
			if (params.activityCursor) {
				const page = await options.runtime.store.nativeLifecyclePage(
					agentInstanceId,
					agentInstanceRef,
					limit,
					optionalString(params.attemptId),
					undefined,
					String(params.activityCursor),
				);
				const result = {
					version: "1.0",
					agentInstanceRef,
					...(agent.bindingSnapshot ? { bindingSnapshot: agent.bindingSnapshot } : {}),
					sessionId: page.sessionId,
					revision: page.revision,
					anchor: page.anchor,
					entries: [],
					nextCursor: null,
					activities: page.activities,
					activityNextCursor: page.activityNextCursor,
					work: page.work,
				};
				finishRuntimeHistory(result, readStarted);
				return result;
			}
			const page = await options.runtime.sessionHistoryPage(
				agentInstanceId,
				agentInstanceRef,
				optionalString(params.cursor),
				Math.ceil(limit / 2),
				optionalString(params.attemptId),
			);
			const resource = (ref: NonNullable<typeof page.entryRef>) => ({
				kind: "history_entry",
				agentInstanceRef,
				sessionId: page.sessionId,
				entryId: ref.entryId,
				revision: ref.revision,
				...(params.attemptId ? { attemptId: params.attemptId } : {}),
				mediaType: "application/json",
				bytes: ref.bytes,
			});
			const result = {
				version: "1.0",
				agentInstanceRef,
				...(agent.bindingSnapshot ? { bindingSnapshot: agent.bindingSnapshot } : {}),
				sessionId: page.sessionId,
				revision: page.revision,
				anchor: page.anchor,
				entries: page.entries,
				nextCursor: page.nextCursor,
				activities: [] as Record<string, unknown>[],
				activityNextCursor: null as string | null,
				...(page.entryRef ? { entryRef: resource(page.entryRef) } : {}),
				work: {
					bytes: 0,
					changes: page.entries.length + (page.entryRef ? 1 : 0),
					scannedRows: page.visitedRecords,
					materializedBytes: page.readBytes,
					elapsedMs: Math.ceil(performance.now() - readStarted),
				},
			};
			if (
				(Buffer.byteLength(JSON.stringify(result)) >
					runtimeLimits.httpPageBytes - runtimeLimits.bulkPreviewBytes * 2 ||
					(!result.entries.length && page.entries.length === 0 && page.readBytes > 0)) &&
				page.projectionFallback
			) {
				// Canonical JSON can expand when tool arguments become public text or an error is echoed.
				// Advance exactly one native entry; the remaining selected rows stay reachable by the cursor.
				result.entries = [];
				result.entryRef = resource(page.projectionFallback.entryRef);
				result.nextCursor = page.projectionFallback.nextCursor;
				result.work.changes = 1;
				page.lifecycleContext.count = 1;
			}
			let activityLimit = limit - result.work.changes;
			// Reserve metadata discovery and one lookahead per reachable Attempt.
			if (
				result.work.scannedRows + page.lifecycleContext.count * 3 + activityLimit + 6 >
				runtimeLimits.bootstrapScannedRows
			)
				activityLimit = 0;
			try {
				const lifecycle = await options.runtime.store.nativeLifecyclePage(
					agentInstanceId,
					agentInstanceRef,
					activityLimit,
					optionalString(params.attemptId),
					page.lifecycleContext,
					undefined,
					runtimeLimits.httpPageBytes -
						Buffer.byteLength(JSON.stringify(result)) -
						runtimeLimits.bulkPreviewBytes * 2,
					{
						bytes: runtimeLimits.httpPageBytes,
						changes: limit,
						scannedRows: runtimeLimits.bootstrapScannedRows - result.work.scannedRows,
						materializedBytes: runtimeLimits.bootstrapMaterializedBytes - result.work.materializedBytes,
						timeMs: runtimeLimits.bootstrapTimeoutMs - result.work.elapsedMs,
					},
				);
				const entries = new Set(result.entries.map(entry => entry.entryId));
				result.activities = lifecycle.activities.map(activity => {
					if (typeof activity.afterEntryId !== "string" || entries.has(activity.afterEntryId)) return activity;
					const { afterEntryId: _anchor, ...unanchored } = activity;
					return unanchored;
				});
				result.activityNextCursor = lifecycle.activityNextCursor;
				result.work.changes += result.activities.length;
				result.work.scannedRows += lifecycle.work.scannedRows;
				result.work.materializedBytes += lifecycle.work.materializedBytes;
			} catch (error) {
				if (error instanceof RuntimeQueryError && error.code === "restore_budget")
					throw new RuntimeQueryError("restore_budget", error.message, {
						...error.work,
						scannedRows: result.work.scannedRows + error.work.scannedRows,
						materializedBytes: result.work.materializedBytes + error.work.materializedBytes,
						elapsedMs: Math.ceil(performance.now() - readStarted),
					});
				throw error;
			}
			finishRuntimeHistory(result, readStarted);
			return result;
		}
		case "runtime.history.entry": {
			const agent = await runtimeAgent(options.runtime, params, true);
			return await options.runtime.store.nativeHistoryEntry(
				requiredString(agent, "agentInstanceId"),
				requiredString(params, "entryId"),
				requiredString(params, "revision"),
				optionalNonNegativeInteger(params.offset),
				params.limit === undefined ? runtimeLimits.deliveryBatchBytes : optionalNonNegativeInteger(params.limit),
				requiredString(params, "sessionId"),
				requiredString(params, "attemptId"),
			);
		}
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
		case "session.history": {
			const agent = await runtimeAgent(options.runtime, params, true);
			if (requiredString(agent, "agentInstanceId") !== requiredString(params, "agentInstanceId"))
				throw new EngineTargetError("stale_target", "Historical AgentInstance identity changed");
			return await listSessionHistory(
				options.runtime, requiredString(params, "agentInstanceId"),
				requiredString(params, "agentInstanceRef"), requiredString(params, "attemptId"),
				optionalString(params.cursor), optionalLimit(params.limit),
			);
		}
		case "session.archive":
		case "session.archive.verify":
		case "session.archive.retire":
		case "session.archive.restore":
		case "session.restore.history":
		case "session.restore.stage":
		case "storage.reclaim":
			throw nativeArchiveUnsupported();
		case "chat.lifecycle": {
			const action = requiredString(params, "action");
			if (!(["status", "archive", "unarchive", "delete"] as string[]).includes(action))
				throw new EngineTargetError("invalid_request", "Unknown chat lifecycle action");
			return options.runtime.chatLifecycle(
				requiredString(params, "agentInstanceRef"),
				requiredString(params, "principalId"),
				action as "status" | "archive" | "unarchive" | "delete",
				optionalString(params.operationId),
				params.expectedRevision === undefined ? undefined : requiredNonNegativeInteger(params, "expectedRevision"),
			);
		}
		case "chat.archived.list":
			return options.runtime.archivedChats(requiredString(params, "principalId"), optionalString(params.cursor));
		case "attachments.stage": {
			validateRuntimeValue("nativeAttachmentStageRequest", params);
			const { principalId, ...chunk } = params;
			return await options.runtime.attachmentUploads.stage(
				principalId as string,
				chunk as unknown as EngineAttachmentStageRequest,
				signal,
			);
		}
		case "attachments.remove":
			validateRuntimeValue("nativeAttachmentRemoveRequest", params);
			return await options.runtime.attachmentUploads.remove(
				requiredString(params, "principalId"),
				requiredString(params, "uploadId"),
			);
		case "session.usage":
			return await options.runtime.sessionUsage(requiredTarget(params), signal);
		case "models.reference": {
			if (params.modelIds !== undefined) {
				const ids = requiredStringArray(params, "modelIds");
				if (ids.length > 64 || ids.some(id => id.length > 300))
					throw new Error("At most 64 bounded model ids are allowed");
				return {
					models: ids.map(modelIdentityId => {
						const reference = resolveCanonicalModelLimits(modelIdentityId);
						return reference
							? { status: "resolved", modelIdentityId, ...reference }
							: { status: "unknown", modelIdentityId };
					}),
				};
			}
			const modelIdentityId = requiredString(params, "modelIdentityId");
			const limits = resolveCanonicalModelLimits(modelIdentityId);
			return limits ? { status: "resolved", modelIdentityId, ...limits } : { status: "unknown", modelIdentityId };
		}
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
			return await runEngineCommand(options, validateEngineCommand(params.command));
	}
}

function finishRuntimeHistory(result: { work: RuntimeWork }, started: number): void {
	result.work.elapsedMs = Math.ceil(performance.now() - started);
	for (;;) {
		const bytes = Buffer.byteLength(JSON.stringify(result));
		if (bytes === result.work.bytes) break;
		result.work.bytes = bytes;
	}
	if (
		result.work.scannedRows > runtimeLimits.bootstrapScannedRows ||
		result.work.materializedBytes > runtimeLimits.bootstrapMaterializedBytes ||
		result.work.elapsedMs > runtimeLimits.bootstrapTimeoutMs
	)
		throw new RuntimeQueryError("restore_budget", "Owner history work budget exceeded", result.work);
	validateRuntimeValue("historyPage", result);
}

export async function runEngineCommand(
	options: Pick<ServerOptions, "runtime" | "deviceId" | "engineId" | "provisionMailbox">,
	command: EngineCommandEnvelope,
): Promise<EngineCommandReceipt> {
	if (command.deviceId !== options.deviceId || command.engineId !== options.engineId) {
		throw new EngineTargetError("invalid_request", "Command identity does not match this Engine service");
	}
	if (!(await options.runtime.store.isCurrentEngineGeneration(options.runtime.engineGeneration))) {
		throw new EngineTargetError("stale_target", "Engine generation lease is no longer current");
	}
	const identity = engineCommandIdentity(command);
	try {
		await options.runtime.verifyCommandOrigin(command);
	} catch (error) {
		if (error instanceof EngineBindingPendingError) throw error;
		const detail = {
			...(error instanceof EngineTargetError ? error.detail : undefined),
			code: error instanceof EngineTargetError ? error.code : "invalid_request",
			message: error instanceof Error ? error.message : String(error),
		};
		await options.runtime.store.rejectUnadmittedCommand(identity, { outcome: "rejected", detail },
			options.runtime.engineGeneration);
		throw error;
	}
	let admission = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
	for (let retry = 0; admission.status === "in_progress" && retry < 100; retry++) {
		await Bun.sleep(25);
		admission = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
	}
	if (admission.status === "binding_pending") throw new EngineBindingPendingError();
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
			provisionMailbox: options.provisionMailbox,
		});
		// Native start commits its receipt atomically with the Attempt. Preserve that exact receipt.
		const committed = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
		if (committed.status === "replay") return committed.receipt;
		const receipt: EngineCommandReceipt = {
			outcome: "applied",
			...(detail && typeof detail === "object" && !Array.isArray(detail)
				? { detail: detail as Record<string, unknown> }
				: {}),
		};
		await options.runtime.store.settleCommand(command.commandId, identity.canonicalHash, receipt);
		return receipt;
	} catch (error) {
		if (error instanceof EngineBindingPendingError || error instanceof EngineRoutingQueuedError) {
			await options.runtime.store.releaseCommand(command.commandId, identity.canonicalHash, options.runtime.engineGeneration);
			if (error instanceof EngineRoutingQueuedError || command.op === "resume") replayQueuedCommand(options, command);
			throw error;
		}
		// A Start can fail while materializing credentials after its atomic applied Attempt admission.
		// Never rewrite that immutable receipt as rejected; the Attempt carries the terminal failure.
		if (command.op === "start") {
			const committed = await options.runtime.store.admitCommand(identity, options.runtime.engineGeneration);
			if (committed.status === "replay" && committed.receipt.outcome === "applied")
				return committed.receipt;
		}
		const message = error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048);
		await options.runtime.store.settleCommand(command.commandId, identity.canonicalHash, {
			outcome: "rejected",
			detail: {
				...(error instanceof EngineTargetError ? error.detail : undefined),
				code: error instanceof EngineTargetError ? error.code : "invalid_request",
				message,
			},
		});
		throw error;
	}
}

async function capabilities(options: ServerOptions): Promise<Record<string, unknown>> {
	return {
		runtimeProtocol: runtimeCapabilities(),
		engineVersion: VERSION,
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
			"resolve_approval",
			"resolve_input",
		],
		queries: [
			"snapshots.list",
			"snapshots.get",
			"events.list",
			"result.get",
			"session.context",
			"session.history",
			"session.archive",
			"session.archive.verify",
			"session.archive.retire",
			"session.archive.restore",
			"chat.lifecycle",
			"chat.archived.list",
			"storage.reclaim",
			"session.restore.stage",
			"attachments.stage",
			"attachments.remove",
			"session.restore.history",
			"session.usage",
			"models.reference",
			"inbox.list",
			"inbox.enqueue",
			"inbox.read",
			"inbox.mutate",
			"inbox.reorder",
		],
		limits: { frameBytes: ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES, resultChars: ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS },
		cursor: { opaque: true, order: "oldest_first", gapIsExplicit: true },
		historyCursor: { opaque: true, order: "page_chronological", direction: "older", gapIsExplicit: true },
		sessionArchive: {
			exactNativeBytes: true,
			hashPinnedPages: true,
			sourcePreflight: true,
			localCompressedProof: true,
			embeddedBlobs: true,
			journaledRetirement: true,
			restoreWithoutRun: true,
			diskReclaim: true,
			diskReclaimScope: "engine_database",
			maxChunkBytes: 24_000,
		},
		sessionRestore: {
			exactNativeBytes: true,
			hashPinnedChunks: true,
			replaceRetainedBindingCas: true,
			maxChunkBytes: 24_000,
		},
		rawDiagnostics: false,
	};
}

function runtimeCapabilities(): Record<string, unknown> {
	return { version: "1.0", contractHash: RUNTIME_PROTOCOL_HASH, limits: runtimeLimits, ownershipProofVersion: 1 };
}

function runtimeScope(params: Record<string, unknown>): RuntimeScope {
	validateRuntimeValue("scope", params.scope);
	return params.scope as RuntimeScope;
}

function runtimeAccess(params: Record<string, unknown>): RuntimeAccess {
	const principalId = requiredString(params, "principalId");
	const authorizedAgentInstanceRefs =
		params.authorizedAgentInstanceRefs === undefined
			? undefined
			: requiredStringArray(params, "authorizedAgentInstanceRefs");
	for (const ref of authorizedAgentInstanceRefs ?? []) validateRuntimeValue("agi", ref);
	return { principalId, ...(authorizedAgentInstanceRefs ? { authorizedAgentInstanceRefs } : {}) };
}

async function runtimeAgent(
	runtime: EngineRuntime,
	params: Record<string, unknown>,
	requireAttempt = false,
): Promise<Record<string, unknown>> {
	const agentInstanceRef = requiredString(params, "agentInstanceRef");
	validateRuntimeValue("agi", agentInstanceRef);
	const attemptId = requireAttempt ? requiredString(params, "attemptId") : optionalString(params.attemptId);
	if (attemptId)
		await runtime.store.assertHistoricalAttemptAccess(attemptId, requiredString(params, "principalId"));
	const target = await runtime.store.runtimeTarget({
		agentInstanceRef,
		...(attemptId ? { attemptId } : {}),
		...(params.executionId ? { executionId: requiredString(params, "executionId") } : {}),
		...(params.rootAgentInstanceRef ? { rootAgentInstanceRef: requiredString(params, "rootAgentInstanceRef") } : {}),
		...runtimeAccess(params),
	});
	validateRuntimeValue("nativeTarget", target);
	return target;
}

async function runtimeTarget(runtime: EngineRuntime, params: Record<string, unknown>): Promise<EngineTarget> {
	const target = await runtimeAgent(runtime, params, true);
	if (target.kind !== "bound")
		throw new EngineTargetError("stale_target", "Native read requires a bound exact Attempt");
	return requiredTarget({ ...target, engineGeneration: target.targetEngineGeneration });
}

async function listSnapshots(runtime: EngineRuntime, cursor: string | undefined, limit: number) {
	const epoch = await runtime.store.getSnapshotEpoch();
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
		bindingSnapshot: attempt.binding_snapshot,
		executionId: attempt.execution_id,
		attemptId: attempt.attempt_id,
		bindingId: attempt.binding_id,
		engineGeneration: Number(attempt.engine_generation),
		bindingGeneration: Number(attempt.binding_generation),
		authorityGeneration: Number(attempt.authority_generation),
		state: attempt.state,
		manualHold: binding?.manualHold ?? false,
		intentRevision: binding?.intentRevision ?? 0,
		retry: retryFromAttempt(attempt),
		executorRoute: attempt.executor_route_state
			? JSON.parse(attempt.executor_route_state) as ExecutorRouteState
			: undefined,
		executionDigest: attempt.execution?.execution_digest,
		continuationDigest: attempt.execution?.continuation_digest,
		transcriptRef: attempt.transcript_session_id
			? `history://${binding?.engineAgentId ?? engineAgentId(attempt.agent_instance_id)}`
			: undefined,
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
	if (!event || (event.kind !== "completed" && event.kind !== "cancelled" &&
		event.kind !== "failed" && event.kind !== "interrupted")) return undefined;
	const attempt = await runtime.store.getAttempt(attemptId);
	const binding = await runtime.store.getBinding(event.agentInstanceId);
	const raw = typeof event.payload?.assistantFinal === "string" ? event.payload.assistantFinal : "";
	const outputTruncated =
		raw.length > ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS || event.payload?.outputTruncated === true;
	const assistantText = raw.slice(0, ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS);
	let structuredOutput: unknown;
	try {
		structuredOutput = raw ? JSON.parse(raw) : undefined;
	} catch {}
	const error = terminalError(event, attempt?.cause);
	const transcriptRef =
		typeof event.payload?.transcriptRef === "string"
			? event.payload.transcriptRef
			: attempt?.transcript_session_id
				? `history://${binding?.engineAgentId ?? engineAgentId(event.agentInstanceId)}`
				: undefined;
	return {
		attemptId,
		state: event.kind,
		assistantText,
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		resultHash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
		...(error ? { error } : {}),
		transcriptRef,
		outputTruncated,
		interruption: event.kind === "interrupted" ? { cause: "engine_lost", effectAmbiguity: true } : undefined,
	};
}

function terminalError(event: EngineEvent, cause: string | null | undefined): string | undefined {
	if (event.kind === "completed") return undefined;
	if (event.kind === "cancelled") return "attempt_cancelled";
	if (event.kind === "interrupted") return "engine_lost";
	if (event.kind !== "failed") return undefined;
	return safeEngineErrorDetail(event.payload?.error ?? cause ?? "Unknown Engine failure");
}

async function listSessionHistory(
	runtime: EngineRuntime,
	agentInstanceId: string,
	agentInstanceRef: string,
	attemptId: string,
	cursor: string | undefined,
	limit: number,
) {
	const page = await runtime.sessionHistoryPage(agentInstanceId, agentInstanceRef, cursor, limit, attemptId);
	return {
		schema: "grimoire.engine.session_history.v1",
		agentInstanceId,
		sessionId: page.sessionId,
		leafEntryId: page.anchor,
		sessionLeafEntryId: page.anchor,
		entries: page.entries,
		previousCursor: page.nextCursor,
		hasMore: page.nextCursor !== null,
		resyncRequired: false,
		activityCompleteness: page.activityCompleteness,
		...(page.entryRef ? { entryRef: page.entryRef } : {}),
	};
}

function publicEvent(event: EngineEvent) {
	switch (event.kind) {
		case "tool_approval_requested":
		case "spawn_approval_requested":
		case "escalation_approval_requested":
		case "consultant_approval_requested":
		case "tool_approval_resolved":
		case "spawn_approval_resolved":
		case "escalation_approval_resolved":
		case "consultant_approval_resolved":
		case "approval_escalated":
		case "approval_timed_out":
		case "executor_route_changed": {
			const bounded = boundedRecord(event.payload);
			return bounded === event.payload ? event : { ...event, payload: bounded };
		}
	}
	const payload = event.payload;
	if (!payload) return event;
	switch (event.kind) {
		case "history_checkpoint":
			return { ...event, payload: {} };
		case "trace_reasoning":
			return { ...event, payload: pick(payload, ["state"]) };
		case "assistant_snapshot":
			return {
				...event,
				payload: pick(payload, [
					"assistantMessageId",
					"revision",
					"text",
					"status",
					"stopReason",
					"textTruncated",
					"historyEntryId",
				]),
			};
		case "trace_tool": {
			const tool = payload.tool;
			return {
				...event,
				payload: {
					tool:
						tool && typeof tool === "object"
							? pick(tool as Record<string, unknown>, ["callId", "name", "outcome", "took"])
							: {},
				},
			};
		}
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
			return {
				...event,
				payload: {
					error: safeEngineErrorDetail(payload.error ?? "Unknown Engine failure"),
					...(typeof payload.transcriptRef === "string" ? { transcriptRef: payload.transcriptRef } : {}),
				},
			};
		case "cancelled":
			return {
				...event,
				payload: {
					error: "attempt_cancelled",
					...(typeof payload.transcriptRef === "string" ? { transcriptRef: payload.transcriptRef } : {}),
				},
			};
		case "interrupted":
			return { ...event, payload: pick(payload, ["cause", "error", "lostEngineGeneration", "transcriptRef"]) };
		case "completed":
			return {
				...event,
				payload: {
					assistantFinal: String(payload.assistantFinal ?? "").slice(0, ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS),
					...(typeof payload.assistantMessageId === "string"
						? { assistantMessageId: payload.assistantMessageId }
						: {}),
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
		steer: state === "running" || state === "waiting_request",
		pause: state === "running" || state === "waiting_request",
		resume: state === "paused",
		cancel: ["running", "waiting_request", "pause_requested", "paused", "waiting_input"].includes(state),
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
			"installation.verify",
			"binding.prepare",
			"binding.census",
			"binding.adopt",
			"binding.activate",
			"binding.abort",
			"runtime.capabilities",
			"runtime.snapshot",
			"runtime.target",
			"runtime.summary",
			"runtime.input",
			"runtime.holds",
			"runtime.resource",
			"runtime.messages",
			"runtime.tools",
			"runtime.events.wait",
			"runtime.command.get",
			"approval.get",
			"approval.authorize",
			"approval.grant",
			"runtime.context",
			"runtime.usage",
			"runtime.queue",
			"runtime.history",
			"runtime.history.entry",
			"snapshots.list",
			"snapshots.get",
			"events.list",
			"result.get",
			"session.context",
			"session.history",
			"session.archive",
			"session.archive.verify",
			"session.archive.retire",
			"session.archive.restore",
			"chat.lifecycle",
			"chat.archived.list",
			"storage.reclaim",
			"session.restore.stage",
			"attachments.stage",
			"attachments.remove",
			"session.restore.history",
			"session.usage",
			"models.reference",
			"inbox.list",
			"inbox.enqueue",
			"inbox.read",
			"inbox.mutate",
			"inbox.reorder",
			"usage_probe_binding.get",
			"usage_probe_binding.set",
			"usage_probe.run",
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

export function validateEngineCommand(value: unknown): EngineCommandEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command must be an object");
	const command = value as Record<string, unknown>;
	if (command.schema !== "grimoire.engine.command.v1") throw new Error("Unsupported command schema");
	const op = requiredString(command, "op");
	if (
		![
			"start",
			"enqueue",
			"queue_edit",
			"queue_remove",
			"queue_reorder",
			"queue_annotate",
			"queue_defer",
			"steer",
			"pause",
			"resume",
			"cancel",
			"compact",
			"release",
			"reconcile",
			"resolve_approval",
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
	if (command.bindingSnapshot !== undefined) validateRuntimeValue("bindingSnapshot", command.bindingSnapshot);
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
	const createdAt = record.createdAt;
	if (createdAt !== undefined && (!Number.isSafeInteger(createdAt) || Number(createdAt) < 0)) {
		throw new Error("createdAt must be a non-negative safe integer");
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
		...(createdAt === undefined ? {} : { createdAt: Number(createdAt) }),
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

function requiredNonNegativeInteger(record: Record<string, unknown>, key: string): number {
	const value = requiredInteger(record, key);
	if (value < 0) throw new Error(`${key} must be a non-negative integer`);
	return value;
}

function optionalLimit(value: unknown): number {
	return Number.isSafeInteger(value) ? Math.max(1, Math.min(1000, Number(value))) : 100;
}

function optionalNonNegativeInteger(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new EngineTargetError("invalid_request", "offset must be a non-negative safe integer");
	}
	return value;
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

function failure(
	requestId: string,
	code: string,
	message: string,
	retryable: boolean,
	work?: RuntimeWork,
): EngineControlQueryResponse {
	return {
		schema: "grimoire.engine.control_query.response.v1",
		version: ENGINE_CONTROL_QUERY_VERSION,
		requestId,
		ok: false,
		error: { code, message: message.slice(0, 2_048), retryable, ...(work ? { work } : {}) },
	};
}

function runtimeResponseBytes(method: string): number {
	return [
		"runtime.command.get",
		"runtime.snapshot",
		"runtime.history",
		"runtime.history.entry",
		"runtime.queue",
		"runtime.context",
		"runtime.usage",
		"runtime.input",
		"runtime.tools",
		"runtime.holds",
	].includes(method)
		? runtimeLimits.httpPageBytes + 4096
		: ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES;
}

function writeResponse(
	socket: net.Socket,
	response: EngineControlQueryResponse,
	maxBytes = ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES,
): void {
	if (socket.destroyed || !socket.writable || socket.writableEnded) return;
	let serialized = JSON.stringify(response);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		serialized = JSON.stringify(
			failure(response.requestId, "response_too_large", `Response exceeds ${maxBytes} bytes`, false),
		);
	}
	socket.write(`${serialized}\n`);
}

function isSocketDisconnect(error: Error): boolean {
	return (
		"code" in error &&
		["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(
			String(error.code),
		)
	);
}

function requestOnce(endpoint: string, request: EngineControlQueryRequest, timeoutMs: number): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const socket = net.createConnection(endpoint);
	let buffered = Buffer.alloc(0);
	let settled = false;
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		reject(error);
	};
	const deadline = Date.now() + timeoutMs;
	const armTimeout = () => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return fail(new Error("Engine Control + Query request timed out"));
		socket.setTimeout(Math.min(remaining, USAGE_PROBE_MAX_TIMEOUT_MS));
	};
	socket.on("timeout", armTimeout);
	armTimeout();
	socket.once("error", fail);
	socket.once("close", () => fail(new Error("Engine Control + Query connection closed before response")));
	socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", chunk => {
		buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
		if (buffered.byteLength > runtimeResponseBytes(request.method))
			return fail(new Error("Response exceeds method byte budget"));
		const newline = buffered.indexOf(10);
		if (newline < 0) return;
		try {
			const response = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as EngineControlQueryResponse;
			if (!response.ok) return fail(Object.assign(new Error(response.error.message), { code: response.error.code }));
			settled = true;
			socket.destroy();
			resolve(response.result);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
	return promise;
}
