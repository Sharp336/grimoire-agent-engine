import * as fs from "node:fs";
import * as path from "node:path";
import { bareModelId } from "@oh-my-pi/pi-catalog/identity/classify";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity/family";
import type {
	AgentDefinition,
	AgentProgress,
	ExecutorOptions,
	IrcMessage,
	IrcSendOptions,
	SingleResult,
	SubagentExecutor,
} from "@oh-my-pi/pi-coding-agent";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import claudeCorePromptTemplate from "./claude-core-prompt.md" with { type: "text" };
import {
	type AnimaControl,
	type ControlEvent,
	ControlProtocolError,
	type InvokeCancelResult,
	type InvokeMessageParams,
	type InvokeMessageResult,
	type InvokeReleaseResult,
} from "./protocol";

export interface InvokeStartResult {
	invocation_id: string;
	agent_id: string;
	session_name?: string;
	state: string;
	hold_reason?: string;
}

export interface InvokeObservation {
	invocation_id: string;
	agent_id: string;
	session_name?: string;
	state: string;
	hold_reason?: string;
	tui_state?: string;
	prompt_committed?: boolean;
	completed?: boolean;
	attach_ref?: string;
	history_ref?: string;
}

export interface InvokeTurnResult {
	invocation_id: string;
	session_name: string;
	authority: unknown;
	turn_id: string;
	text: string;
	stop_reason: string;
	transcript_ref?: string;
	attach_ref?: string;
	completed_at: string;
}

export interface ActiveInvocation {
	requestId: string;
	invocationId: string;
	agentId: string;
	agentName: string;
	sessionName?: string;
	state: string;
	detail?: string;
	attachRef?: string;
	historyRef?: string;
	lastMessageId?: string;
}

export interface AnimaExecutorConfig {
	client: AnimaControl;
	agentRoot: string;
	allowAgentNames?: readonly string[];
	retention?: "park" | "keep";
	ready?: Promise<void>;
}

interface InvokeStartParams {
	owner: string;
	mailbox: string;
	agent_id: string;
	session_name: string;
	workdir: string;
	assignment: string;
	context?: string;
	prompt_mode: "omp-core";
	core_prompt: {
		body: string;
		sha256: string;
	};
	identity: null;
	profile: "code";
	priority: "normal";
	route: {
		harness: "claude";
		provider: "anthropic";
		account: string;
		model: string;
		effort: "low" | "medium" | "high";
	};
	retention: "park" | "keep";
	worktree: false;
}

const PACKAGED_AGENT_NAMES = ["claude-implementer", "claude-researcher", "claude-reviewer"] as const;
type PackagedAgentName = (typeof PACKAGED_AGENT_NAMES)[number];

function canonicalPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function safeLabel(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30);
	return normalized || fallback;
}

function effortName(effort: ExecutorOptions["effort"]): "low" | "medium" | "high" {
	switch (effort) {
		case "lo":
			return "low";
		case "hi":
			return "high";
		default:
			return "medium";
	}
}

function normalizeModelSelectors(value: string | readonly string[] | undefined): string[] {
	const entries = typeof value === "string" ? [value] : (value ?? []);
	return entries
		.flatMap(entry => entry.split(","))
		.map(entry => entry.trim())
		.filter(Boolean);
}

function isAnthropicClaudeSelector(selector: string): boolean {
	const slash = selector.indexOf("/");
	const provider = slash === -1 ? "anthropic" : selector.slice(0, slash);
	const modelId = bareModelId(selector).replace(/:(?:inherit|off|minimal|low|medium|high|xhigh|max|auto)$/, "");
	return provider === "anthropic" && isClaudeModelId(modelId) && !/[?*[\]{}]/.test(modelId);
}

function configuredModelSelectors(options: ExecutorOptions): string[] {
	const configured = normalizeModelSelectors(options.agent.model);
	const override = normalizeModelSelectors(options.modelOverride);
	if (override.length === 0) return configured;
	if (override.every(isAnthropicClaudeSelector)) return override;
	const parentFallback = normalizeModelSelectors(options.parentActiveModelPattern);
	const isParentFallback =
		override.length === parentFallback.length &&
		override.every((selector, index) => selector === parentFallback[index]);
	// OMP may replace an unauthenticated configured model with the active parent model.
	// Anima owns Claude credentials, so only that exact fallback may defer to the packaged Claude selector.
	return configured.length > 0 && isParentFallback ? configured : override;
}

function resolveClaudeModel(options: ExecutorOptions): string {
	const selectors = configuredModelSelectors(options);
	let model = "";
	for (const selector of selectors) {
		const slash = selector.indexOf("/");
		const provider = slash === -1 ? "anthropic" : selector.slice(0, slash);
		const modelId = bareModelId(selector).replace(/:(?:inherit|off|minimal|low|medium|high|xhigh|max|auto)$/, "");
		if (provider !== "anthropic" || !isClaudeModelId(modelId) || /[?*[\]{}]/.test(modelId)) {
			throw new Error(
				`Anima Claude executor requires an explicit Anthropic model selector; received ${JSON.stringify(selector)}`,
			);
		}
		model ||= modelId;
	}
	return model;
}

function renderClaudeCorePrompt(options: ExecutorOptions, worktree: string): string {
	return prompt.render(claudeCorePromptTemplate, {
		role: options.agent.systemPrompt.trim(),
		context: options.context?.trim() ?? "",
		planReference: options.planReference?.content.trim() ?? "",
		planReferencePath: options.planReference?.path ?? "",
		worktree,
		toolNames: options.agent.tools?.join(", ") ?? "",
		outputSchema: options.outputSchema === undefined ? "" : JSON.stringify(options.outputSchema, null, 2),
		outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
	});
}

function finalResult(
	options: ExecutorOptions,
	startTime: number,
	fields: Pick<SingleResult, "exitCode" | "output" | "stderr"> & Partial<SingleResult>,
): SingleResult {
	const { exitCode, output, stderr, ...rest } = fields;
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode,
		output,
		stderr,
		truncated: false,
		durationMs: Date.now() - startTime,
		tokens: 0,
		requests: 0,
		...rest,
	};
}

export class AnimaExecutorController {
	readonly executor: SubagentExecutor;
	readonly #client: AnimaControl;
	readonly #packagedAgentPaths: Readonly<Record<PackagedAgentName, string>>;
	readonly #allowAgentNames: ReadonlySet<string>;
	readonly #retention: "park" | "keep";
	readonly #ready: Promise<void>;
	readonly #active = new Map<string, ActiveInvocation>();
	readonly #cancelOperations = new Map<string, Promise<InvokeCancelResult>>();
	readonly #releaseOperations = new Map<string, Promise<InvokeReleaseResult | undefined>>();
	readonly #lifecycleTails = new Map<string, Promise<void>>();
	readonly #turnRevisions = new Map<string, number>();
	readonly #releasedRevisions = new Map<string, number>();
	readonly #followUpOperations = new Map<string, Promise<void>>();
	readonly #followUpTargets = new Map<string, number>();
	readonly #replyRoutes = new Map<string, Map<string, string>>();
	#followUpSequence = 0;
	#shutdownPromise?: Promise<void>;
	#shuttingDown = false;

	constructor(config: AnimaExecutorConfig) {
		this.#client = config.client;
		const agentRoot = canonicalPath(config.agentRoot);
		this.#packagedAgentPaths = {
			"claude-implementer": canonicalPath(path.join(agentRoot, "claude-implementer.md")),
			"claude-researcher": canonicalPath(path.join(agentRoot, "claude-researcher.md")),
			"claude-reviewer": canonicalPath(path.join(agentRoot, "claude-reviewer.md")),
		};
		this.#allowAgentNames = new Set(config.allowAgentNames ?? []);
		this.#retention = config.retention ?? "park";
		this.#ready = config.ready ?? Promise.resolve();
		this.executor = {
			id: "anima",
			claim: agent => this.#claims(agent),
			execute: options => this.#execute(options),
		};
	}

	list(): ActiveInvocation[] {
		return [...this.#active.values()].map(invocation => ({ ...invocation }));
	}

	findByPeerId(peerId: string): ActiveInvocation | undefined {
		const active = [...this.#active.values()].find(invocation => invocation.sessionName === peerId);
		return active ? { ...active } : undefined;
	}

	peerStatus(invocation: ActiveInvocation): string {
		if (invocation.state !== "released") return invocation.state;
		return this.#retention === "keep" ? "idle" : "parked";
	}

	resolvePeerMessage(
		peerId: string,
		message: Pick<IrcMessage, "threadId" | "replyTo">,
	): { recipient?: string } | undefined {
		const active = [...this.#active.values()].find(invocation => invocation.sessionName === peerId);
		if (!active) return undefined;
		const routes =
			(message.replyTo ? this.#replyRoutes.get(message.replyTo) : undefined) ??
			(message.threadId ? this.#replyRoutes.get(message.threadId) : undefined);
		if (routes && !routes.has(peerId)) return undefined;
		const recipient = routes?.get(peerId);
		return recipient === undefined ? {} : { recipient };
	}

	async observe(requestId: string): Promise<ActiveInvocation> {
		const active = this.#requireActive(requestId);
		const observation = await this.#client.request<InvokeObservation>("invoke.observe", {
			invocation_id: active.invocationId,
		});
		this.#updateFromObservation(active, observation);
		return { ...active };
	}

	async cancel(requestId: string): Promise<void> {
		const active = this.#requireActive(requestId);
		const result = await this.#cancelInvocation(active, "operator");
		if (!result.disposition.startsWith("cancelled")) {
			throw new ControlProtocolError(
				result.disposition,
				`Anima invocation ${active.invocationId} was not cancelled: ${result.disposition}`,
			);
		}
	}

	async release(requestId: string): Promise<void> {
		await this.#releaseCurrentInvocation(this.#requireActive(requestId));
	}

	async message(requestId: string, text: string): Promise<string> {
		const active = this.#requireActive(requestId);
		const result = await this.#deliverMessage(
			active,
			{
				invocation_id: active.invocationId,
				body: text,
				priority: 0,
			},
			`message:${active.invocationId}:${crypto.randomUUID()}`,
			"follow-up",
		);
		return result.message_id;
	}

	async sendPeer(message: IrcMessage, _options?: Readonly<IrcSendOptions>): Promise<string> {
		const active = [...this.#active.values()].find(invocation => invocation.sessionName === message.to);
		if (!active) throw new Error(`Unknown Anima peer ${JSON.stringify(message.to)}`);
		const threadId = message.threadId ?? message.replyTo ?? message.id;
		this.#rememberReplyRoute(threadId, message.from, message.to);
		const result = await this.#deliverMessage(
			active,
			{
				invocation_id: active.invocationId,
				subject: `OMP IRC from ${message.from}`,
				body: message.body,
				priority: 0,
				thread_id: threadId,
				...(message.replyTo ? { reply_to: message.replyTo } : {}),
			},
			`irc:${message.id}`,
			"IRC",
		);
		this.#rememberReplyRoute(result.thread_id, message.from, message.to);
		this.#rememberReplyRoute(result.message_id, message.from, message.to);
		return result.message_id;
	}

	shutdown(): Promise<void> {
		this.#shuttingDown = true;
		this.#shutdownPromise ??= (async () => {
			const cleanup = [...this.#active.values()].map(async active => {
				try {
					const result = await this.#cancelInvocation(active, "OMP session shutdown", true);
					if (!result.disposition.startsWith("cancelled") && result.disposition !== "already_completed") {
						throw new ControlProtocolError(
							result.disposition,
							`Anima invocation ${active.invocationId} was not cancelled during shutdown: ${result.disposition}`,
						);
					}
				} finally {
					if (active.state !== "released") await this.#releaseCurrentInvocation(active);
				}
			});
			await Promise.allSettled(cleanup);
			if (this.#followUpOperations.size > 0) {
				await Promise.race([Promise.allSettled([...this.#followUpOperations.values()]), Bun.sleep(10_000)]);
			}
		})();
		return this.#shutdownPromise;
	}

	async #deliverMessage(
		active: ActiveInvocation,
		params: InvokeMessageParams,
		requestId: string,
		label: string,
	): Promise<InvokeMessageResult> {
		const delivered = await this.#serializeLifecycle(active, async () => {
			if (this.#shuttingDown) {
				throw new ControlProtocolError("transport_closing", "Anima executor is shutting down");
			}
			if (active.state === "failed" || active.state === "aborted" || active.state === "cancelled") {
				throw new ControlProtocolError(
					"invocation_not_messageable",
					`Anima invocation ${active.invocationId} is ${active.state}`,
				);
			}
			const result = await this.#client.request<InvokeMessageResult>("invoke.message", params, {
				id: requestId,
				timeoutMs: 10_000,
			});
			if (result.disposition !== "sent" && result.disposition !== "delivered") {
				throw new ControlProtocolError(
					result.disposition,
					`Anima invocation ${active.invocationId} rejected ${label} delivery: ${result.disposition}`,
				);
			}
			const revision = (this.#turnRevisions.get(active.invocationId) ?? 0) + 1;
			this.#turnRevisions.set(active.invocationId, revision);
			active.lastMessageId = result.message_id;
			active.state = "running";
			active.detail = `${label} message ${result.message_id} delivered`;
			return { result, revision };
		});
		this.#trackFollowUp(active, delivered.result.message_id, delivered.revision);
		return delivered.result;
	}

	#rememberReplyRoute(key: string | undefined, recipient: string, sender: string): void {
		if (!key) return;
		const routes = this.#replyRoutes.get(key) ?? new Map<string, string>();
		routes.set(sender, recipient);
		this.#replyRoutes.delete(key);
		this.#replyRoutes.set(key, routes);
		while (this.#replyRoutes.size > 1_024) {
			const oldest = this.#replyRoutes.keys().next().value;
			if (oldest === undefined) break;
			this.#replyRoutes.delete(oldest);
		}
	}

	#trackFollowUp(active: ActiveInvocation, messageId: string, revision: number): void {
		this.#followUpTargets.set(active.invocationId, revision);
		if (this.#followUpOperations.has(active.invocationId)) return;
		const operation = (async () => {
			try {
				let observedRevision = this.#turnRevisions.get(active.invocationId) ?? 0;
				while (!this.#shuttingDown) {
					const outcome = await this.#client.request<InvokeTurnResult>(
						"invoke.wait_turn",
						{ invocation_id: active.invocationId, timeout_ms: 900_000 },
						{
							id: `follow-up:${active.invocationId}:${++this.#followUpSequence}:${messageId}`,
							timeoutMs: 930_000,
						},
					);
					if ((this.#turnRevisions.get(active.invocationId) ?? 0) !== observedRevision) {
						observedRevision = this.#turnRevisions.get(active.invocationId) ?? 0;
						continue;
					}
					active.state = "completed";
					active.sessionName = outcome.session_name;
					active.historyRef = outcome.transcript_ref;
					active.attachRef = outcome.attach_ref;
					active.detail = `follow-up turn ${outcome.turn_id} completed`;
					if (await this.#releaseInvocation(active, observedRevision)) return;
					observedRevision = this.#turnRevisions.get(active.invocationId) ?? 0;
				}
			} catch (error) {
				if (active.state !== "released" && active.state !== "aborted" && active.state !== "cancelled") {
					active.state = "failed";
					active.detail = `follow-up failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		})().finally(() => {
			if (this.#followUpOperations.get(active.invocationId) !== operation) return;
			this.#followUpOperations.delete(active.invocationId);
			const target = this.#followUpTargets.get(active.invocationId);
			const released = this.#releasedRevisions.get(active.invocationId) ?? -1;
			if (target === undefined || target <= released) {
				this.#followUpTargets.delete(active.invocationId);
				return;
			}
			if (!this.#shuttingDown && !["failed", "aborted", "cancelled"].includes(active.state)) {
				this.#trackFollowUp(active, active.lastMessageId ?? messageId, target);
			}
		});
		this.#followUpOperations.set(active.invocationId, operation);
	}

	#serializeLifecycle<T>(active: ActiveInvocation, callback: () => Promise<T>): Promise<T> {
		const prior = this.#lifecycleTails.get(active.invocationId) ?? Promise.resolve();
		const operation = prior.catch(() => undefined).then(callback);
		const tail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#lifecycleTails.set(active.invocationId, tail);
		void tail.then(() => {
			if (this.#lifecycleTails.get(active.invocationId) === tail) {
				this.#lifecycleTails.delete(active.invocationId);
			}
		});
		return operation;
	}

	#cancelInvocation(active: ActiveInvocation, reason: string, skipReleased = false): Promise<InvokeCancelResult> {
		const existing = this.#cancelOperations.get(active.invocationId);
		if (existing) return existing;
		const operation = this.#serializeLifecycle(active, async () => {
			if (skipReleased && active.state === "released") {
				return { invocation_id: active.invocationId, disposition: "already_completed" };
			}
			const revision = this.#turnRevisions.get(active.invocationId) ?? 0;
			const result = await this.#client.request<InvokeCancelResult>(
				"invoke.cancel",
				{ invocation_id: active.invocationId, reason },
				{ id: `cancel:${active.invocationId}:${revision}`, timeoutMs: 10_000 },
			);
			if (result.disposition.startsWith("cancelled")) active.state = "aborted";
			return result;
		}).finally(() => {
			if (this.#cancelOperations.get(active.invocationId) === operation) {
				this.#cancelOperations.delete(active.invocationId);
			}
		});
		this.#cancelOperations.set(active.invocationId, operation);
		return operation;
	}

	#releaseInvocation(active: ActiveInvocation, expectedRevision?: number): Promise<InvokeReleaseResult | undefined> {
		const existing = this.#releaseOperations.get(active.invocationId);
		if (existing) return existing;
		const expectedDisposition = this.#retention === "park" ? "parked" : "kept";
		const operation = this.#serializeLifecycle(active, async () => {
			const revision = this.#turnRevisions.get(active.invocationId) ?? 0;
			if (expectedRevision !== undefined && revision !== expectedRevision) return undefined;
			const result = await this.#client.request<InvokeReleaseResult>(
				"invoke.release",
				{ invocation_id: active.invocationId, policy: this.#retention },
				{ id: `release:${active.invocationId}:${revision}`, timeoutMs: 10_000 },
			);
			if (result.disposition !== expectedDisposition) {
				throw new ControlProtocolError(
					result.disposition,
					`Anima invocation ${active.invocationId} was not ${expectedDisposition}: ${result.disposition}`,
				);
			}
			active.state = "released";
			this.#releasedRevisions.set(active.invocationId, revision);
			return result;
		}).finally(() => {
			if (this.#releaseOperations.get(active.invocationId) === operation) {
				this.#releaseOperations.delete(active.invocationId);
			}
		});
		this.#releaseOperations.set(active.invocationId, operation);
		return operation;
	}

	async #releaseCurrentInvocation(active: ActiveInvocation): Promise<InvokeReleaseResult> {
		while (true) {
			const result = await this.#releaseInvocation(active);
			if (result) return result;
		}
	}

	#claims(agent: Readonly<AgentDefinition>): boolean {
		if (this.#allowAgentNames.has(agent.name)) return true;
		if (!Object.hasOwn(this.#packagedAgentPaths, agent.name) || !agent.filePath) return false;
		const packagedName = agent.name as PackagedAgentName;
		return canonicalPath(agent.filePath) === this.#packagedAgentPaths[packagedName];
	}

	async #execute(options: ExecutorOptions): Promise<SingleResult> {
		const startTime = Date.now();
		if (options.additionalDirectories && options.additionalDirectories.length > 0) {
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: "Anima executor does not support additional workspace directories",
				error: "unsupported_additional_directories",
			});
		}
		if (this.#shuttingDown) {
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: "Anima executor is shutting down",
				error: "transport_closing",
			});
		}
		if (options.signal?.aborted) {
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: "Anima invocation aborted before start",
				aborted: true,
				abortReason: String(options.signal.reason ?? "aborted"),
			});
		}
		let model: string;
		try {
			model = resolveClaudeModel(options);
		} catch (error) {
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: error instanceof Error ? error.message : String(error),
				error: "unsupported_model_selector",
			});
		}

		type StopOutcome = { kind: "stop"; reason: string; timedOut: boolean };
		type ValueOutcome<T> = { kind: "value"; value: T };
		const runtimeLimitMs = options.maxRuntimeMs ?? 900_000;
		const stop = Promise.withResolvers<StopOutcome>();
		let stopped: StopOutcome | undefined;
		let runtimeTimer: Timer | undefined;
		let removeAbortListener: (() => void) | undefined;
		const requestStop = (reason: string, timedOut: boolean): void => {
			if (stopped) return;
			stopped = { kind: "stop", reason, timedOut };
			stop.resolve(stopped);
		};
		if (options.signal) {
			const onAbort = () => requestStop(String(options.signal?.reason ?? "aborted"), false);
			options.signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			if (options.signal.aborted) onAbort();
		}
		if (runtimeLimitMs > 0) {
			const remaining = runtimeLimitMs - (Date.now() - startTime);
			if (remaining <= 0) {
				requestStop(`Subagent runtime limit exceeded (task.maxRuntimeMs=${runtimeLimitMs})`, true);
			} else {
				runtimeTimer = setTimeout(
					() => requestStop(`Subagent runtime limit exceeded (task.maxRuntimeMs=${runtimeLimitMs})`, true),
					remaining,
				);
			}
		}
		const raceWithStop = async <T>(operation: Promise<T>): Promise<ValueOutcome<T> | StopOutcome> => {
			if (!options.signal && runtimeLimitMs <= 0) return { kind: "value", value: await operation };
			return Promise.race([operation.then(value => ({ kind: "value" as const, value })), stop.promise]);
		};
		const stoppedResult = (outcome: StopOutcome, active?: ActiveInvocation): SingleResult =>
			finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: outcome.timedOut ? outcome.reason : "Anima invocation aborted",
				...(outcome.timedOut ? { error: "runtime_timeout" } : {}),
				aborted: true,
				abortReason: outcome.reason,
				...(active
					? {
							external: {
								executor: "anima",
								invocationId: active.invocationId,
								agentId: active.agentId,
								historyRef: active.historyRef,
								attachRef: active.attachRef,
								usageAvailable: false,
							},
						}
					: {}),
			});

		const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
		const label = safeLabel(options.agent.name, "agent");
		const agentId = `${label}-${suffix}`;
		const sessionName = `omp-${agentId}`;
		const worktree = path.resolve(options.worktree ?? options.cwd);

		let active: ActiveInvocation | undefined;
		let removeEventListener: (() => void) | undefined;
		let cleanupAttempted = false;
		try {
			const readyOutcome = await raceWithStop(this.#ready);
			if (readyOutcome.kind === "stop") return stoppedResult(readyOutcome);
			const helloOutcome = await raceWithStop(this.#client.hello());
			if (helloOutcome.kind === "stop") return stoppedResult(helloOutcome);
			const hello = helloOutcome.value;
			const corePrompt = renderClaudeCorePrompt(options, worktree);
			const sha256 = new Bun.CryptoHasher("sha256").update(corePrompt).digest("hex");
			const context = options.context?.trim();
			const startParams: InvokeStartParams = {
				owner: hello.owner,
				mailbox: hello.mailbox,
				agent_id: agentId,
				session_name: sessionName,
				workdir: worktree,
				assignment: options.task,
				...(context ? { context } : {}),
				prompt_mode: "omp-core",
				core_prompt: { body: corePrompt, sha256 },
				identity: null,
				profile: "code",
				priority: "normal",
				route: {
					harness: "claude",
					provider: "anthropic",
					account: "",
					model,
					effort: effortName(options.effort),
				},
				retention: this.#retention,
				worktree: false,
			};
			this.#emitProgress(options, startTime, "running", "Anima: creating durable invocation");
			const startPromise = this.#client.request<InvokeStartResult>("invoke.start", startParams, {
				id: `start:${hello.owner}:${options.id}`,
			});
			const startOutcome = await raceWithStop(startPromise);
			if (startOutcome.kind === "stop") {
				void startPromise
					.then(started => this.#cleanLateStart(started.invocation_id, startOutcome.reason))
					.catch(error => console.error(`[anima-omp] late invocation cleanup failed: ${String(error)}`));
				return stoppedResult(startOutcome);
			}
			const started = startOutcome.value;
			active = {
				requestId: options.id,
				invocationId: started.invocation_id,
				agentId: started.agent_id,
				agentName: options.agent.name,
				sessionName: started.session_name,
				state: started.state,
				detail: started.hold_reason,
			};
			this.#turnRevisions.set(active.invocationId, 0);
			this.#active.set(options.id, active);
			this.#emitProgress(options, startTime, "running", this.#progressLabel(active));
			removeEventListener = this.#client.onEvent?.(event => {
				if (!active || event.invocation_id !== active.invocationId) return;
				this.#updateFromEvent(active, event);
				this.#emitProgress(options, startTime, this.#progressStatus(active.state), this.#progressLabel(active));
			});

			const finishCompleted = async (outcome: InvokeTurnResult): Promise<SingleResult> => {
				if (!active) throw new Error("Anima invocation completed without active state");
				active.state = "completed";
				active.sessionName = outcome.session_name;
				active.historyRef = outcome.transcript_ref;
				active.attachRef = outcome.attach_ref;
				this.#emitProgress(options, startTime, "completed", this.#progressLabel(active), outcome.text);
				cleanupAttempted = true;
				await this.#releaseInvocation(active, 0);
				return finalResult(options, startTime, {
					exitCode: 0,
					output: outcome.text,
					stderr: "",
					external: {
						executor: "anima",
						invocationId: active.invocationId,
						agentId: active.agentId,
						historyRef: outcome.transcript_ref,
						attachRef: outcome.attach_ref,
						usageAvailable: false,
					},
				});
			};
			const cancelStopped = async (
				outcome: StopOutcome,
				pendingTurn?: Promise<InvokeTurnResult>,
			): Promise<SingleResult> => {
				if (!active) throw new Error("Anima invocation cancellation lost active state");
				const cancellation = await this.#cancelInvocation(active, outcome.reason);
				if (cancellation.disposition === "already_completed") {
					const completed =
						pendingTurn ??
						this.#client.request<InvokeTurnResult>(
							"invoke.wait_turn",
							{ invocation_id: active.invocationId, timeout_ms: 30_000 },
							{ id: `wait-completed:${active.invocationId}`, timeoutMs: 35_000 },
						);
					return finishCompleted(await completed);
				}
				if (!cancellation.disposition.startsWith("cancelled")) {
					void pendingTurn?.catch(() => undefined);
					throw new ControlProtocolError(
						cancellation.disposition,
						`Anima invocation ${active.invocationId} was not cancelled: ${cancellation.disposition}`,
					);
				}
				void pendingTurn?.catch(() => undefined);
				active.state = "aborted";
				this.#emitProgress(options, startTime, "aborted", this.#progressLabel(active));
				return stoppedResult(outcome, active);
			};
			if (stopped) return await cancelStopped(stopped);

			const elapsedMs = Date.now() - startTime;
			const waitTimeoutMs = runtimeLimitMs > 0 ? Math.max(1, runtimeLimitMs - elapsedMs) : 0;
			const waitPromise = this.#client.request<InvokeTurnResult>(
				"invoke.wait_turn",
				{ invocation_id: started.invocation_id, timeout_ms: waitTimeoutMs },
				{
					id: `wait:${started.invocation_id}`,
					timeoutMs: waitTimeoutMs > 0 ? waitTimeoutMs + 30_000 : undefined,
				},
			);
			const waitOutcome = await raceWithStop(waitPromise);
			if (waitOutcome.kind === "stop") return await cancelStopped(waitOutcome, waitPromise);
			return await finishCompleted(waitOutcome.value);
		} catch (error) {
			if (active) {
				if (active.state !== "released" && active.state !== "aborted" && active.state !== "cancelled") {
					active.state = "failed";
				}
				active.detail = error instanceof Error ? error.message : String(error);
				this.#emitProgress(options, startTime, this.#progressStatus(active.state), this.#progressLabel(active));
			}
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: error instanceof Error ? error.message : String(error),
				error: error instanceof Error ? error.message : String(error),
				aborted: Boolean(stopped || options.signal?.aborted) || undefined,
				abortReason:
					stopped?.reason ?? (options.signal?.aborted ? String(options.signal.reason ?? "aborted") : undefined),
				...(active
					? {
							external: {
								executor: "anima",
								invocationId: active.invocationId,
								agentId: active.agentId,
								historyRef: active.historyRef,
								attachRef: active.attachRef,
								usageAvailable: false,
							},
						}
					: {}),
			});
		} finally {
			clearTimeout(runtimeTimer);
			removeEventListener?.();
			removeAbortListener?.();
			if (active && !cleanupAttempted && active.state !== "released") {
				try {
					cleanupAttempted = true;
					await this.#releaseCurrentInvocation(active);
				} catch (error) {
					active.detail = `release failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
	}

	async #cleanLateStart(invocationId: string, reason: string): Promise<void> {
		const active: ActiveInvocation = {
			requestId: `late:${invocationId}`,
			invocationId,
			agentId: "late-start",
			agentName: "late-start",
			state: "starting",
		};
		let cancelError: unknown;
		try {
			const cancellation = await this.#cancelInvocation(active, reason);
			if (!cancellation.disposition.startsWith("cancelled") && cancellation.disposition !== "already_completed") {
				cancelError = new ControlProtocolError(
					cancellation.disposition,
					`Late Anima invocation ${invocationId} was not cancelled: ${cancellation.disposition}`,
				);
			}
		} catch (error) {
			cancelError = error;
		}
		try {
			await this.#releaseCurrentInvocation(active);
		} catch (error) {
			throw cancelError ?? error;
		}
		if (cancelError) throw cancelError;
	}

	#requireActive(requestId: string): ActiveInvocation {
		const active = this.#active.get(requestId);
		if (!active) throw new Error(`Unknown Anima invocation ${JSON.stringify(requestId)}`);
		return active;
	}

	#updateFromObservation(active: ActiveInvocation, observation: InvokeObservation): void {
		active.state = observation.state;
		active.sessionName = observation.session_name ?? active.sessionName;
		active.detail = observation.hold_reason ?? observation.tui_state;
		active.attachRef = observation.attach_ref ?? active.attachRef;
		active.historyRef = observation.history_ref ?? active.historyRef;
	}

	#updateFromEvent(active: ActiveInvocation, event: ControlEvent): void {
		active.state = event.event.kind;
		active.detail = event.event.detail;
	}

	#progressLabel(active: ActiveInvocation): string {
		const target = active.sessionName ? ` · ${active.sessionName}` : "";
		const detail = active.detail ? ` · ${active.detail}` : "";
		return `Anima: ${active.state}${target}${detail}`;
	}

	#progressStatus(state: string): AgentProgress["status"] {
		switch (state) {
			case "completed":
			case "released":
				return "completed";
			case "failed":
				return "failed";
			case "aborted":
			case "cancelled":
				return "aborted";
			default:
				return "running";
		}
	}

	#emitProgress(
		options: ExecutorOptions,
		startTime: number,
		status: AgentProgress["status"],
		lastIntent: string,
		output?: string,
	): void {
		options.onProgress?.({
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			status,
			task: options.task,
			assignment: options.assignment,
			description: options.description,
			lastIntent,
			recentTools: [],
			recentOutput: output ? [output] : [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: Date.now() - startTime,
			modelOverride: options.modelOverride,
		});
	}
}
