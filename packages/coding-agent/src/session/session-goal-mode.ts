import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import { GoalRuntime } from "../goals/runtime";
import type { GoalModeState, GoalTokenUsage } from "../goals/state";
import goalModeContextPrompt from "../prompts/goals/goal-mode-context.md" with { type: "text" };
import goalTodoContextPrompt from "../prompts/goals/goal-todo-context.md" with { type: "text" };
import type { TodoPhase } from "../tools/todo";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";

/** Capabilities the goal-mode coordinator borrows from its owning session. */
export interface SessionGoalModeHost {
	/** Live per-turn token usage; read fresh at every lifecycle call, never cached. */
	currentTokenUsage(): GoalTokenUsage;
	/** Route a runtime-emitted goal event onto the session's public event stream. */
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	/** Persist a mode transition into the session transcript. */
	appendModeChange(mode: string, data?: Record<string, unknown>): void;
	/** Deliver a hidden custom message through the session's normal send path. */
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<boolean>;
	/** Whether todo context is enabled at this call site. */
	todoEnabled(): boolean;
	/** Names of tools currently callable by the agent. */
	getActiveToolNames(): string[];
	/** Current todo phases, in display order. */
	getTodoPhases(): TodoPhase[];
}

/**
 * Owns the session's goal-mode state, its {@link GoalRuntime}, and the
 * goal-context message builders. Keeping the state, the runtime that mutates
 * it, and the prompt rendering in one class gives goal mode a single owner
 * instead of three fields scattered across {@link AgentSession}; lifecycle
 * events (turn start, tool completion, agent end, abort) arrive here as
 * method calls so ordering and snapshot semantics stay exactly where the
 * session's event plumbing already placed them.
 */
export class SessionGoalMode {
	readonly #host: SessionGoalModeHost;
	#state: GoalModeState | undefined;
	readonly #runtime: GoalRuntime;
	#turnCounter = 0;

	constructor(host: SessionGoalModeHost) {
		this.#host = host;
		this.#runtime = new GoalRuntime({
			getState: () => this.#state,
			setState: state => {
				this.#state = state;
			},
			getCurrentUsage: () => this.#host.currentTokenUsage(),
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#host.emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.#host.appendModeChange("none");
				} else if (state) {
					this.#host.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.#host.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#state;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#state = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#runtime;
	}

	/** Snapshot the goal's turn baseline at a `turn_start` boundary. */
	onTurnStart(): void {
		const usage = this.#host.currentTokenUsage();
		this.#runtime.onTurnStart(`turn-${++this.#turnCounter}`, usage);
	}

	/** Route a finished tool execution into goal accounting. */
	onToolCompleted(toolName: string): Promise<void> {
		return toolName === "goal" ? this.#runtime.onGoalToolCompleted() : this.#runtime.onToolCompleted(toolName);
	}

	/** Account wall-clock time and usage when the agent settles. */
	onAgentEnd(): Promise<void> {
		return this.#runtime.onAgentEnd({ currentUsage: this.#host.currentTokenUsage() });
	}

	/** Notify the runtime that the active task was aborted. */
	onTaskAborted(options?: { reason?: "interrupted" | "internal" }): Promise<void> {
		return this.#runtime.onTaskAborted(options);
	}

	/** Inject the goal mode context message into the conversation history. */
	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.buildGoalModeMessage();
		if (!message) return;
		await this.#host.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	buildGoalModeMessage(): CustomMessage | null {
		const content = this.#runtime.buildActivePrompt();
		if (!content) return null;
		const todoContext = this.#buildGoalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalModeContextPrompt, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#sanitizeGoalTodoText(text: string): string {
		return escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	}

	#buildGoalTodoContext(): string | undefined {
		if (!this.#host.todoEnabled()) return undefined;
		const canCallTodoTool = this.#host.getActiveToolNames().includes("todo");
		if (!canCallTodoTool) return undefined;
		const phases = this.#host.getTodoPhases().filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return undefined;

		let total = 0;
		let closed = 0;
		let open = 0;
		const promptPhases = phases.map(phase => ({
			name: this.#sanitizeGoalTodoText(phase.name),
			tasks: phase.tasks.map(task => {
				total++;
				if (task.status === "completed" || task.status === "abandoned") {
					closed++;
				} else {
					open++;
				}
				return { content: this.#sanitizeGoalTodoText(task.content), status: task.status };
			}),
		}));

		return prompt.render(goalTodoContextPrompt, {
			canCallTodoTool,
			closed: String(closed),
			open: String(open),
			phases: promptPhases,
			total: String(total),
		});
	}
}
