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
import type { AnimaControl, ControlEvent, InvokeMessageParams, InvokeMessageResult } from "./protocol";

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

const PACKAGED_AGENT_NAMES = new Set(["claude-implementer", "claude-researcher", "claude-reviewer"]);

function normalizedAgentPath(agent: Readonly<AgentDefinition>): string | undefined {
	return agent.filePath ? path.resolve(agent.filePath) : undefined;
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
	const claudeOverride = override.filter(isAnthropicClaudeSelector);
	// OMP may replace the configured subagent model with the parent model when OMP cannot authenticate it.
	// Anima owns Claude credentials, so only honor an override that still selects Claude.
	return claudeOverride.length > 0 ? claudeOverride : configured.length > 0 ? configured : override;
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
	readonly #agentRoot: string;
	readonly #allowAgentNames: ReadonlySet<string>;
	readonly #retention: "park" | "keep";
	readonly #active = new Map<string, ActiveInvocation>();

	constructor(config: AnimaExecutorConfig) {
		this.#client = config.client;
		this.#agentRoot = path.resolve(config.agentRoot);
		this.#allowAgentNames = new Set([...PACKAGED_AGENT_NAMES, ...(config.allowAgentNames ?? [])]);
		this.#retention = config.retention ?? "park";
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
		await this.#client.request(
			"invoke.cancel",
			{ invocation_id: active.invocationId, reason: "operator" },
			{ id: `cancel:${active.invocationId}` },
		);
		active.state = "aborted";
	}

	async release(requestId: string): Promise<void> {
		const active = this.#requireActive(requestId);
		await this.#client.request(
			"invoke.release",
			{ invocation_id: active.invocationId, policy: this.#retention },
			{ id: `release:${active.invocationId}` },
		);
		active.state = "released";
	}

	async message(requestId: string, text: string): Promise<string> {
		const active = this.#requireActive(requestId);
		const params: InvokeMessageParams = {
			invocation_id: active.invocationId,
			body: text,
			priority: 0,
		};
		const result = await this.#client.request<InvokeMessageResult>("invoke.message", params, {
			id: `message:${active.invocationId}:${crypto.randomUUID()}`,
		});
		active.lastMessageId = result.message_id;
		active.detail = `follow-up message ${result.message_id} delivered`;
		return result.message_id;
	}

	async sendPeer(message: IrcMessage, options?: Readonly<IrcSendOptions>): Promise<string> {
		const active = [...this.#active.values()].find(invocation => invocation.sessionName === message.to);
		if (!active) throw new Error(`Unknown Anima peer ${JSON.stringify(message.to)}`);
		if (active.state === "failed" || active.state === "aborted" || active.state === "cancelled") {
			throw new Error(`Anima peer ${JSON.stringify(message.to)} is ${active.state}`);
		}
		const params: InvokeMessageParams = {
			invocation_id: active.invocationId,
			subject: `OMP IRC from ${message.from}`,
			body: message.body,
			priority: 0,
			thread_id: message.threadId ?? message.replyTo ?? message.id,
			...(message.replyTo ? { reply_to: message.replyTo } : {}),
		};
		const result = await this.#client.request<InvokeMessageResult>("invoke.message", params, {
			id: `irc:${message.id}`,
		});
		active.lastMessageId = result.message_id;
		active.detail = `IRC message ${result.message_id} delivered`;
		return result.message_id;
	}

	#claims(agent: Readonly<AgentDefinition>): boolean {
		if (this.#allowAgentNames.has(agent.name)) return true;
		const agentPath = normalizedAgentPath(agent);
		if (!agentPath) return false;
		const relative = path.relative(this.#agentRoot, agentPath);
		return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

		const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
		const label = safeLabel(options.agent.name, "agent");
		const agentId = `${label}-${suffix}`;
		const sessionName = `omp-${agentId}`;
		const worktree = path.resolve(options.worktree ?? options.cwd);
		const corePrompt = renderClaudeCorePrompt(options, worktree);
		const sha256 = new Bun.CryptoHasher("sha256").update(corePrompt).digest("hex");

		let active: ActiveInvocation | undefined;
		let removeEventListener: (() => void) | undefined;
		let removeAbortListener: (() => void) | undefined;
		let released = false;
		try {
			const hello = await this.#client.hello();
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
			const started = await this.#client.request<InvokeStartResult>("invoke.start", startParams, {
				id: `start:${hello.owner}:${options.id}`,
			});
			active = {
				requestId: options.id,
				invocationId: started.invocation_id,
				agentId: started.agent_id,
				agentName: options.agent.name,
				sessionName: started.session_name,
				state: started.state,
				detail: started.hold_reason,
			};
			this.#active.set(options.id, active);
			this.#emitProgress(options, startTime, "running", this.#progressLabel(active));
			removeEventListener = this.#client.onEvent?.(event => {
				if (!active || event.invocation_id !== active.invocationId) return;
				this.#updateFromEvent(active, event);
				this.#emitProgress(options, startTime, this.#progressStatus(active.state), this.#progressLabel(active));
			});

			const waitTimeoutMs = options.maxRuntimeMs ?? 900_000;
			const waitPromise = this.#client.request<InvokeTurnResult>(
				"invoke.wait_turn",
				{ invocation_id: started.invocation_id, timeout_ms: waitTimeoutMs },
				{
					id: `wait:${started.invocation_id}`,
					timeoutMs: waitTimeoutMs > 0 ? waitTimeoutMs + 30_000 : undefined,
				},
			);
			const abort = Promise.withResolvers<"aborted">();
			if (options.signal?.aborted) {
				abort.resolve("aborted");
			} else if (options.signal) {
				const onAbort = () => abort.resolve("aborted");
				options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}
			const outcome = options.signal ? await Promise.race([waitPromise, abort.promise]) : await waitPromise;
			if (outcome === "aborted") {
				await this.#client.request(
					"invoke.cancel",
					{ invocation_id: started.invocation_id, reason: String(options.signal?.reason ?? "aborted") },
					{ id: `cancel:${started.invocation_id}` },
				);
				active.state = "aborted";
				this.#emitProgress(options, startTime, "aborted", this.#progressLabel(active));
				return finalResult(options, startTime, {
					exitCode: 1,
					output: "",
					stderr: "Anima invocation aborted",
					aborted: true,
					abortReason: String(options.signal?.reason ?? "aborted"),
					external: {
						executor: "anima",
						invocationId: active.invocationId,
						agentId: active.agentId,
						historyRef: active.historyRef,
						attachRef: active.attachRef,
						usageAvailable: false,
					},
				});
			}

			active.state = "completed";
			active.sessionName = outcome.session_name;
			active.historyRef = outcome.transcript_ref;
			active.attachRef = outcome.attach_ref;
			this.#emitProgress(options, startTime, "completed", this.#progressLabel(active), outcome.text);
			await this.#client.request(
				"invoke.release",
				{ invocation_id: active.invocationId, policy: this.#retention },
				{ id: `release:${active.invocationId}` },
			);
			released = true;
			active.state = "released";
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
		} catch (error) {
			if (active) {
				active.state = options.signal?.aborted ? "aborted" : "failed";
				active.detail = error instanceof Error ? error.message : String(error);
				this.#emitProgress(options, startTime, this.#progressStatus(active.state), this.#progressLabel(active));
			}
			return finalResult(options, startTime, {
				exitCode: 1,
				output: "",
				stderr: error instanceof Error ? error.message : String(error),
				error: error instanceof Error ? error.message : String(error),
				aborted: options.signal?.aborted || undefined,
				abortReason: options.signal?.aborted ? String(options.signal.reason ?? "aborted") : undefined,
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
			removeEventListener?.();
			removeAbortListener?.();
			if (active && !released && active.state !== "released") {
				try {
					await this.#client.request(
						"invoke.release",
						{ invocation_id: active.invocationId, policy: this.#retention },
						{ id: `release:${active.invocationId}` },
					);
					active.state = "released";
				} catch (error) {
					active.detail = `release failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
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
