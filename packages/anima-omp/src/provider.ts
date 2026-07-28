import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity/family";
import type {
	AgentDefinition,
	ExecutorOptions,
	ExtensionAPI,
	SingleResult,
	SubagentExecutor,
} from "@oh-my-pi/pi-coding-agent";

export const ANIMA_CLAUDE_PROVIDER = "anima-claude";
export const ANIMA_CLAUDE_API = "anima-claude-control";
const DEFAULT_CLAUDE_SELECTORS = ["opus", "fable", "sonnet", "haiku"] as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export type ExecuteAnimaTurn = SubagentExecutor["execute"];

function normalizeClaudeSelector(value: string): string | undefined {
	let selector = value.trim();
	if (selector.startsWith("anthropic/")) selector = selector.slice("anthropic/".length);
	if (!selector || /[?*[\]{}]/.test(selector) || !isClaudeModelId(selector)) return undefined;
	return selector;
}

/**
 * Claude Code model selectors exposed to OMP. Values are forwarded directly to
 * `claude --model`; there is no plugin-owned strength-to-model mapping.
 */
export function configuredClaudeSelectors(raw = process.env.ANIMA_OMP_CLAUDE_MODELS): string[] {
	const configured = raw?.split(",") ?? [];
	const seen = new Set<string>();
	const selectors: string[] = [];
	for (const value of [...DEFAULT_CLAUDE_SELECTORS, ...configured]) {
		const selector = normalizeClaudeSelector(value);
		if (!selector || seen.has(selector)) continue;
		seen.add(selector);
		selectors.push(selector);
	}
	return selectors;
}

function displayName(selector: string): string {
	if (DEFAULT_CLAUDE_SELECTORS.includes(selector as (typeof DEFAULT_CLAUDE_SELECTORS)[number])) {
		return `Anima Claude ${selector[0]!.toUpperCase()}${selector.slice(1)}`;
	}
	return `Anima Claude (${selector})`;
}

function providerModels() {
	return configuredClaudeSelectors().map(selector => ({
		id: selector,
		name: displayName(selector),
		api: ANIMA_CLAUDE_API,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { ...ZERO_COST },
		// Rolling aliases can change capability without a plugin release. Keep OMP
		// compaction conservative; Claude Code owns the actual context boundary.
		contextWindow: 200_000,
		maxTokens: 64_000,
	}));
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map(block => {
			if (!block || typeof block !== "object") return String(block ?? "");
			const record = block as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (typeof record.thinking === "string") return `[assistant reasoning]\n${record.thinking}`;
			if (record.type === "image") return `[image: ${String(record.mimeType ?? "unknown media type")}]`;
			if (record.type === "toolCall") {
				return `[assistant tool call ${String(record.name ?? "unknown")}]\n${JSON.stringify(record.arguments ?? {})}`;
			}
			return JSON.stringify(record);
		})
		.join("\n");
}

export function renderProviderConversation(context: Context): string {
	const messages = context.messages.map(message => {
		const role = message.role === "toolResult" ? `TOOL RESULT (${message.toolName})` : message.role.toUpperCase();
		return `### ${role}\n${contentText(message.content)}`;
	});
	return [
		"Continue the OMP conversation below and complete the latest user request.",
		"Use Claude Code's own tools directly when work is required. Return the final answer as assistant text; do not emit OMP tool-call syntax.",
		"",
		"<conversation>",
		...messages,
		"</conversation>",
	].join("\n");
}

function providerSystemPrompt(context: Context): string {
	return [
		...(context.systemPrompt ?? []),
		"You are the active model for an OMP session, executed inside the official Claude Code TUI under Anima lifecycle control.",
	].join("\n\n");
}

function taskEffort(options?: SimpleStreamOptions): ExecutorOptions["effort"] {
	if (options?.disableReasoning || options?.reasoning === "minimal" || options?.reasoning === "low") return "lo";
	if (options?.reasoning === "high" || options?.reasoning === "xhigh" || options?.reasoning === "max") return "hi";
	return "med";
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { ...ZERO_COST, total: 0 },
	} as Usage;
}

function resultMessage(model: Model, result: SingleResult, startedAt: number): AssistantMessage {
	return {
		role: "assistant",
		content: result.output ? [{ type: "text", text: result.output }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: result.usage ?? emptyUsage(),
		stopReason: result.exitCode === 0 ? "stop" : result.aborted ? "aborted" : "error",
		...(result.exitCode === 0
			? {}
			: { errorMessage: result.stderr || result.error || "Anima Claude invocation failed" }),
		timestamp: startedAt,
		duration: Date.now() - startedAt,
	};
}

export function streamAnimaClaude(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	execute: ExecuteAnimaTurn,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const startedAt = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: startedAt,
	};
	stream.push({ type: "start", partial });

	void (async () => {
		try {
			const agent: AgentDefinition = {
				name: `${ANIMA_CLAUDE_PROVIDER}-${model.id}`,
				description: `Direct Claude Code model ${model.id} through Anima`,
				systemPrompt: providerSystemPrompt(context),
				model: [`anthropic/${model.id}`],
				source: "user",
			};
			const result = await execute({
				cwd: options?.cwd ?? process.cwd(),
				agent,
				task: renderProviderConversation(context),
				index: 0,
				id: `provider-${crypto.randomUUID()}`,
				modelOverride: `anthropic/${model.id}`,
				effort: taskEffort(options),
				signal: options?.signal,
				keepAlive: false,
			});
			const message = resultMessage(model, result, startedAt);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
				return;
			}
			const text = result.output;
			if (text) {
				message.content = [{ type: "text", text }];
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			}
			stream.push({ type: "done", reason: "stop", message });
		} catch (error) {
			const message: AssistantMessage = {
				...partial,
				stopReason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startedAt,
			};
			stream.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
		}
	})();
	return stream;
}

export function registerAnimaClaudeProvider(pi: ExtensionAPI, execute: ExecuteAnimaTurn): void {
	pi.registerProvider(ANIMA_CLAUDE_PROVIDER, {
		baseUrl: "http://anima.local/control",
		apiKey: "anima-managed",
		api: ANIMA_CLAUDE_API,
		authHeader: false,
		fetchDynamicModels: async () => providerModels(),
		streamSimple: (model, context, options) => streamAnimaClaude(model, context, options, execute),
	});
}
