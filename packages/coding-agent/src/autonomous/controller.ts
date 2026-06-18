/**
 * Autonomous continuation controller (`--auto-next-steps` / `--auto-next-idea`).
 *
 * After each completed turn the controller queues a follow-up prompt so the
 * agent keeps working without user input. `--auto-next-steps` drives it through
 * the next concrete steps of the current objective (including running tests);
 * `--auto-next-idea` pivots it to brainstorming and implementing a new
 * improvement once the current plan is done. With both flags it cycles between
 * the two until the user interrupts.
 *
 * Installed once per interactive session. The session's listener array retains
 * the controller for the session's lifetime (same pattern as AutoLearnController),
 * so no explicit disposal is needed.
 *
 * Interrupt safety: a user interrupt (Esc) aborts the in-flight turn with
 * `stopReason: "aborted"`. The controller treats an aborted stop as a stop
 * signal and does not re-queue, so the agent stays idle until the next manual
 * turn — which ends normally and re-arms the loop. Plan and goal modes are left
 * alone: both own their own continuation and would conflict with an autonomous
 * nudge.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import combinedPrompt from "./combined.md" with { type: "text" };
import ideaPrompt from "./next-idea.md" with { type: "text" };
import stepsPrompt from "./next-steps.md" with { type: "text" };

const AUTONOMOUS_STEPS = stepsPrompt.trim();
const AUTONOMOUS_IDEA = ideaPrompt.trim();
const AUTONOMOUS_COMBINED = combinedPrompt.trim();

/**
 * Minimal session surface the controller depends on. {@link AgentSession}
 * satisfies this structurally; tests pass a fake that implements only it.
 */
export interface AutonomousSession {
	subscribe(handler: (event: AgentSessionEvent) => void): unknown;
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<boolean>;
	readonly isStreaming: boolean;
	getPlanModeState(): { enabled: boolean } | undefined;
	getGoalModeState(): { enabled: boolean } | undefined;
}

export interface AutonomousControllerOptions {
	session: AutonomousSession;
	autoNextSteps: boolean;
	autoNextIdea: boolean;
}

export class AutonomousController {
	readonly #session: AutonomousSession;
	readonly #prompt: string;
	/** Without an initial user message there is no objective to "continue", so
	 *  only idea/combined mode self-starts (brainstorming from scratch). */
	readonly #canKickoff: boolean;

	constructor(options: AutonomousControllerOptions) {
		this.#session = options.session;
		// Steps → continue the objective; idea → brainstorm/improve; both → cycle.
		this.#prompt =
			options.autoNextSteps && options.autoNextIdea
				? AUTONOMOUS_COMBINED
				: options.autoNextIdea
					? AUTONOMOUS_IDEA
					: AUTONOMOUS_STEPS;
		this.#canKickoff = options.autoNextIdea;
		// The listener closure captures `this`, so the session keeps the
		// controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// A superseded agent_end: a fresh turn is already streaming, so this
		// event belongs to a turn that has been replaced (see event-controller's
		// #handleAgentEnd for the same guard).
		if (this.#session.isStreaming) return;
		// Halt on a non-clean stop: a user interrupt / internal abort, or a failed
		// turn (exhausted retries, API error). Re-queueing an error would loop on a
		// broken state and burn tokens; the loop re-arms on the next clean turn.
		if (lastAssistantTurnFailed(event.messages)) return;
		// Leave plan/goal mode to their own continuation drivers.
		if (this.#session.getPlanModeState()?.enabled) return;
		if (this.#session.getGoalModeState()?.enabled) return;
		this.#queueContinuation("turn");
	}

	/** Start the first autonomous turn when no initial user message was provided. */
	kickoff(): void {
		if (!this.#canKickoff) return;
		if (this.#session.isStreaming) return;
		this.#queueContinuation("kickoff");
	}

	#queueContinuation(reason: "turn" | "kickoff"): void {
		this.#session
			.sendCustomMessage(
				{
					customType: "autonomous-continuation",
					content: this.#prompt,
					display: false,
					attribution: "user",
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
			.then(started => {
				if (!started) logger.debug("autonomous continuation did not start a turn", { reason });
			})
			.catch(err => {
				logger.warn("autonomous continuation failed", { reason, err: String(err) });
			});
	}
}

/**
 * True when the most recent assistant message ended in a non-clean stop — a user
 * interrupt / internal abort (`aborted`) or a failed turn (`error`). Read from
 * the public event payload so the controller needs no private session state.
 */
function lastAssistantTurnFailed(messages: readonly AgentMessage[] | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			return message.stopReason === "aborted" || message.stopReason === "error";
		}
	}
	return false;
}
