import * as path from "node:path";
import {
	Agent,
	type AgentOptions,
	type AgentTool,
	AppendOnlyContextManager,
	type StreamFn,
} from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { CursorExecHandlers } from "../cursor";
import { AUTO_THINKING, type ConfiguredThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../thinking";

export interface ContextAgentCandidate {
	readonly role: string;
	readonly model: Model<Api>;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly selector: string;
	readonly activeModelFallback: boolean;
}

export interface ContextAgentRunInput {
	readonly candidate: ContextAgentCandidate;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly toolNames?: readonly string[];
	readonly allowedWritePaths?: readonly string[];
}

export interface ContextAgentRunner {
	resolveCandidates(
		role: string,
		includeActiveModelFallback?: boolean,
		selectors?: readonly string[],
	): ContextAgentCandidate[];
	run(input: ContextAgentRunInput): Promise<string>;
}

export interface NativeContextAgentRunnerOptions {
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly streamFn: StreamFn;
	readonly parentSessionId: () => string;
	readonly activeModel: () => Model<Api> | undefined;
	readonly activeThinkingLevel?: () => ConfiguredThinkingLevel | undefined;
	readonly telemetry?: AgentOptions["telemetry"];
	readonly cwd: () => string;
	readonly resolveTools?: (names: readonly string[]) => readonly AgentTool[];
	readonly saveDebugArtifact?: (role: string, content: string) => Promise<void>;
}

function quarantineUnavailableToolCalls(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
): string | undefined {
	const unavailable = [
		...new Set(
			message.content
				.filter(part => part.type === "toolCall" && !availableToolNames.has(part.name))
				.map(part => (part.type === "toolCall" ? part.name : "")),
		),
	].filter(Boolean);
	if (unavailable.length === 0) return undefined;
	const text = `Context agent requested unavailable tools: ${unavailable.sort().join(", ")}`;
	message.content = [{ type: "text", text }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = text;
	return text;
}

function isAllowedWritePath(cwd: string, value: string, allowedPaths: ReadonlySet<string>): boolean {
	return allowedPaths.has(path.resolve(cwd, value.replace(/^["']|["']$/g, "")));
}

function assertRestrictedWrite(
	toolName: string,
	params: unknown,
	cwd: string,
	allowedPaths: ReadonlySet<string>,
): void {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error(`Restricted ${toolName} call has invalid arguments`);
	}
	const record = params as Record<string, unknown>;
	if (toolName === "write") {
		if (typeof record.path !== "string" || !isAllowedWritePath(cwd, record.path, allowedPaths)) {
			throw new Error("Managed-context documentation task may write only approved root documentation files");
		}
		return;
	}
	if (toolName !== "edit") return;
	if (typeof record.input !== "string" || /(?:^|\n)REM(?:\n|$)/.test(record.input)) {
		throw new Error("Managed-context documentation task may not delete files");
	}
	const paths = [...record.input.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gm)].map(match => match[1]!);
	const destinations = [...record.input.matchAll(/^MV\s+(.+)$/gm)].map(match => match[1]!);
	if (paths.length === 0 || [...paths, ...destinations].some(value => !isAllowedWritePath(cwd, value, allowedPaths))) {
		throw new Error("Managed-context documentation task may edit only approved root documentation files");
	}
}

function restrictWriteTools(
	tools: readonly AgentTool[],
	cwd: string,
	allowed: readonly string[] | undefined,
): AgentTool[] {
	if (!allowed) return [...tools];
	const allowedPaths = new Set(allowed.map(value => path.resolve(cwd, value)));
	return tools.map(tool => {
		if (tool.name !== "write" && tool.name !== "edit") return tool;
		return new Proxy(tool, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property === "execute" && typeof value === "function") {
					return (...args: unknown[]) => {
						assertRestrictedWrite(tool.name, args[1], cwd, allowedPaths);
						return Reflect.apply(value, target, args);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
}

/** Runs tool-less hidden agents through the same model registry and provider stream as the owning session. */
export class NativeContextAgentRunner implements ContextAgentRunner {
	readonly #settings: Settings;
	readonly #modelRegistry: ModelRegistry;
	readonly #streamFn: StreamFn;
	readonly #parentSessionId: () => string;
	readonly #activeModel: () => Model<Api> | undefined;
	readonly #activeThinkingLevel: () => ConfiguredThinkingLevel | undefined;
	readonly #telemetry: AgentOptions["telemetry"];
	readonly #cwd: () => string;
	readonly #resolveTools: (names: readonly string[]) => readonly AgentTool[];
	readonly #saveDebugArtifact: ((role: string, content: string) => Promise<void>) | undefined;
	readonly #providerSessionIds = new Map<string, string>();
	readonly #providerSessionState = new Map<string, ProviderSessionState>();

	constructor(options: NativeContextAgentRunnerOptions) {
		this.#settings = options.settings;
		this.#modelRegistry = options.modelRegistry;
		this.#streamFn = options.streamFn;
		this.#parentSessionId = options.parentSessionId;
		this.#activeModel = options.activeModel;
		this.#activeThinkingLevel = options.activeThinkingLevel ?? (() => undefined);
		this.#telemetry = options.telemetry;
		this.#cwd = options.cwd;
		this.#resolveTools = options.resolveTools ?? (() => []);
		this.#saveDebugArtifact = options.saveDebugArtifact;
	}

	resolveCandidates(
		role: string,
		includeActiveModelFallback = false,
		selectors?: readonly string[],
	): ContextAgentCandidate[] {
		const availableModels = this.#modelRegistry.getAvailable();
		const patterns =
			selectors && selectors.length > 0
				? selectors
				: resolveConfiguredModelPatterns(formatModelRoleAlias(role), this.#settings);
		const candidates: ContextAgentCandidate[] = [];
		const matchPreferences = getModelMatchPreferences(this.#settings);
		for (const pattern of patterns) {
			const resolved = resolveModelRoleValue(pattern, availableModels, {
				settings: this.#settings,
				matchPreferences,
			});
			if (!resolved.model || candidates.some(candidate => modelsAreEqual(candidate.model, resolved.model!)))
				continue;
			candidates.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				selector: pattern,
				activeModelFallback: false,
			});
		}
		const activeModel = includeActiveModelFallback ? this.#activeModel() : undefined;
		if (activeModel && !candidates.some(candidate => modelsAreEqual(candidate.model, activeModel))) {
			candidates.push({
				role,
				model: activeModel,
				thinkingLevel: this.#activeThinkingLevel(),
				selector: `${activeModel.provider}/${activeModel.id}`,
				activeModelFallback: true,
			});
		}
		return candidates;
	}

	async run(input: ContextAgentRunInput): Promise<string> {
		input.signal?.throwIfAborted();
		const thinkingLevel = input.candidate.thinkingLevel === AUTO_THINKING ? undefined : input.candidate.thinkingLevel;
		const runnerLabel = `${this.#parentSessionId()}:context:${input.candidate.role}`;
		let providerSessionId = this.#providerSessionIds.get(input.candidate.role);
		if (!providerSessionId) {
			providerSessionId = Bun.randomUUIDv7();
			this.#providerSessionIds.set(input.candidate.role, providerSessionId);
		}
		const tools = restrictWriteTools(this.#resolveTools(input.toolNames ?? []), this.#cwd(), input.allowedWritePaths);
		const toolMap = new Map<string, AgentTool>();
		const availableToolNames = new Set<string>();
		for (const tool of tools) {
			toolMap.set(tool.name, tool);
			availableToolNames.add(tool.name);
			if (tool.customWireName !== undefined) {
				toolMap.set(tool.customWireName, tool);
				availableToolNames.add(tool.customWireName);
			}
		}
		const missingTools = (input.toolNames ?? []).filter(name => !availableToolNames.has(name));
		if (missingTools.length > 0) {
			throw new Error(`Context ${input.candidate.role} agent tools are unavailable: ${missingTools.join(", ")}`);
		}
		const allowNativeDelete = input.allowedWritePaths === undefined && (toolMap.has("write") || toolMap.has("edit"));
		if (allowNativeDelete) availableToolNames.add("delete");
		const cursorExecHandlers = new CursorExecHandlers({
			cwd: this.#cwd(),
			getCwd: this.#cwd,
			tools: toolMap,
			allowNativeDelete,
		});
		let quarantinedOutput: string | undefined;
		const telemetry = this.#telemetry
			? {
					...this.#telemetry,
					agent: {
						id: runnerLabel,
						name: `Context ${input.candidate.role}`,
						description: formatModelString(input.candidate.model),
					},
					conversationId: undefined,
				}
			: undefined;
		const agent = new Agent({
			initialState: {
				systemPrompt: [input.systemPrompt],
				model: input.candidate.model,
				thinkingLevel: toReasoningEffort(thinkingLevel),
				disableReasoning: shouldDisableReasoning(thinkingLevel),
				tools,
			},
			appendOnlyContext: new AppendOnlyContextManager(),
			streamFn: this.#streamFn,
			getApiKey: model => this.#modelRegistry.resolver(model, providerSessionId),
			sessionId: providerSessionId,
			promptCacheKey: providerSessionId,
			providerSessionState: this.#providerSessionState,
			cursorExecHandlers,
			cwdResolver: this.#cwd,
			deadline: Date.now() + Math.max(1, input.timeoutMs),
			abortOnFabricatedToolResult: true,
			transformAssistantMessage: message => {
				quarantinedOutput = quarantineUnavailableToolCalls(message, availableToolNames);
			},
			telemetry,
		});
		const abort = (): void => agent.abort(input.signal?.reason);
		input.signal?.addEventListener("abort", abort, { once: true });
		try {
			await agent.prompt(input.userPrompt);
			const assistant = agent.state.messages.findLast(message => message.role === "assistant");
			if (!assistant) throw new Error(`Context ${input.candidate.role} agent returned no assistant message`);
			if (quarantinedOutput) throw new Error(quarantinedOutput);
			if (assistant.stopReason === "error") {
				throw new Error(assistant.errorMessage || `Context ${input.candidate.role} agent failed`);
			}
			if (assistant.stopReason === "aborted") {
				throw new Error(`Context ${input.candidate.role} agent was aborted`);
			}
			const text = assistant.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n")
				.trim();
			if (!text) throw new Error(`Context ${input.candidate.role} agent returned empty output`);
			await this.#recordDebug(input, text);
			return text;
		} catch (error) {
			await this.#recordDebug(input, undefined, error);
			throw error;
		} finally {
			input.signal?.removeEventListener("abort", abort);
		}
	}

	async #recordDebug(input: ContextAgentRunInput, output?: string, error?: unknown): Promise<void> {
		if (!this.#settings.get("contextManager.debug") || !this.#saveDebugArtifact) return;
		try {
			await this.#saveDebugArtifact(
				input.candidate.role,
				JSON.stringify(
					{
						role: input.candidate.role,
						model: formatModelString(input.candidate.model),
						systemPrompt: input.systemPrompt,
						userPrompt: input.userPrompt,
						toolNames: input.toolNames ?? [],
						output,
						error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
						timestamp: new Date().toISOString(),
					},
					null,
					2,
				),
			);
		} catch (debugError) {
			logger.debug("Failed to write managed-context agent debug artifact", {
				role: input.candidate.role,
				error: debugError instanceof Error ? debugError.message : String(debugError),
			});
		}
	}
}
