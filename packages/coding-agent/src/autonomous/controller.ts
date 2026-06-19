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
 * no action after its continuation prompt (no tool calls) means the objective is
 * done, so the controller disarms instead of re-queuing forever.
 * Idea and combined modes are endless by design ("until interrupted") and never auto-halt.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import combinedPrompt from "./combined.md" with { type: "text" };
import ideaPrompt from "./next-idea.md" with { type: "text" };
import stepsPrompt from "./next-steps.md" with { type: "text" };

const AUTONOMOUS_CONTINUATION_MESSAGE_TYPE = "autonomous-continuation";
const AUTOLEARN_NUDGE_MESSAGE_TYPE = "autolearn-nudge";
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
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	hasQueuedCustomMessage(customType: string): boolean;
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
		// Locate our continuation prompt before classifying the turn: agent_end can
		// cover multiple drained queued turns, so an auto-learn capture before the
		// autonomous follow-up must not mask the follow-up's failure/deadline state.
		const autonomousPromptIndex = lastAutonomousPromptIndex(event.messages);
		// If a queued autonomous turn is pending and this agent_end does not contain
		// that autonomous prompt, the event belongs to another turn. Preserve the
		// marker for clean stale/superseded events and for failed turns that still
		// have the queued hidden follow-up. Clear it only when the intervening
		// failure also removed the queued prompt (Esc drops hidden continuations via
		// clearQueue({ forInterrupt: true })).
		if (this.#pendingAutonomousTurn && autonomousPromptIndex === -1) {
			const interveningFailed = lastAssistantTurnFailed(event.messages, 0);
			this.#lastTurnFailed = interveningFailed;
			if (interveningFailed && !this.#session.hasQueuedCustomMessage(AUTONOMOUS_CONTINUATION_MESSAGE_TYPE)) {
				this.#pendingAutonomousTurn = false;
				this.#turnStartedInPlanOrGoal = false;
			}
			return;
		}
		const autonomousPayloadStartIndex = autonomousPromptIndex === -1 ? 0 : autonomousPromptIndex + 1;
		// Record the outcome on every turn (even suppressed ones) so begin() can
		// honor a failed startup turn.
		const failed = lastAssistantTurnFailed(event.messages, autonomousPayloadStartIndex);
		this.#lastTurnFailed = failed;
		// Suppressed until begin() arms us after startup drains. Leave
		// #turnStartedInPlanOrGoal set so begin() can read the last startup turn's
		// mode (a goal/plan completion can clear the live flag before agent_end).
		if (!this.#armed) return;
		// If some other turn is already streaming, only queue behind the known
		// AutoLearn capture turn. Generic in-flight turns can be delayed/stale
		// agent_end delivery after a real new user turn started; those must not
		// synthesize an autonomous follow-up.
		if (
			this.#session.isStreaming &&
			!this.#pendingAutonomousTurn &&
			!isAutoLearnCaptureInFlight(this.#session.messages)
		) {
			return;
		}
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
		// (a non-autonomous turn) can't halt the loop. When the autonomous prompt
		// ran as a queued follow-up behind another synthetic turn, ignore tool
		// activity before our prompt boundary.
		if (wasAutonomous && this.#stepsOnly && !turnHadToolActivity(event.messages, autonomousPayloadStartIndex)) {
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
		// Mark the next turn as controller-driven before the async send resolves.
		// The marker is consumed by the next non-superseded agent_end. If the send
		// resolves started=false the message was queued as a follow-up behind
		// another in-flight turn (e.g. AutoLearnController.autoContinue's capture
		// turn) and WILL still run — so keep the marker for that follow-up's
		// eventual agent_end; only a failed send clears it (the catch below).
		// Clearing on !started would make the queued turn's agent_end look manual
		// and skip the steps-mode completion halt.
		this.#pendingAutonomousTurn = true;
		this.#session
			.sendCustomMessage(
				{
					customType: AUTONOMOUS_CONTINUATION_MESSAGE_TYPE,
					content: this.#prompt,
					display: false,
					attribution: "user",
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
			.catch(err => {
				this.#pendingAutonomousTurn = false;
				const message = err instanceof Error ? err.message : String(err);
				this.#session.emitNotice("error", `Autonomous continuation failed: ${message}`, "auto-next");
				logger.warn("autonomous continuation failed", { err: message });
			});
	}
}

/**
 * True when the turn did not end with a clean assistant message: a user
 * interrupt / internal abort (`aborted`), a failed turn (`error`), no assistant
 * message at all, or tool results with no later assistant response. The last
 * two cases cover `--max-time` deadline paths: one exits before an assistant
 * exists, and one exits after appending skipped/aborted tool results for an
 * assistant tool-call turn. Both must not trigger another continuation —
 * idea/combined would otherwise spin past the deadline. Read from the public
 * event payload so the controller needs no private session state.
 */
function lastAssistantTurnFailed(messages: readonly AgentMessage[] | undefined, startIndex: number): boolean {
	if (!messages) return true;
	const firstIndex = startIndex < 0 ? 0 : startIndex;
	if (firstIndex >= messages.length) return true;
	const finalMessage = messages[messages.length - 1]!;
	if (finalMessage.role !== "assistant") return true;
	return finalMessage.stopReason === "aborted" || finalMessage.stopReason === "error";
}

/** Return the last autonomous continuation prompt in an agent_end payload, if present. */
function lastAutonomousPromptIndex(messages: readonly AgentMessage[] | undefined): number {
	if (!messages) return -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "custom" && message.customType === AUTONOMOUS_CONTINUATION_MESSAGE_TYPE) {
			return i;
		}
	}
	return -1;
}

/**
 * True when the live streaming turn was started by AutoLearn's synthetic
 * capture prompt. Scan backward past assistant/tool-result messages so a capture
 * that is already working still resolves to its initiating custom prompt.
 */
function isAutoLearnCaptureInFlight(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant" || message.role === "toolResult") continue;
		return message.role === "custom" && message.customType === AUTOLEARN_NUDGE_MESSAGE_TYPE;
	}
	return false;
}

/**
 * True when the selected message window performed any action — an assistant tool
 * call or a tool result. `agent_end` can include multiple drained queued turns;
 * `startIndex` lets steps-mode completion consider only messages after this
 * controller's autonomous continuation prompt, so a preceding synthetic turn
 * (for example auto-learn capture) cannot mask a no-action autonomous follow-up.
 */
function turnHadToolActivity(messages: readonly AgentMessage[] | undefined, startIndex: number): boolean {
	if (!messages) return false;
	const firstIndex = startIndex < 0 ? 0 : startIndex;
	for (let i = firstIndex; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "toolResult") return true;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") return true;
			}
		}
	}
	return false;
}
