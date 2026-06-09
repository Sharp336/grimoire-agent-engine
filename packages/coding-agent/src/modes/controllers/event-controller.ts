import { type AgentEvent, INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { type Component, Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import type { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import type { TranscriptContainer } from "../../modes/components/transcript-container";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, readPendingDisplayTag, resolveAbortLabel } from "../../session/messages";
import type { ResolveToolDetails } from "../../tools/resolve";
import { interruptHint } from "../shared";
import { TranscriptRenderer } from "./transcript-renderer";

type AgentSessionEventKind = AgentSessionEvent["type"];

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;

/**
 * Loader label shown the instant a user interrupt (Esc) is requested, kept until
 * the agent turn fully unwinds. Esc fires the abort synchronously, but the loop
 * only stops the spinner at `agent_end`, which it cannot reach until every
 * in-flight tool settles its abort in `executeToolCalls` (`Promise.allSettled`).
 * Swapping the steady "Working…" for this acknowledges the keypress instead of
 * reading as an ignored Esc for the seconds a slow tool takes to tear down.
 */
export const INTERRUPTING_WORKING_MESSAGE = "Interrupting…";

// Events that change foreground streaming state, or that reset a turn. The TUI
// eager native-scrollback rebuild mode is recomputed only on these so unrelated
// IRC/notices/status refreshes do not toggle scrollback replay policy.
const STREAM_RENDER_MODE_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_start: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
};

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundToolCallIds = new Set<string>();
	#assistantMessageStreaming = false;
	#agentTurnActive = false;
	#interrupting = false;
	#renderer: TranscriptRenderer;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	#handlers: AgentSessionEventHandlers;

	constructor(private ctx: InteractiveModeContext) {
		this.#renderer = new TranscriptRenderer(
			{
				getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
				getHideThinkingBlock: () => this.ctx.hideThinkingBlock,
				getToolResultPreview: () => this.ctx.settings.get("read.toolResultPreview"),
				getToolOutputExpanded: () => this.ctx.toolOutputExpanded,
				getShowImages: () => settings.get("terminal.showImages"),
				requestRender: () => this.ctx.ui.requestRender(),
				ui: this.ctx.ui,
				pendingTools: this.ctx.pendingTools,
				getToolByName: toolName => this.ctx.session.getToolByName?.(toolName),
				getCwd: () => this.ctx.sessionManager.getCwd(),
				getSnapshots: () => getFileSnapshotStore(this.ctx.session),
				getEditFuzzyThreshold: () => settings.get("edit.fuzzyThreshold"),
				getEditAllowFuzzy: () => settings.get("edit.fuzzyMatch"),
				getAssistantThinkingRenderers: () =>
					this.ctx.session.extensionRunner?.getAssistantThinkingRenderers() ?? [],
				getImageBudget: () => this.ctx.ui?.imageBudget,
				getStreamingComponent: () => this.ctx.streamingComponent,
				setStreamingComponent: component => {
					this.ctx.streamingComponent = component;
				},
				setStreamingMessage: message => {
					this.ctx.streamingMessage = message;
				},
				getAssistantMessageDisplay: message => this.#getAssistantMessageDisplay(message),
			},
			this.ctx.chatContainer as TranscriptContainer,
		);
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async () => {},
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				this.ctx.ui.requestRender();
			},
			goal_updated: async () => {},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#renderer.dispose();
		this.#cancelIdleCompaction();
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
	}

	#getAssistantMessageDisplay(message: AssistantMessage): AssistantMessage {
		const aborted = message.stopReason === "aborted";
		const silentlyAborted = aborted && isSilentAbort(message.errorMessage);
		const ttsrSilenced = aborted && this.ctx.session.isTtsrAbortPending;
		if (aborted && !silentlyAborted && !ttsrSilenced) {
			// Resolve the operator-facing label: a user-interrupt (Esc) abort
			// carries USER_INTERRUPT_LABEL on errorMessage (threaded through the
			// AbortController), which is preserved verbatim; any other abort with
			// no threaded reason falls back to the retry-aware generic label.
			// AgentSession.#handleAgentEvent already stamped SILENT_ABORT_MARKER for
			// the plan-compact transition before this controller ran, so reaching
			// this branch implies the abort was NOT a silent internal transition.
			message.errorMessage = resolveAbortLabel(message.errorMessage, this.ctx.session.retryAttempt);
		}
		if (silentlyAborted || ttsrSilenced) {
			// Silence the streaming render by downgrading stopReason to "stop" for
			// display only — does NOT mutate the persisted message's stopReason
			// (the marker on errorMessage drives replay-side suppression).
			return { ...message, stopReason: "stop" as const };
		}
		return message;
	}
	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.#interrupting) return;
		// Streamed JSON can deliver non-string `_i` (object, number, boolean) before
		// schema validation; `?.` only guards null/undefined, so guard the type too.
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	/**
	 * Acknowledge a user interrupt (Esc) immediately: switch the loader to
	 * `INTERRUPTING_WORKING_MESSAGE` and freeze intent-driven working-message
	 * updates for the rest of the turn so a late `tool_execution_start` intent
	 * cannot repaint a "Working…/<intent>" line over the acknowledgment. Reset at
	 * the next `agent_start`. No-op outside an active turn or if already set.
	 */
	notifyInterrupting(): void {
		if (!this.#agentTurnActive || this.#interrupting) return;
		this.#interrupting = true;
		this.ctx.setWorkingMessage(INTERRUPTING_WORKING_MESSAGE);
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.handleEvent(event);
		});
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();

		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
		// While an assistant turn is active, visible status chrome and foreground
		// transcript blocks can re-render after rows have entered native scrollback
		// (idle Working loader, Markdown fences, wrapping, tool previews). Let the
		// TUI use its foreground live-region path instead of idle deferral, which
		// can otherwise leave the loader/status frame frozen until the next input.
		// Background-running tools after the turn ends are excluded so late async
		// updates keep the no-yank deferral; agent_start/agent_end bracket the
		// foreground turn.
		if (STREAM_RENDER_MODE_EVENTS[event.type]) {
			this.#refreshToolRenderMode();
		}
	}

	#refreshToolRenderMode(): void {
		let foregroundToolActive = this.#agentTurnActive || this.#assistantMessageStreaming;
		if (!foregroundToolActive) {
			for (const toolCallId of this.ctx.pendingTools.keys()) {
				if (!this.#backgroundToolCallIds.has(toolCallId)) {
					foregroundToolActive = true;
					break;
				}
			}
		}
		this.ctx.ui.setEagerNativeScrollbackRebuild(foregroundToolActive);
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#agentTurnActive = true;
		this.#interrupting = false;
		this.#lastIntent = undefined;
		this.#renderer.feed(_event as AgentEvent);
		this.#assistantMessageStreaming = false;
		// Restore the previous turn's inline error in the transcript before dropping
		// the banner, so the error stays in history once the banner is gone.
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.#cancelIdleCompaction();
		this.#refreshToolRenderMode();
		this.ctx.ensureLoadingAnimation();
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#renderer.feed(event as AgentEvent);
			this.ctx.addMessageToChat(event.message);
			// Tag-keyed pending-bar refresh: when AgentSession.#handleAgentEvent
			// spliced this dequeued custom message out of #steeringMessages /
			// #followUpMessages (it ran before this emit), the array state is
			// already correct — pendingMessagesContainer just needs to be
			// re-rendered to match. Gated on tag presence so non-queued customs
			// (ttsr-injection, irc:*, async-result, hookMessage) skip the
			// rebuild; their dispatch path never registered a pending chip.
			// Mirrors the user-role refresh at the bottom of this function.
			if (event.message.role === "custom" && readPendingDisplayTag(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			const textContent = this.ctx.getUserMessageText(event.message);
			const imageBlocks =
				typeof event.message.content === "string"
					? []
					: event.message.content.filter(
							(content): content is ImageContent =>
								content.type === "image" &&
								typeof content.data === "string" &&
								typeof content.mimeType === "string",
						);
			const imageCount = imageBlocks.length;
			const signature = `${textContent}\u0000${imageCount}`;

			this.#renderer.feed(event as AgentEvent);
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const wasLocallySubmitted = this.ctx.locallySubmittedUserSignatures.delete(signature) || wasOptimistic;
			if (!wasOptimistic) {
				// Append synchronously: #emit dispatches to this listener fire-and-forget
				// (see AgentSession.#emit), so any await between the user message_start and
				// addMessageToChat lets later events (assistant message_start, tool execution
				// start/end) append their components first and scramble transcript order /
				// live-region block boundaries. addMessageToChat materializes clickable image
				// links via the synchronous putBlobSync fallback, so no await is needed here.
				this.ctx.addMessageToChat(event.message);
			}
			if (wasOptimistic) {
				this.ctx.optimisticUserMessageSignature = undefined;
			}

			// Clear the editor only when the submission did not originate from a
			// local submission (optimistic or queued-while-streaming). Both local
			// paths already cleared the editor at submit time; clearing again here
			// would race with the user typing the next prompt while the previous
			// large redraw lands and erase their in-progress draft (#783).
			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.#renderer.feed(event as AgentEvent);
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.#assistantMessageStreaming = true;
			this.#renderer.feed(event as AgentEvent);
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#renderer.feed({ type: "message_start", message: event.message } as AgentEvent);
		const components = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, components);
		this.ctx.ui.requestRender();
	}

	#scheduleIrcExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			for (const component of components) {
				this.ctx.chatContainer.removeChild(component);
			}
			this.ctx.ui.requestRender();
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		if (event.message.role !== "assistant") return;

		// Update working message with intent from streamed tool arguments
		for (const content of event.message.content) {
			if (content.type !== "toolCall") continue;
			const args = content.arguments;
			if (!args || typeof args !== "object") continue;
			if (INTENT_FIELD in args) {
				this.#updateWorkingMessageFromIntent(args[INTENT_FIELD]);
				continue;
			}
			const tool = this.ctx.session.getToolByName?.(content.name);
			if (typeof tool?.intent !== "function") continue;
			try {
				const derived = tool.intent(args as never)?.trim();
				if (derived) {
					this.#updateWorkingMessageFromIntent(derived);
				}
			} catch {
				// intent function must never break the UI
			}
		}
		this.#renderer.feed(event as AgentEvent);
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		if (event.message.role !== "assistant") {
			this.#renderer.feed(event as AgentEvent);
			this.ctx.ui.requestRender();
			return;
		}
		this.#assistantMessageStreaming = false;
		const endingComponent = this.#renderer.streamingComponent ?? this.ctx.streamingComponent;
		this.#renderer.feed(event as AgentEvent);
		// Pin a turn-ending provider error (e.g. Anthropic content-filter block)
		// above the editor so it survives transcript scroll. Cleared at the next
		// turn's agent_start. Suppress the transcript's inline `Error: …` line for
		// the same message while pinned so the error isn't rendered twice.
		if (
			event.message.stopReason === "error" &&
			event.message.errorMessage &&
			!isSilentAbort(event.message.errorMessage)
		) {
			endingComponent?.setErrorPinned(true);
			this.#pinnedErrorComponent = endingComponent;
			this.ctx.showPinnedError(event.message.errorMessage);
		}
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#updateWorkingMessageFromIntent(event.intent);
		this.#renderer.feed(event as AgentEvent);
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#renderer.feed(event as AgentEvent);
		const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
		if (asyncState === "completed" || asyncState === "failed") {
			this.#backgroundToolCallIds.delete(event.toolCallId);
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		this.#renderer.feed(event as AgentEvent);
		const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
		if (asyncState === "running") {
			this.#backgroundToolCallIds.add(event.toolCallId);
		} else {
			this.#backgroundToolCallIds.delete(event.toolCallId);
		}
		// Update todo display when todo tool completes
		if (event.toolName === "todo" && !event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setTodos(details.phases);
			}
		} else if (event.toolName === "todo" && event.isError) {
			const textContent = event.result.content.find(
				(content: { type: string; text?: string }) => content.type === "text",
			)?.text;
			this.ctx.showWarning(
				`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo succeeds."}`,
			);
		}
		if (event.toolName === "resolve" && !event.isError) {
			const details = event.result.details as ResolveToolDetails | undefined;
			if (details?.sourceToolName === "plan_approval" && details.action === "apply") {
				const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
				if (planDetails) {
					await this.ctx.handlePlanApproval(planDetails);
				}
			}
		}
	}
	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		this.#agentTurnActive = false;
		this.#assistantMessageStreaming = false;
		this.#renderer.feed(_event as AgentEvent);
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.clear();
		}
		await this.ctx.flushPendingModelSwitch();
		this.#backgroundToolCallIds = new Set(
			Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.sendCompletionNotification();
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.ctx.autoCompactionEscapeHandler = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => {
			this.ctx.session.abortCompaction();
		};
		this.ctx.statusContainer.clear();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel =
			event.action === "handoff"
				? "Auto-handoff"
				: event.action === "shake"
					? "Auto-shake"
					: "Auto context-full maintenance";
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		if (this.ctx.autoCompactionEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
			this.ctx.autoCompactionEscapeHandler = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		const isHandoffAction = event.action === "handoff";
		const isShakeAction = event.action === "shake";
		if (event.aborted) {
			this.ctx.showStatus(
				isHandoffAction
					? "Auto-handoff cancelled"
					: isShakeAction
						? "Auto-shake cancelled"
						: "Auto context-full maintenance cancelled",
			);
		} else if (isShakeAction) {
			// Shake produces no CompactionResult; rebuild on success, suppress benign skips.
			// The fallback path (`errorMessage` set, `skipped` false) means shake reclaimed
			// some tokens before deciding the threshold still wasn't cleared — rebuild so
			// the chat reflects the dropped regions even though a context-full pass follows.
			if (event.errorMessage) {
				if (!event.skipped) {
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorTopBorder();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			this.ctx.chatContainer.clear();
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			await this.ctx.reloadTodos();
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.ctx.retryEscapeHandler = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => {
			this.ctx.session.abortRetry();
		};
		this.ctx.statusContainer.clear();
		const delaySeconds = Math.round(event.delayMs / 1000);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		if (!event.success) {
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
		}
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.session.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.session.isStreaming) return;
			if (this.ctx.session.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.session.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#currentContextTokens(): number {
		const lastAssistant = this.ctx.session.agent.state.messages
			.slice()
			.reverse()
			.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "aborted");
		return lastAssistant?.usage ? calculatePromptTokens(lastAssistant.usage) : 0;
	}

	sendCompletionNotification(): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		// Skip when the turn was aborted (e.g. ask cancelled with Ctrl+C) or
		// errored — those are not "Task complete" events. Mirrors the gate
		// already used by #currentContextTokens, #handleMessageEnd, and the
		// retry / TTSR / compaction skip paths across agent-session.ts.
		const last = this.ctx.session.getLastAssistantMessage?.();
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Oh My Pi",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}
