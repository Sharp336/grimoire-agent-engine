import { randomUUID } from "node:crypto";
import type {
	PeerExecutionIdentity,
	PeerTransportBackend,
	PeerTransportDelivery,
	PeerTransportResult,
} from "../irc/bus";
import {
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
	type RemoteAgentIdentity,
	type RemoteAgentProgress,
	type RemoteAgentRef,
	type RemoteAgentResult,
	type RemoteRegisterInput,
	type RemoteRegistryBackend,
	type RemoteRegistryResponse,
} from "../registry/agent-registry";
import type {
	StructuredSubagentBackend,
	StructuredSubagentBackendContext,
	StructuredSubagentResult,
} from "../task/structured-subagent";
import { oneLineLabel, type SingleResult, type StructuredSubagentOutput } from "../task/types";
import { type RemoteRuntimeClient, RemoteRuntimeProtocolError } from "./client";
import type { RemoteRuntimeConfig } from "./config";

const REGISTRY_RESPONSE_KEYS: Record<string, true> = { identity: true, value: true };
const IDENTITY_KEYS: Record<string, true> = { controllerId: true, executionId: true, generation: true };
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REGISTRY_PROGRESS_KEYS: Record<string, true> = { sequence: true, message: true };
const REGISTRY_RESULT_KEYS: Record<string, true> = { outcome: true, output: true, error: true };
const PEER_RESULT_KEYS: Record<string, true> = {
	deliveryId: true,
	sequence: true,
	sender: true,
	recipient: true,
	outcome: true,
	error: true,
};
const PEER_IDENTITY_KEYS: Record<string, true> = {
	locality: true,
	agentId: true,
	generation: true,
	controllerId: true,
	executionId: true,
};
const STRUCTURED_RESPONSE_KEYS: Record<string, true> = { execution: true, registration: true };
const STRUCTURED_EXECUTION_KEYS: Record<string, true> = {
	result: true,
	mergeSummary: true,
	changesApplied: true,
	temporaryArtifacts: true,
};
const REMOTE_REGISTRATION_KEYS: Record<string, true> = {
	id: true,
	displayName: true,
	kind: true,
	parentId: true,
	status: true,
	identity: true,
	createdAt: true,
	lastActivity: true,
};
const STRUCTURED_OBSERVATION_KEYS: Record<string, true> = { type: true, registration: true };
const CHILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REMOTE_LAUNCH_TIMEOUT_GRACE_MS = 30_000;
const REMOTE_LAUNCH_TIMEOUT_MAX_MS = 2_147_000_000;

function remoteLaunchTimeout(maxRuntimeMs: number): number | null {
	if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 0) {
		throw new RemoteRuntimeProtocolError("INVALID_TIMEOUT", "Remote structured runtime limit is malformed.");
	}
	if (maxRuntimeMs === 0) return null;
	return Math.min(maxRuntimeMs + REMOTE_LAUNCH_TIMEOUT_GRACE_MS, REMOTE_LAUNCH_TIMEOUT_MAX_MS);
}

interface ActiveRemoteLaunch {
	readonly registry: AgentRegistry;
	running?: { readonly input: RemoteRegisterInput; readonly ref: RemoteAgentRef };
	terminal?: RemoteRegisterInput;
	observationError?: RemoteRuntimeProtocolError;
}
const SINGLE_RESULT_KEYS: Record<string, true> = {
	index: true,
	id: true,
	agent: true,
	agentSource: true,
	task: true,
	assignment: true,
	description: true,
	lastIntent: true,
	exitCode: true,
	output: true,
	stderr: true,
	truncated: true,
	structuredOutput: true,
	durationMs: true,
	tokens: true,
	requests: true,
	contextTokens: true,
	contextWindow: true,
	modelOverride: true,
	modelRole: true,
	resolvedModel: true,
	resolvedModelIsFallback: true,
	error: true,
	aborted: true,
	abortReason: true,
	usage: true,
	extractedToolData: true,
	retryFailure: true,
	outputMeta: true,
};
const USAGE_KEYS: Record<string, true> = {
	input: true,
	output: true,
	cacheRead: true,
	cacheWrite: true,
	totalTokens: true,
	contextTokens: true,
	orchestration: true,
	premiumRequests: true,
	reasoningTokens: true,
	cttl: true,
	server: true,
	cost: true,
};
const USAGE_COST_KEYS: Record<string, true> = {
	input: true,
	output: true,
	cacheRead: true,
	cacheWrite: true,
	total: true,
};
const USAGE_ORCHESTRATION_KEYS: Record<string, true> = { input: true, cacheRead: true, output: true };
const USAGE_CTTL_KEYS: Record<string, true> = { ephemeral5m: true, ephemeral1h: true };
const USAGE_SERVER_KEYS: Record<string, true> = { webSearch: true, webFetch: true };
const RETRY_FAILURE_KEYS: Record<string, true> = { attempt: true, errorMessage: true };
const OUTPUT_META_KEYS: Record<string, true> = { lineCount: true, charCount: true };

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requireFiniteNonNegativeFields(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	requireKeys(value, required, label);
	for (const key of required) {
		if (!isFiniteNonNegativeNumber(value[key])) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", `${label} is malformed.`);
		}
	}
	for (const key of optional) {
		if (value[key] !== undefined && !isFiniteNonNegativeNumber(value[key])) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", `${label} is malformed.`);
		}
	}
}

function parseUsage(value: unknown): NonNullable<SingleResult["usage"]> {
	const usage = protocolObject(value, "Remote structured child usage");
	rejectUnknownKeys(usage, USAGE_KEYS, "Remote structured child usage");
	requireFiniteNonNegativeFields(
		usage,
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"],
		["contextTokens", "premiumRequests", "reasoningTokens"],
		"Remote structured child usage",
	);

	const cost = protocolObject(usage.cost, "Remote structured child usage cost");
	rejectUnknownKeys(cost, USAGE_COST_KEYS, "Remote structured child usage cost");
	requireFiniteNonNegativeFields(
		cost,
		["input", "output", "cacheRead", "cacheWrite", "total"],
		[],
		"Remote structured child usage cost",
	);

	if (usage.orchestration !== undefined) {
		const orchestration = protocolObject(usage.orchestration, "Remote structured child orchestration usage");
		rejectUnknownKeys(orchestration, USAGE_ORCHESTRATION_KEYS, "Remote structured child orchestration usage");
		requireFiniteNonNegativeFields(
			orchestration,
			[],
			["input", "cacheRead", "output"],
			"Remote structured child orchestration usage",
		);
	}
	if (usage.cttl !== undefined) {
		const cttl = protocolObject(usage.cttl, "Remote structured child cache TTL usage");
		rejectUnknownKeys(cttl, USAGE_CTTL_KEYS, "Remote structured child cache TTL usage");
		requireFiniteNonNegativeFields(
			cttl,
			[],
			["ephemeral5m", "ephemeral1h"],
			"Remote structured child cache TTL usage",
		);
	}
	if (usage.server !== undefined) {
		const server = protocolObject(usage.server, "Remote structured child server usage");
		rejectUnknownKeys(server, USAGE_SERVER_KEYS, "Remote structured child server usage");
		requireFiniteNonNegativeFields(server, [], ["webSearch", "webFetch"], "Remote structured child server usage");
	}
	return usage as unknown as NonNullable<SingleResult["usage"]>;
}

function parseExtractedToolData(value: unknown): NonNullable<SingleResult["extractedToolData"]> {
	const extracted = protocolObject(value, "Remote structured child extracted tool data");
	for (const entries of Object.values(extracted)) {
		if (!Array.isArray(entries)) {
			throw new RemoteRuntimeProtocolError(
				"MALFORMED_RESULT",
				"Remote structured child extracted tool data is malformed.",
			);
		}
	}
	return extracted as NonNullable<SingleResult["extractedToolData"]>;
}

function parseRetryFailure(value: unknown): NonNullable<SingleResult["retryFailure"]> {
	const retryFailure = protocolObject(value, "Remote structured child retry failure");
	rejectUnknownKeys(retryFailure, RETRY_FAILURE_KEYS, "Remote structured child retry failure");
	requireKeys(retryFailure, ["attempt", "errorMessage"], "Remote structured child retry failure");
	if (
		!Number.isSafeInteger(retryFailure.attempt) ||
		(retryFailure.attempt as number) < 1 ||
		typeof retryFailure.errorMessage !== "string"
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote structured child retry failure is malformed.");
	}
	return retryFailure as NonNullable<SingleResult["retryFailure"]>;
}

function parseOutputMeta(value: unknown): NonNullable<SingleResult["outputMeta"]> {
	const outputMeta = protocolObject(value, "Remote structured child output metadata");
	rejectUnknownKeys(outputMeta, OUTPUT_META_KEYS, "Remote structured child output metadata");
	requireKeys(outputMeta, ["lineCount", "charCount"], "Remote structured child output metadata");
	if (
		!Number.isSafeInteger(outputMeta.lineCount) ||
		(outputMeta.lineCount as number) < 0 ||
		!Number.isSafeInteger(outputMeta.charCount) ||
		(outputMeta.charCount as number) < 0
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote structured child output metadata is malformed.");
	}
	return outputMeta as NonNullable<SingleResult["outputMeta"]>;
}

function parseSingleResult(value: Record<string, unknown>): SingleResult {
	requireKeys(
		value,
		[
			"index",
			"id",
			"agent",
			"agentSource",
			"task",
			"exitCode",
			"output",
			"stderr",
			"truncated",
			"durationMs",
			"tokens",
			"requests",
		],
		"Remote structured child result",
	);
	if (
		!Number.isInteger(value.index) ||
		typeof value.id !== "string" ||
		typeof value.agent !== "string" ||
		!["bundled", "user", "project"].includes(value.agentSource as string) ||
		typeof value.task !== "string" ||
		!Number.isInteger(value.exitCode) ||
		typeof value.output !== "string" ||
		typeof value.stderr !== "string" ||
		typeof value.truncated !== "boolean" ||
		typeof value.durationMs !== "number" ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0 ||
		typeof value.tokens !== "number" ||
		!Number.isFinite(value.tokens) ||
		value.tokens < 0 ||
		!Number.isInteger(value.requests) ||
		(value.requests as number) < 0 ||
		(value.assignment !== undefined && typeof value.assignment !== "string") ||
		(value.description !== undefined && typeof value.description !== "string") ||
		(value.lastIntent !== undefined && typeof value.lastIntent !== "string") ||
		(value.contextTokens !== undefined && !isFiniteNonNegativeNumber(value.contextTokens)) ||
		(value.contextWindow !== undefined && !isFiniteNonNegativeNumber(value.contextWindow)) ||
		(value.modelOverride !== undefined &&
			typeof value.modelOverride !== "string" &&
			(!Array.isArray(value.modelOverride) || !value.modelOverride.every(model => typeof model === "string"))) ||
		(value.modelRole !== undefined && typeof value.modelRole !== "string") ||
		(value.resolvedModel !== undefined && typeof value.resolvedModel !== "string") ||
		(value.resolvedModelIsFallback !== undefined && typeof value.resolvedModelIsFallback !== "boolean") ||
		(value.error !== undefined && typeof value.error !== "string") ||
		(value.aborted !== undefined && typeof value.aborted !== "boolean") ||
		(value.abortReason !== undefined && typeof value.abortReason !== "string")
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote structured child result is malformed.");
	}
	let structuredOutput: StructuredSubagentOutput | undefined;
	if (value.structuredOutput !== undefined) {
		const candidate = protocolObject(value.structuredOutput, "Remote structured output");
		rejectUnknownKeys(
			candidate,
			{ source: true, mode: true, status: true, data: true, error: true },
			"Remote structured output",
		);
		requireKeys(candidate, ["source", "mode", "status"], "Remote structured output");
		if (
			!["caller", "agent", "session", "none"].includes(candidate.source as string) ||
			!["permissive", "strict"].includes(candidate.mode as string) ||
			!["valid", "invalid", "unavailable"].includes(candidate.status as string) ||
			(candidate.error !== undefined && typeof candidate.error !== "string")
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote structured output is malformed.");
		}
		structuredOutput = {
			source: candidate.source as StructuredSubagentOutput["source"],
			mode: candidate.mode as StructuredSubagentOutput["mode"],
			status: candidate.status as StructuredSubagentOutput["status"],
			...(Object.hasOwn(candidate, "data") ? { data: candidate.data } : {}),
			...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
		};
	}
	const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
	const extractedToolData =
		value.extractedToolData === undefined ? undefined : parseExtractedToolData(value.extractedToolData);
	const retryFailure = value.retryFailure === undefined ? undefined : parseRetryFailure(value.retryFailure);
	const outputMeta = value.outputMeta === undefined ? undefined : parseOutputMeta(value.outputMeta);
	return {
		index: value.index as number,
		id: value.id,
		agent: value.agent,
		agentSource: value.agentSource as SingleResult["agentSource"],
		task: value.task,
		...(typeof value.assignment === "string" ? { assignment: value.assignment } : {}),
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(typeof value.lastIntent === "string" ? { lastIntent: value.lastIntent } : {}),
		exitCode: value.exitCode as number,
		output: value.output,
		stderr: value.stderr,
		truncated: value.truncated,
		durationMs: value.durationMs,
		tokens: value.tokens,
		requests: value.requests as number,
		...(typeof value.contextTokens === "number" ? { contextTokens: value.contextTokens } : {}),
		...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
		...(typeof value.modelOverride === "string" || Array.isArray(value.modelOverride)
			? { modelOverride: value.modelOverride as string | string[] }
			: {}),
		...(typeof value.modelRole === "string" ? { modelRole: value.modelRole } : {}),
		...(typeof value.resolvedModel === "string" ? { resolvedModel: value.resolvedModel } : {}),
		...(typeof value.resolvedModelIsFallback === "boolean"
			? { resolvedModelIsFallback: value.resolvedModelIsFallback }
			: {}),
		...(structuredOutput ? { structuredOutput } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(typeof value.aborted === "boolean" ? { aborted: value.aborted } : {}),
		...(typeof value.abortReason === "string" ? { abortReason: value.abortReason } : {}),
		...(usage ? { usage } : {}),
		...(extractedToolData ? { extractedToolData } : {}),
		...(retryFailure ? { retryFailure } : {}),
		...(outputMeta ? { outputMeta } : {}),
	};
}

function protocolObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", `${label} is malformed.`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Record<string, true>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(allowed, key)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", `${label} contains unknown fields.`);
		}
	}
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
	for (const key of required) {
		if (!Object.hasOwn(value, key)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", `${label} is incomplete.`);
		}
	}
}

function parseIdentity(value: unknown): RemoteAgentIdentity {
	const identity = protocolObject(value, "Remote execution identity");
	rejectUnknownKeys(identity, IDENTITY_KEYS, "Remote execution identity");
	requireKeys(identity, ["controllerId", "executionId", "generation"], "Remote execution identity");
	if (
		typeof identity.controllerId !== "string" ||
		identity.controllerId.length === 0 ||
		identity.controllerId.length > 64 ||
		typeof identity.executionId !== "string" ||
		!ULID_RE.test(identity.executionId) ||
		!Number.isSafeInteger(identity.generation) ||
		(identity.generation as number) <= 0
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote execution identity is malformed.");
	}
	return {
		controllerId: identity.controllerId,
		executionId: identity.executionId,
		generation: identity.generation as number,
	};
}

function samePeerIdentity(left: PeerExecutionIdentity, right: PeerExecutionIdentity): boolean {
	if (left.locality !== right.locality || left.agentId !== right.agentId || left.generation !== right.generation) {
		return false;
	}
	return (
		left.locality === "local" ||
		(right.locality === "remote" &&
			left.controllerId === right.controllerId &&
			left.executionId === right.executionId)
	);
}

function parsePeerIdentity(value: unknown): PeerExecutionIdentity {
	const identity = protocolObject(value, "Peer execution identity");
	rejectUnknownKeys(identity, PEER_IDENTITY_KEYS, "Peer execution identity");
	requireKeys(identity, ["locality", "agentId", "generation"], "Peer execution identity");
	if (
		(identity.locality !== "local" && identity.locality !== "remote") ||
		typeof identity.agentId !== "string" ||
		identity.agentId.length === 0 ||
		identity.agentId.length > 256 ||
		!Number.isSafeInteger(identity.generation) ||
		(identity.generation as number) <= 0
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Peer execution identity is malformed.");
	}
	if (identity.locality === "local") {
		if (identity.controllerId !== undefined || identity.executionId !== undefined) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Local peer identity contains remote fields.");
		}
		return { locality: "local", agentId: identity.agentId, generation: identity.generation as number };
	}
	if (
		typeof identity.controllerId !== "string" ||
		identity.controllerId.length === 0 ||
		identity.controllerId.length > 64 ||
		typeof identity.executionId !== "string" ||
		!ULID_RE.test(identity.executionId)
	) {
		throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote peer identity is malformed.");
	}
	return {
		locality: "remote",
		agentId: identity.agentId,
		generation: identity.generation as number,
		controllerId: identity.controllerId,
		executionId: identity.executionId,
	};
}

/** Socket implementation of the controller-owned registry calls. */
export class SocketRemoteRegistryBackend implements RemoteRegistryBackend {
	readonly #client: RemoteRuntimeClient;

	constructor(client: RemoteRuntimeClient) {
		this.#client = client;
	}

	async status(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<AgentStatus>> {
		const response = await this.#registryRequest("registry.status", identity, signal);
		if (!["running", "idle", "parked", "aborted"].includes(response.value as string)) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote registry status result is malformed.");
		}
		return { identity: response.identity, value: response.value as AgentStatus };
	}

	async progress(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<RemoteAgentProgress>> {
		const response = await this.#registryRequest("registry.progress", identity, signal);
		const progress = protocolObject(response.value, "Remote registry progress result");
		rejectUnknownKeys(progress, REGISTRY_PROGRESS_KEYS, "Remote registry progress result");
		requireKeys(progress, ["sequence"], "Remote registry progress result");
		if (
			!Number.isSafeInteger(progress.sequence) ||
			(progress.sequence as number) < 0 ||
			(progress.message !== undefined && (typeof progress.message !== "string" || progress.message.length > 4_096))
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote registry progress result is malformed.");
		}
		return {
			identity: response.identity,
			value: {
				sequence: progress.sequence as number,
				...(typeof progress.message === "string" ? { message: progress.message } : {}),
			},
		};
	}

	async cancel(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<"cancelled">> {
		const response = await this.#registryRequest("registry.cancel", identity, signal);
		if (response.value !== "cancelled") {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote registry cancellation result is malformed.");
		}
		return { identity: response.identity, value: "cancelled" };
	}

	async result(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<RemoteAgentResult>> {
		const response = await this.#registryRequest("registry.result", identity, signal);
		const result = protocolObject(response.value, "Remote registry terminal result");
		rejectUnknownKeys(result, REGISTRY_RESULT_KEYS, "Remote registry terminal result");
		requireKeys(result, ["outcome"], "Remote registry terminal result");
		if (
			(result.outcome !== "completed" && result.outcome !== "failed" && result.outcome !== "cancelled") ||
			(result.outcome === "completed" && result.error !== undefined) ||
			(result.outcome === "failed" &&
				(typeof result.error !== "string" || result.error.length === 0 || result.error.length > 4_096)) ||
			(result.outcome === "cancelled" && result.error !== undefined)
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote registry terminal result is malformed.");
		}
		return {
			identity: response.identity,
			value: {
				outcome: result.outcome as RemoteAgentResult["outcome"],
				...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
				...(result.outcome === "failed" ? { error: "Remote execution failed." } : {}),
			},
		};
	}

	async #registryRequest(
		operation: string,
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<unknown>> {
		const result = await this.#client.request(operation, { identity }, { signal });
		const response = protocolObject(result, "Remote registry result");
		rejectUnknownKeys(response, REGISTRY_RESPONSE_KEYS, "Remote registry result");
		requireKeys(response, ["identity", "value"], "Remote registry result");
		const responseIdentity = parseIdentity(response.identity);
		if (
			responseIdentity.controllerId !== identity.controllerId ||
			responseIdentity.executionId !== identity.executionId ||
			responseIdentity.generation !== identity.generation
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote registry result identity is stale.");
		}
		return { identity: responseIdentity, value: response.value };
	}
}

/** Socket implementation of ordered peer delivery and cancellation. */
export class SocketPeerTransportBackend implements PeerTransportBackend {
	readonly #client: RemoteRuntimeClient;
	readonly #executionId: string;

	constructor(client: RemoteRuntimeClient, config: RemoteRuntimeConfig) {
		this.#client = client;
		this.#executionId = config.executionId;
	}

	async deliver(delivery: Readonly<PeerTransportDelivery>, signal?: AbortSignal): Promise<PeerTransportResult> {
		const result = await this.#client.request(
			"peer.deliver",
			{ delivery },
			{
				signal,
				idempotencyKey: `${this.#executionId}:peer:${delivery.deliveryId}`,
			},
		);
		const response = protocolObject(result, "Remote peer result");
		rejectUnknownKeys(response, PEER_RESULT_KEYS, "Remote peer result");
		requireKeys(response, ["deliveryId", "sequence", "sender", "recipient", "outcome"], "Remote peer result");
		const parsed: PeerTransportResult = {
			deliveryId: typeof response.deliveryId === "string" ? response.deliveryId : "",
			sequence: typeof response.sequence === "number" ? response.sequence : -1,
			sender: parsePeerIdentity(response.sender),
			recipient: parsePeerIdentity(response.recipient),
			outcome: response.outcome as PeerTransportResult["outcome"],
			...(typeof response.error === "string" ? { error: response.error } : {}),
		};
		if (
			parsed.deliveryId !== delivery.deliveryId ||
			parsed.sequence !== delivery.sequence ||
			!samePeerIdentity(parsed.sender, delivery.sender) ||
			!samePeerIdentity(parsed.recipient, delivery.recipient) ||
			!["accepted", "rejected", "duplicate", "conflict"].includes(parsed.outcome) ||
			(parsed.error !== undefined && parsed.error.length > 4_096)
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote peer result is malformed or stale.");
		}
		return parsed;
	}

	async cancel(delivery: Readonly<PeerTransportDelivery>): Promise<void> {
		const result = await this.#client.request(
			"peer.cancel",
			{ deliveryId: delivery.deliveryId, sequence: delivery.sequence },
			{ idempotencyKey: `${this.#executionId}:peer:${delivery.deliveryId}:cancel` },
		);
		const response = protocolObject(result, "Remote peer cancellation result");
		rejectUnknownKeys(response, { cancelled: true }, "Remote peer cancellation result");
		requireKeys(response, ["cancelled"], "Remote peer cancellation result");
		if (response.cancelled !== true) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote peer cancellation result is malformed.");
		}
	}
}

/**
 * Socket backend for structured children; it sends no ToolSession or filesystem paths.
 * Each launch requires one running registry observation before its terminal response.
 */
export class SocketStructuredSubagentBackend implements StructuredSubagentBackend {
	readonly #client: RemoteRuntimeClient;
	readonly #config: RemoteRuntimeConfig;
	readonly #registryBackend: RemoteRegistryBackend;
	readonly #active = new WeakMap<StructuredSubagentBackendContext, ActiveRemoteLaunch>();

	constructor(client: RemoteRuntimeClient, config: RemoteRuntimeConfig, registryBackend?: RemoteRegistryBackend) {
		this.#client = client;
		this.#config = config;
		this.#registryBackend = registryBackend ?? new SocketRemoteRegistryBackend(client);
	}

	async run(context: StructuredSubagentBackendContext): Promise<StructuredSubagentResult> {
		const { request, policy } = context;
		const index = request.index ?? 0;
		const observationStream = `subagent.${randomUUID()}`;
		const idempotencyKey = request.parentToolCallId
			? `${this.#config.executionId}:${request.parentToolCallId}:${index}`
			: `${this.#config.executionId}:${randomUUID()}`;
		const state: ActiveRemoteLaunch = {
			registry: context.request.session.agentRegistry ?? AgentRegistry.global(),
		};
		if (this.#active.has(context)) {
			throw new RemoteRuntimeProtocolError("DUPLICATE_LAUNCH", "Remote structured launch context was reused.");
		}
		this.#active.set(context, state);
		const removeObservation = this.#client.onObservation(observationStream, envelope => {
			try {
				const observation = protocolObject(envelope.observation, "Remote structured observation");
				rejectUnknownKeys(observation, STRUCTURED_OBSERVATION_KEYS, "Remote structured observation");
				requireKeys(observation, ["type", "registration"], "Remote structured observation");
				if (observation.type !== "registry.register" || state.running) {
					throw new RemoteRuntimeProtocolError(
						"MALFORMED_RESULT",
						"Remote structured registration observation is malformed or duplicated.",
					);
				}
				const input = this.#parseRegistration(observation.registration, context, "running");
				const ref = state.registry.registerRemote(input, this.#registryBackend);
				state.running = { input, ref };
			} catch {
				state.observationError = new RemoteRuntimeProtocolError(
					"REGISTRATION_REJECTED",
					"Remote structured running registration was rejected.",
				);
			}
		});
		try {
			const maxRuntimeMs = request.maxRuntimeMs ?? request.session.settings.get("task.maxRuntimeMs");
			const restrictToolNames = policy.planMode || request.session.restrictToolNames === true;
			const result = await this.#client.request(
				"subagent.run",
				{
					invocationKind: request.invocationKind,
					assignment: request.assignment,
					context: request.context ?? null,
					agent: {
						name: policy.agent.name,
						source: policy.agent.source,
						modelOverride: policy.modelOverride ?? null,
						modelRole: policy.modelRole ?? null,
					},
					planMode: policy.planMode,
					restrictToolNames,
					enableMCP: !restrictToolNames && (request.session.enableMCP ?? true),
					outputSchema: {
						...(context.outputSchema.schema === undefined ? {} : { schema: context.outputSchema.schema }),
						outputSchemaOverridesAgent: context.outputSchema.outputSchemaOverridesAgent,
						source: context.outputSchema.source,
						mode: context.outputSchema.mode,
						reference: this.#config.schemaRef,
					},
					identity: {
						id: request.identity?.id ?? null,
						label: request.identity?.label ?? null,
					},
					index,
					parentToolCallId: request.parentToolCallId ?? null,
					effort: request.effort ?? null,
					observationStream,
					isolated: policy.isIsolated,
					mergeMode: policy.mergeMode,
					applyChanges: policy.applyChanges,
					enableLsp: policy.enableLsp,
					enableIrc: policy.enableIrc,
					maxRuntimeMs,
				},
				{
					signal: context.signal,
					idempotencyKey,
					timeoutMs: remoteLaunchTimeout(maxRuntimeMs),
				},
			);
			if (state.observationError) throw state.observationError;
			return this.#parseResult(result, context, state);
		} catch (error) {
			this.discard(context);
			throw error;
		} finally {
			removeObservation();
		}
	}

	accept(context: StructuredSubagentBackendContext): void {
		const state = this.#active.get(context);
		if (!state?.running || !state.terminal) {
			throw new RemoteRuntimeProtocolError(
				"MISSING_REGISTRATION",
				"Remote structured launch did not publish a running child registration.",
			);
		}
		if (!this.#sameRegistration(state.running.input, state.terminal)) {
			throw new RemoteRuntimeProtocolError(
				"CONFLICTING_REGISTRATION",
				"Remote structured terminal registration conflicts with the running child.",
			);
		}
		state.registry.settleRemote(state.terminal, state.running.ref, this.#registryBackend);
		this.#active.delete(context);
	}

	discard(context: StructuredSubagentBackendContext): void {
		const state = this.#active.get(context);
		if (!state) return;
		if (state.running) state.registry.unregister(state.running.ref.id, state.running.ref);
		this.#active.delete(context);
	}

	#parseResult(
		value: unknown,
		context: StructuredSubagentBackendContext,
		state: ActiveRemoteLaunch,
	): StructuredSubagentResult {
		const response = protocolObject(value, "Remote structured subagent response");
		rejectUnknownKeys(response, STRUCTURED_RESPONSE_KEYS, "Remote structured subagent response");
		requireKeys(response, ["execution", "registration"], "Remote structured subagent response");
		const execution = protocolObject(response.execution, "Remote structured execution");
		rejectUnknownKeys(execution, STRUCTURED_EXECUTION_KEYS, "Remote structured execution");
		requireKeys(
			execution,
			["result", "mergeSummary", "changesApplied", "temporaryArtifacts"],
			"Remote structured execution",
		);
		if (
			execution.mergeSummary !== "" ||
			execution.changesApplied !== null ||
			execution.temporaryArtifacts !== false
		) {
			throw new RemoteRuntimeProtocolError(
				"MALFORMED_RESULT",
				"Remote structured execution cannot expose controller filesystem state.",
			);
		}
		const childResult = protocolObject(execution.result, "Remote structured child result");
		rejectUnknownKeys(childResult, SINGLE_RESULT_KEYS, "Remote structured child result");
		const parsedChildResult = parseSingleResult(childResult);
		const registration = this.#parseRegistration(response.registration, context, "terminal");
		if (parsedChildResult.id !== registration.id) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote child registration is malformed.");
		}
		state.terminal = registration;
		return {
			result: parsedChildResult,
			policy: context.policy,
			mergeSummary: "",
			changesApplied: null,
			artifactsDir: "",
			temporaryArtifacts: false,
		};
	}

	#parseRegistration(
		value: unknown,
		context: StructuredSubagentBackendContext,
		expectedStatus: "running" | "terminal",
	): RemoteRegisterInput {
		const registration = protocolObject(value, "Remote child registration");
		rejectUnknownKeys(registration, REMOTE_REGISTRATION_KEYS, "Remote child registration");
		requireKeys(
			registration,
			["id", "displayName", "kind", "parentId", "status", "identity", "createdAt", "lastActivity"],
			"Remote child registration",
		);
		const identity = parseIdentity(registration.identity);
		const expectedParentId = context.request.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const displayName =
			typeof registration.displayName === "string" ? oneLineLabel(registration.displayName, 128) : "";
		if (
			typeof registration.id !== "string" ||
			!CHILD_ID_RE.test(registration.id) ||
			(context.request.identity?.id !== undefined && registration.id !== context.request.identity.id) ||
			displayName.length === 0 ||
			registration.kind !== "sub" ||
			registration.parentId !== expectedParentId ||
			(expectedStatus === "running"
				? registration.status !== "running"
				: !["idle", "parked", "aborted"].includes(registration.status as string)) ||
			!Number.isSafeInteger(registration.createdAt) ||
			(registration.createdAt as number) < 0 ||
			!Number.isSafeInteger(registration.lastActivity) ||
			(registration.lastActivity as number) < (registration.createdAt as number) ||
			identity.controllerId !== this.#config.controllerId
		) {
			throw new RemoteRuntimeProtocolError("MALFORMED_RESULT", "Remote child registration is malformed.");
		}
		return {
			id: registration.id,
			displayName,
			kind: "sub",
			parentId: registration.parentId as string,
			status: registration.status as AgentStatus,
			identity,
			createdAt: registration.createdAt as number,
			lastActivity: registration.lastActivity as number,
		};
	}

	#sameRegistration(running: RemoteRegisterInput, terminal: RemoteRegisterInput): boolean {
		return (
			running.id === terminal.id &&
			running.displayName === terminal.displayName &&
			running.kind === terminal.kind &&
			running.parentId === terminal.parentId &&
			running.createdAt === terminal.createdAt &&
			running.identity.controllerId === terminal.identity.controllerId &&
			running.identity.executionId === terminal.identity.executionId &&
			running.identity.generation === terminal.identity.generation
		);
	}
}
