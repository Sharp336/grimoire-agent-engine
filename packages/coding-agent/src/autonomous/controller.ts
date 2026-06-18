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
 * the controller for its lifetime (same pattern as AutoLearnController), so no
 * explicit disposal is needed.
 *
 * Arming: the controller is constructed before `runInteractiveMode` drains its
 * startup messages, so it starts disarmed and ignores `agent_end` until
 * {@link AutonomousController.begin} is called once startup is done. This keeps
 * the first startup turn's `agent_end` from racing the remaining
 * `session.prompt(...)` calls.
 *
 * Interrupt safety: a user interrupt (Esc) aborts the in-flight turn with
 * `stopReason: "aborted"`. The controller treats a non-clean stop (`aborted` or
 * `error`) as a halt signal and does not re-queue, so the agent stays idle
 * until the next clean turn re-arms the loop. A turn that started in plan or
 * goal mode is owned by that mode (its `agent_end` fires before the mode's exit
 * cleanup settles), so it is skipped — the start-of-turn mode is latched on
 * `agent_start`, mirroring AutoLearnController, because a `goal`/`plan` tool can
 * clear the live flag mid-turn.
 *
 * Completion (steps mode only): a pure-steps autonomous continuation that takes
 * no action (no tool calls) means the objective is done, so the controller
 * disarms instead of re-queuing forever. Idea and combined modes are endless by
 * design ("until interrupted") and never auto-halt.
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

export interface AutonomousBeginOptions {
	/** A user message was submitted this launch (initial prompt or extra positionals). */
	hadInitialMessage: boolean;
	/** Resuming/forking an existing session, so the transcript already holds an objective. */
	resuming: boolean;
	/** A startup prompt threw before producing an agent_end (e.g. no model/API key). */
	startupFailed: boolean;
}

export class AutonomousController {
	readonly #session: AutonomousSession;
	readonly #prompt: string;
	/** Pure `--auto-next-steps` (no idea flag): eligible for completion-based halt. */
	readonly #stepsOnly: boolean;
	/** Idea/combined mode can self-start with no initial message (brainstorm from scratch). */
	readonly #canKickoff: boolean;
	/** False until {@link begin} arms the loop after startup messages drain. */
	#armed = false;
	/** Mode snapshot taken at `agent_start`; a goal/plan tool can clear the live flag mid-turn. */
	#turnStartedInPlanOrGoal = false;
	/** True between queueing a continuation and the `agent_end` of that turn. Marks a turn as
	 *  controller-driven so the steps-mode halt only fires on autonomous turns, not user turns. */
	#pendingAutonomousTurn = false;
	/** Outcome of the most recent `agent_end`, recorded even while disarmed so {@link begin}
	 *  can honor a failed/aborted startup turn instead of immediately re-queuing. */
	#lastTurnFailed = false;

	constructor(options: AutonomousControllerOptions) {
		this.#session = options.session;
		// Steps → continue the objective; idea → brainstorm/improve; both → cycle.
		this.#prompt =
			options.autoNextSteps && options.autoNextIdea
				? AUTONOMOUS_COMBINED
				: options.autoNextIdea
					? AUTONOMOUS_IDEA
					: AUTONOMOUS_STEPS;
		this.#stepsOnly = options.autoNextSteps && !options.autoNextIdea;
		this.#canKickoff = options.autoNextIdea;
		// The listener closure captures `this`, so the session keeps the
		// controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Latch the start-of-turn mode before any tool can flip it.
			this.#turnStartedInPlanOrGoal =
				this.#session.getPlanModeState()?.enabled === true || this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Record the outcome on every turn (even suppressed ones) so begin() can
		// honor a failed startup turn.
		const failed = lastAssistantTurnFailed(event.messages);
		this.#lastTurnFailed = failed;
		// Suppressed until begin() arms us after startup drains. Leave
		// #turnStartedInPlanOrGoal set so begin() can read the last startup turn's
		// mode (a goal/plan completion can clear the live flag before agent_end).
		if (!this.#armed) return;
		// A superseded agent_end: a fresh turn is already streaming. Don't consume
		// the per-turn latches here — the real agent_end for the in-flight turn is
		// still coming, and clearing #pendingAutonomousTurn now would make that turn
		// look non-autonomous (see event-controller's #handleAgentEnd for the guard).
		if (this.#session.isStreaming) return;
		// Consume the per-turn latches before the failed/plan-goal early returns: an
		// aborted autonomous turn must clear #pendingAutonomousTurn so the next
		// manual turn isn't misclassified, and a stale start-mode latch can't carry
		// into a turn that lacked a fresh agent_start (mirrors AutoLearnController).
		const startedInPlanOrGoal = this.#turnStartedInPlanOrGoal;
		this.#turnStartedInPlanOrGoal = false;
		const wasAutonomous = this.#pendingAutonomousTurn;
		this.#pendingAutonomousTurn = false;
		// Honor a deliberate stop (user interrupt / internal abort) or a failed
		// turn: re-queueing an error would loop on a broken state and burn tokens.
		if (failed) return;
		// A turn that started in plan/goal mode is owned by that mode; its agent_end
		// fires before exit cleanup settles, so skip to avoid racing it.
		if (startedInPlanOrGoal) return;
		// Pure-steps completion: an autonomous continuation that performed no
		// action means the objective is done — disarm rather than loop forever.
		// Only counts for turns the controller queued, so a user's question
		// (a non-autonomous turn) can't halt the loop.
		if (wasAutonomous && this.#stepsOnly && !turnHadToolActivity(event.messages)) {
			this.#armed = false;
			return;
		}
		this.#queueContinuation();
	}

	/**
	 * Arm the loop once startup messages have drained, then start the first
	 * continuation. A startup that ended badly is honored — an aborted/errored
	 * last turn, a startup prompt that threw before any agent_end, or a turn that
	 * started in plan/goal mode — so begin() never races cleanup or re-queues a
	 * failing turn. With no prior objective (fresh launch, no message), only
	 * idea/combined mode self-starts; pure steps has nothing to continue.
	 */
	begin(options: AutonomousBeginOptions): void {
		this.#armed = true;
		if (this.#session.isStreaming) return;
		const startedInPlanOrGoal = this.#turnStartedInPlanOrGoal;
		this.#turnStartedInPlanOrGoal = false;
		if (this.#lastTurnFailed || options.startupFailed || startedInPlanOrGoal) return;
		if (this.#session.getPlanModeState()?.enabled) return;
		if (this.#session.getGoalModeState()?.enabled) return;
		if (options.hadInitialMessage || options.resuming || this.#canKickoff) {
			this.#queueContinuation();
		}
	}

	#queueContinuation(): void {
		// Mark the next turn as controller-driven before the async send resolves;
		// cleared if no turn actually starts (deferred/queued/failed) so the flag
		// can't swallow a later turn's halt check.
		this.#pendingAutonomousTurn = true;
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
				if (!started) this.#pendingAutonomousTurn = false;
			})
			.catch(err => {
				this.#pendingAutonomousTurn = false;
				logger.warn("autonomous continuation failed", { err: String(err) });
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

/**
 * True when the turn performed any action — an assistant tool call or a tool
 * result. `agent_end` carries the turn's own messages, so an empty result means
 * the agent responded with prose only (no next step), the steps-mode completion
 * signal.
 */
function turnHadToolActivity(messages: readonly AgentMessage[] | undefined): boolean {
	if (!messages) return false;
	for (const message of messages) {
		if (message.role === "toolResult") return true;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") return true;
			}
		}
	}
	return false;
}
