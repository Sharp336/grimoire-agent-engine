/**
 * TraceRecorder: consumes agent events and builds a SessionTrace in memory.
 */
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionTrace } from "./types";

export class TraceRecorder {
	#trace: SessionTrace | undefined;
	#sessionId: string | undefined;
	#pendingPrompt: string | undefined;

	getTrace(): SessionTrace | undefined {
		return this.#trace;
	}

	/**
	 * Seed the user prompt before the trace is created (e.g. from before_agent_start).
	 */
	seedPrompt(prompt: string): void {
		if (this.#trace) {
			this.#trace.userPrompt = prompt;
		} else {
			this.#pendingPrompt = prompt;
		}
	}

	onAgentStart(_event: AgentStartEvent, ctx: ExtensionContext): void {
		this.#sessionId = ctx.sessionManager.getSessionId();
		// Use pending prompt if set by before_agent_start before trace existed
		const userPrompt = this.#pendingPrompt ?? this.#trace?.userPrompt ?? "";
		this.#pendingPrompt = undefined;
		this.#trace = {
			sessionId: this.#sessionId,
			cwd: ctx.cwd,
			userPrompt,
			startTime: Date.now(),
			endTime: 0,
			entries: [],
			toolCallCount: 0,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: false,
		};
	}

	onInput(text: string): void {
		if (!this.#trace) return;
		this.#trace.userPrompt = text;
		this.#trace.entries.push({
			type: "user_input",
			timestamp: Date.now(),
			content: text,
		});
	}

	onToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (!this.#trace) return;
		this.#trace.toolCallCount++;
		this.#trace.entries.push({
			type: "tool_call",
			timestamp: Date.now(),
			toolName: event.toolName,
			args: event.args,
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (!this.#trace) return;
		if (event.isError) {
			this.#trace.errorCount++;
		}
		// Recovery = error followed by non-error within same session
		if (this.#trace.errorCount > 0 && !event.isError) {
			this.#trace.hadRecovery = true;
		}
		this.#trace.entries.push({
			type: "tool_result",
			timestamp: Date.now(),
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		});
	}

	onMessageEnd(event: MessageEndEvent): void {
		if (!this.#trace) return;
		const msg = event.message;
		if (msg.role === "assistant" && typeof msg.content === "string") {
			this.#trace.entries.push({
				type: "assistant_message",
				timestamp: Date.now(),
				content: msg.content,
			});
		}
	}

	onAgentEnd(_event: AgentEndEvent): SessionTrace | undefined {
		if (!this.#trace) return undefined;
		this.#trace.endTime = Date.now();
		// Heuristic: completed successfully if no errors and at least one tool call
		this.#trace.completedSuccessfully = this.#trace.errorCount === 0 && this.#trace.toolCallCount > 0;
		const result = this.#trace;
		this.#trace = undefined;
		return result;
	}

	reset(): void {
		this.#trace = undefined;
		this.#pendingPrompt = undefined;
	}
}

/**
 * Build a concise summary from a SessionTrace for episode storage.
 */
export function summarizeTrace(trace: SessionTrace): {
	summary: string;
	toolsUsed: string[];
	filesModified: string[];
} {
	const toolsUsed = new Set<string>();
	const filesModified = new Set<string>();

	for (const entry of trace.entries) {
		if (entry.type === "tool_call" && entry.toolName) {
			toolsUsed.add(entry.toolName);
			// Heuristic: detect file-modifying tools
			if (entry.toolName === "write" || entry.toolName === "edit" || entry.toolName === "ast_edit") {
				const path = (entry.args as Record<string, unknown>)?.path;
				if (typeof path === "string") {
					filesModified.add(path);
				}
			}
		}
	}

	const toolList = Array.from(toolsUsed).join(", ");
	const outcome = trace.completedSuccessfully
		? trace.hadRecovery
			? "completed with recovery"
			: "completed successfully"
		: trace.errorCount > 0
			? `failed with ${trace.errorCount} error(s)`
			: "no tool calls";

	const summary = `Task: ${trace.userPrompt.slice(0, 120)}${trace.userPrompt.length > 120 ? "..." : ""} | Tools: ${toolList} | Outcome: ${outcome}`;

	return {
		summary,
		toolsUsed: Array.from(toolsUsed),
		filesModified: Array.from(filesModified),
	};
}
