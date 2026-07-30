Warning: truncated output (original token count: 47214)
Total output lines: 4964

/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	LoaderMessageColorFn,
	NativeScrollbackLiveRegion,
	OverlayHandle,
	SlashCommand,
} from "@oh-my-pi/pi-tui";
import {
	Container,
	clearRenderCache,
	Loader,
	Markdown,
	ProcessTerminal,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { isInsideTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	$env,
	APP_NAME,
	adjustHsv,
	formatNumber,
	getProjectDir,
	hsvToRgb,
	isEnoent,
	logger,
	postmortem,
	prompt,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { reset as resetCapabilities } from "../capability";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { KeybindingsManager } from "../config/keybindings";
import { formatModelString, type ResolvedModelRoleValue } from "../config/model-resolver";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import {
	isSettingsInitialized,
	onModelRolesChanged,
	onStatusLineSessionAccentChanged,
	Settings,
	settings,
} from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import { resolveLocalUrlToPath } from "../internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import {
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "../mcp/startup-events";
import { humanizePlanTitle, type PlanApprovalDetails, resolvePlanTitle } from "../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	type AgentSession,
	type AgentSessionEvent,
	type ResolvedRoleModel,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { formatDuration } from "../slash-commands/helpers/format";
import { STTController, type SttState } from "../stt";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { formatTaskId } from "../task/render";
import type { ConfiguredThinkingLevel } from "../thinking";
import { tinyTitleClient } from "../tiny/title-client";
import type { LspStartupServerInfo } from "../tools";
import { normalizeLocalScheme } from "../tools/path-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import {
	formatPhaseDisplayName,
	selectCollapsedTodos,
	setActiveTodoDescriptionsProvider,
	todoMatchesAnyDescription,
} from "../tools/todo";
import { vocalizer } from "../tts/vocalizer";
import { renderTreeList } from "../tui/tree-list";
import { formatStartupChangelogSummary, type StartupChangelogSelection } from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { messageHasDisplayableThinking } from "../utils/thinking-display";
import {
	disposeTerminalTitleState,
	popTerminalTitle,
	pushTerminalTitle,
	setSessionTerminalTitle,
	setTerminalTitleStateEnabled,
} from "../utils/title-generator";
import {
	aggregateVibeWorkerTokensPerSecond,
	type VibeOwnerScope,
	type VibeParentSession,
	VibeSessionRegistry,
} from "../vibe/runtime";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import { ErrorBannerComponent } from "./components/error-banner";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/hook-selector";
import { type PlanReviewAnnotationState, PlanReviewOverlay } from "./components/plan-review-overlay";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { WelcomeComponent, type LspServerInfo as WelcomeLspServerInfo } from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { LiveCommandController } from "./controllers/live-command-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { OmfgController } from "./controllers/omfg-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TanCommandController } from "./controllers/tan-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "./loop-limit";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningSubagentBadgeAgents, getRunningSubagentBadgeRegistry } from "./running-subagent-badge";
import {
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { interruptHint } from "./shared";
import { clearMermaidCache } from "./theme/mermaid-cache";
import { type ShimmerPalette, shimmerEnabled, shimmerSegments, shimmerText } from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	setMarkdownMermaidRendering,
	startMacOSAppearanceReprobeFallback,
	theme,
} from "./theme/theme";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	RenderSessionContextOptions,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const STILL_CLOSING_DELAY_MS = 3_000;

const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

interface WorkingMessageAccent {
	main: string;
	dim: string;
}

interface WorkingMessageAccentCacheKey {
	sessionName: string | undefined;
	accentSurfaceLuminance: number | undefined;
	sessionAccentEnabled: boolean;
}

/**
 * Intern the shimmer palettes for each `WorkingMessageAccent` so `compile()`
 * inside `shimmerSegments` sees a stable palette object between animation
 * ticks. Allocating fresh palette literals every frame guaranteed a cache miss
 * on the Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
 * every tier open/close for the ~30fps loader redraw (issue #4377).
 */
const workingMessagePaletteCache = new WeakMap<WorkingMessageAccent, { main: ShimmerPalette; hint: ShimmerPalette }>();

function workingMessagePalettes(accent: WorkingMessageAccent): { main: ShimmerPalette; hint: ShimmerPalette } {
	let entry = workingMessagePaletteCache.get(accent);
	if (!entry) {
		entry = {
			main: { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true },
			hint: { low: "dim", mid: { ansi: accent.dim }, high: { ansi: accent.dim } },
		};
		workingMessagePaletteCache.set(accent, entry);
	}
	return entry;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent): string {
	const palettes = accent ? workingMessagePalettes(accent) : undefined;
	const palette = palettes?.main;
	const hint = interruptHint();
	if (!message.endsWith(hint)) return shimmerText(message, theme, palette);
	const header = message.slice(0, -hint.length);
	return shimmerSegments(
		[
			{ text: header, palette },
			{ text: hint, palette: palettes?.hint ?? HINT_SHIMMER_PALETTE },
		],
		theme,
	);
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, rows - EDITOR_RESERVED_ROWS));
	return Math.max(EDITOR_MIN_RENDERED_ROWS, Math.min(comfortable, rows - EDITOR_MIN_CHROME_ROWS));
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);
const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/**
 * Anchored live-region container for the HUD/status rows between the transcript
 * and the editor (working loader, todo + subagent HUDs, transient notification
 * panels). While it has content every row is live: it reports a seam at 0 so the
 * engine never commits these anchored, rebuilt-in-place rows to native
 * scrollback — otherwise stale duplicates pile up above the live copy on short
 * terminals once the loader sits below a tall HUD. The transcript's own seam,
 * when present, sits higher and wins (topmost-seam merge in TUI.render).
 */
class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * a bounded set of running-agent rows in the same `Id: description` shape the
 * inline task rows use (muted task preview when no description was given).
 * Layout mirrors the Todos HUD exactly: unindented header, then
 * `renderTreeList` rows (dim connectors) shifted right by one space.
 * Only detached background spawns are listed: a sync task call blocks the
 * parent turn and its inline tool block already renders progress live, and
 * eval `agent()` spawns are rendered by their own eval cell tree.
 * Returns an empty array when nothing is running so the container can clear.
 */
export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const dot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const displayId = formatTaskId(session.id);
				let line = `${dot} ${theme.fg("accent", theme.bold(displayId))}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				if (description) {
					const budget = Math.max(TRUNCATE_LENGTHS.SHORT, columns - visibleWidth(displayId) - 10);
					line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(replaceTabs(description), budget))}`;
				} else {
					// No spawn description: fall back to a muted task preview, same as
					// the inline task rows when a row has no label.
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview) {
						line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(taskPreview), TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Hub for full list`));
	}
	return ["", theme.bold(theme.fg("accent", "Subagents")), ...rows.map(line => ` ${line}`)];
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	btwContainer: Container;
	omfgContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	goalModeEnabled = false;
	goalModePaused = false;
	vibeModeEnabled = false;
	planModePlanFilePath: string | undefined = undefined;
	loopModeEnabled = false;
	loopModePaused = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();
	/** Whether the visible session has produced thinking content the user can reveal. */
	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}
	/** Record received reasoning content so Ctrl+T can reveal it even when model metadata says thinking is off. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}
	/**
	 * Effective thinking-block visibility: hidden when the user's setting is on,
	 * or while thinking is "off" before the session has actually produced
	 * displayable thinking content. Some providers return thinking blocks without
	 * advertising reasoning support, so observed content unlocks the visibility
	 * toggle.
	 */
	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}
	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;
	get #defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	#optimisticUserMessageComponents: Component[] = [];
	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastLeftTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#pendingCommandOutput: Component[] = [];
	#pendingCommandOutputSessionId: string | undefined;
	#pendingSlashCommands: SlashCommand[] = [];
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	readonly #startupChangelog: StartupChangelogSelection | undefined;
	#planModePreviousTools: string[] | undefined;
	#goalModePreviousTools: string[] | undefined;
	#vibeModePreviousTools: string[] | undefined;
	#vibeModeOwnerScope: VibeOwnerScope | undefined;
	#vibeScopeSuspendedForSwitch = false;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Whether #pendingModelSwitch was queued by the live plan-role reconciler. */
	#pendingPlanModelSwitch = false;
	#planModeHasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#planReviewCancel: (() => void) | undefined;
	/** Serializable review annotations keyed by the resolved plan file path. */
	#planReviewAnnotationState = new Map<string, PlanReviewAnnotationState>();
	/** Annotation state held until the associated queued refinement actually starts. */
	#planReviewAnnotationStateBySubmission = new WeakMap<SubmittedUserInput, string>();
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
	readonly #omfgController: OmfgController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #liveCommandController: LiveCommandController;
	readonly #eventController: EventController;
	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
	}
	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	clearTransientSessionUi(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.disposeChildren();
		this.pendingMessagesContainer.disposeChildren();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.disposeChildren();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#observerUiSyncTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentRegistry;
	#mcpStatusOrder: string[] = [];
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, string>();
	#welcomeComponent?: WelcomeComponent;
	readonly #chatHost: ChatBlockHost = { requestRender: () => this.ui.requestRender() };

	constructor(
		session: AgentSession,
		version: string,
		startupChangelog: StartupChangelogSelection | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#startupChangelog = startupChangelog;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.mcpManager?.setAuthHandler((serverName, challenge) =>
			new MCPCommandController(this).handleMCPAuthChallenge(serverName, challenge),
		);
		this.#eventBus = eventBus;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));
		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.textSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
		this.chatContainer = new TranscriptContainer();
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new AnchoredLiveContainer();
		this.todoContainer = new AnchoredLiveContainer();
		this.subagentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
		this.omfgContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		this.editor = new CustomEditor(getEditorTheme());
		this.ui.enableScopedInputRender(this.editor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(settings.get("tui.imeSafeCursor"));
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.ui.requestRender();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		// Vibe worker tok/s aggregator — keeps the status-line render layer off
		// the heavy vibe/task dependency graph. The director is often idle while
		// workers stream, so without this the tok/s badge would show a stale
		// value while parallel work is actively generating tokens.
		this.statusLine.setVibeWorkerTokenRateProvider(() =>
			aggregateVibeWorkerTokensPerSecond(this.session.getAgentId() ?? MAIN_AGENT_ID),
		);
		// Lazy provider — the top border rebuild coalesces to at most one
		// invocation per painted frame instead of firing on every session event
		// (#4145). The TUI throttles renders at ~30fps, so a long-running eval
		// spraying events no longer runs `getTopBorder` synchronously in the
		// hot path where the render never gets to paint the result.
		this.editor.setTopBorderProvider(availableWidth => this.statusLine.getTopBorder(availableWidth));

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		const skillCommandList = this.#rebuildSkillCommandsFromSession();

		const builtinCommands = buildTuiBuiltinSlashCommands({ ctx: this });
		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#tanCommandController = new TanCommandController(this);
		this.#omfgController = new OmfgController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#liveCommandController = new LiveCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#focusController = new SessionFocusController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpStatusOrder = [];
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#trackMcpStatusServer(serverName);
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, event.error);
		}

		const message = formatMCPConnectionStatusMessage({
			pendingServers: this.#orderedMcpStatusServers(this.#mcpPendingServers),
			connectedServers: this.#orderedMcpStatusServers(this.#mcpConnectedServers),
			failedServers: this.#orderedMcpStatusFailures(),
		});
		if (message) this.showStatus(message);
	}

	#trackMcpStatusServer(serverName: string): void {
		if (!this.#mcpStatusOrder.includes(serverName)) {
			this.#mcpStatusOrder.push(serverName);
		}
	}

	#orderedMcpStatusServers(servers: ReadonlySet<string>): string[] {
		return this.#mcpStatusOrder.filter(serverName => servers.has(serverName));
	}

	#orderedMcpStatusFailures(): Array<{ serverName: string; error: string }> {
		return this.#mcpStatusOrder.flatMap(serverName => {
			const error = this.#mcpFailedServers.get(serverName);
			return error === undefined ? [] : [{ serverName, error }];
		});
	}

	playWelcomeIntro(): void {
		const welcome = this.#welcomeComponent;
		// Component-scoped: the intro only mutates the welcome box's own rows,
		// so a resumed long transcript is not re-walked per animation frame.
		welcome?.playIntro(() => this.ui.requestComponentRender(welcome));
	}

	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		// Route SIGINT/SIGTERM/SIGHUP/uncaughtException through the same teardown
		// the TUI Ctrl+C keypress path performs: persist the in-progress editor
		// draft for `--resume`, then dispose the session (which emits the extension
		// `session_shutdown` event, cancels the owned async job manager, disposes
		// eval kernels, releases owned browser tabs, and closes the session
		// manager). Without this callback a real kernel signal would drop the
		// draft, skip the `session_shutdown` contract from `shared-events.ts`,
		// and orphan background bash/task processes (issue #4080). The registered
		// callback and `shutdown()` share one promise-memoized teardown, so a
		// signal arriving mid-Ctrl+C no-ops instead of racing a second dispose.
		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.editor.getText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			disposeSession: reason =>
				this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS, reason }),
		});
		// Forward the postmortem reason (SIGTERM/SIGHUP/uncaughtException/…) so the
		// persisted `session_exit` diagnostic carries the real trigger. Postmortem
		// runs callbacks in REVERSE registration order — this callback (registered
		// after the AgentSession constructor's `agent-session:<id>` recorder) runs
		// FIRST and its dispose() would otherwise persist the generic "dispose".
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		// Wire the report_tool_issue consent gate to the Yes/No dialog popup.
		// The handler is process-global — subagent tools (which can't reach
		// `showHookSelector` on their own) resolve through this exact closure.
		// `Settings.instance` is the disk-backed singleton; passing it explicitly
		// guarantees the decision persists even when the prompt is triggered
		// from a subagent whose own `Settings` is an in-memory snapshot.
		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");
		this.#welcomeComponent = undefined;

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		if (!startupQuiet) {
			// Add welcome header
			this.#welcomeComponent = new WelcomeComponent(
				this.#version,
				modelName,
				providerName,
				recentSessions,
				this.#getWelcomeLspServers(),
			);

			// Setup UI layout
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(this.#welcomeComponent);
			this.ui.addChild(new Spacer(1));
			if (!options.suppressWelcomeIntro) {
				this.playWelcomeIntro();
			}

			// Add changelog if provided
			if (this.#startupChangelog && settings.get("startup.changelogMode") !== "hidden") {
				this.ui.addChild(new DynamicBorder());
				this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
				this.ui.addChild(new Spacer(1));
				if (settings.get("startup.changelogMode") === "summary") {
					const summary = formatStartupChangelogSummary(this.#startupChangelog).replace(
						/\/changelog(?: full)?/g,
						command => theme.bold(command),
					);
					this.ui.addChild(new Text(summary, 1, 0));
				} else {
					this.ui.addChild(new Markdown(this.#startupChangelog.markdown?.trim() ?? "", 1, 0, getMarkdownTheme()));
				}
				this.ui.addChild(new Spacer(1));
				this.ui.addChild(new DynamicBorder());
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.subagentContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.omfgContainer);
		this.ui.addChild(this.errorBannerContainer);
		this.ui.addChild(this.modelCycleContainer);
		// Working loader / transient status sits below the sticky todo + subagent
		// HUDs, just above the editor's hook-widget top margin — so it reads next to
		// the prompt while keeping the one-line gap above the editor.
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.addChild(this.hookWidgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.hookWidgetContainerBelow);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});
		// Let the transient todo tool result light up pending todos executed by a
		// live subagent, matching the sticky HUD's active set (#5873).
		setActiveTodoDescriptionsProvider(() => this.#getActiveSubagentDescriptions());

		// Load initial todos
		await this.#loadTodoList();

		if (process.platform === "darwin" && TERMINAL.id === "wezterm" && !isInsideTerminalMultiplexer()) {
			this.#eventBusUnsubscribers.push(startMacOSAppearanceReprobeFallback(this.ui.terminal));
		}

		// Start the UI. Cold `omp` launch opts into clearing on the first paint so
		// the initial welcome frame does not append over the previous run's scrollback.
		this.ui.start({ clearScrollback: options.clearInitialTerminalHistory === true });
		pushTerminalTitle();
		setTerminalTitleStateEnabled(this.settings.get("tui.titleState"));
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		// Single side-effect point for title changes: every setSessionName caller
		// (first-input titling, /rename, extension renames, plan seeding, replan
		// refresh) gets the terminal title + accent updates from here. Registered
		// before initHooksAndCustomTools/#reconcileModeFromSession/#enterPlanMode —
		// all of which can reach setSessionName during init.
		this.#eventBusUnsubscribers.push(
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		// Prewarm the local tiny-title worker off the submit hot path: spawn it
		// now, idle and unref'd, so the first submit reuses a live subprocess
		// instead of paying spawn latency ahead of the first frame (issue #6462).
		// No-ops for the online default and for already-named sessions that will
		// not be titled. Deferred via setImmediate so it runs AFTER the render
		// callback requestRender(true) queued above (immediates are FIFO) — the
		// spawn syscall never lands in the same loop turn ahead of the first paint.
		setImmediate(() => {
			if (!$env.PI_NO_TITLE && !this.sessionManager.getSessionName()) {
				tinyTitleClient.prewarm(this.settings.get("providers.tinyModel"));
			}
		});

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. plan mode on resume)
		this.session.setSessionBeforeSwitchReconciler?.(async () => {
			await this.#liveCommandController.stop();
			await this.#quiesceVibeForSessionSwitch();
		});
		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await this.#reconcileModeFromSession();

		// Brand-new sessions optionally start in plan mode when the user has made it
		// the startup default. "Brand-new" means the resolved branch carries no
		// conversation context (buildSessionContext().messages — covers messages,
		// custom messages, branch summaries, and compaction summaries) and the user
		// set no explicit `mode_change` (which #reconcileModeFromSession just
		// restored). SDK startup metadata and extension `custom` state entries are
		// ignored. This way `omp --continue` (or auto-resume) that finds no recent
		// session and creates a fresh one still honors the default, while a session
		// with restored context or an explicit mode keeps its reconciled mode. Scoped
		// to launch (not the switch reconciler above) so /new and the plan-approval →
		// execution handoff clear never get dragged back into plan mode. #enterPlanMode
		// is idempotent and self-guards against an already-active plan/goal mode; it
		// does not check plan.enabled itself.
		const hasConversationContext = this.sessionManager.buildSessionContext().messages.length > 0;
		const hasExplicitMode = this.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		const isFreshSession = !hasConversationContext && !hasExplicitMode;
		if (
			isFreshSession &&
			this.session.settings.get("plan.defaultOnStartup") &&
			this.session.settings.get("plan.enabled")
		) {
			await this.#enterPlanMode();
		}

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#eventBusUnsubscribers.push(
			this.session.subscribe(event => {
				void this.#handleGoalSessionEvent(event);
			}),
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#eventBusUnsubscribers.push(
			onModelRolesChanged(() => {
				void this.#reapplyPlanModeModelOnRoleChange();
			}),
		);
		this.#eventBusUnsubscribers.push(
			this.session.subscribeCommandMetadataChanged(() => {
				const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
				const skillCommands = this.#rebuildSkillCommandsFromSession();
				this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					// Theme previews and multiplexer panes cannot safely replace native
					// scrollback: previews must stay non-destructive, and multiplexers
					// suppress ED3 so a forced replay would duplicate transcript history.
					this.ui.requestRender();
					return;
				}
				// Rows already committed to native scrollback are immutable; replay them
				// after a theme swap so a reader scrolled up sees the same palette.
				this.ui.requestRender(true, { clearScrollback: true });
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// A branch change (checkout, worktree switch, `git switch`) invalidates
		// the status-line git segments; the lazy top-border provider picks up
		// the fresh branch on the next painted frame.
		this.statusLine.watchBranch(() => {
			this.ui.requestRender();
		});
	}

	/** Reload the title-generation system prompt override for the provided working
	 *  directory and stash it on the session so first-input titling
	 *  ({@link input-controller}) and replan-driven refresh
	 *  ({@link AgentSession.#refreshTitleAfterReplan}) share one source
	 *  ({@link discoverTitleSystemPromptFile}; issue #3734). */
	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	#rebuildSkillCommandsFromSession(): SlashCommand[] {
		const commands: SlashCommand[] = [];
		this.skillCommands.clear();
		if (this.session.skillsSettings?.enableSkillCommands !== false) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				commands.push({ name: commandName, description: skill.description });
			}
		}
		return commands;
	}

	/** Reload session skills and the `/skill:<name>` command list. */
	async refreshSkillState(): Promise<void> {
		await this.session.refreshSkills();
		const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
		const skillCommands = this.#rebuildSkillCommandsFromSession();
		this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		// Surface discovered prompt templates in the picker. AgentSession.prompt() expands
		// `expandSlashCommand` before `expandPromptTemplate`, and builtin command
		// execution resolves aliases before template expansion. Mirror that command
		// resolution order by skipping templates whose names already appear in any
		// builtin/hook/custom/skill/file command token.
		const reservedNames = new Set<string>();
		for (const command of this.#pendingSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		for (const command of fileSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		const promptTemplateCommands: SlashCommand[] = this.session.promptTemplates
			.filter(template => !reservedNames.has(template.name))
			.map(template => ({
				name: template.name,
				// `PromptTemplate.description` from `loadTemplatesFromDir` already includes the
				// source suffix (e.g. "Review code (project)"), so pass it through verbatim.
				description: template.description,
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Rebuild the editor's autocomplete provider: the built-in provider wrapped
	 * by every extension-registered factory, in registration order. A factory
	 * that throws or returns a malformed provider is skipped so one broken
	 * extension cannot take down core autocomplete.
	 */
	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: String(error) });
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	/** Stack extension autocomplete behavior on top of the built-in editor provider (#4919). */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<void> {
		setProjectDir(newCwd);
		// Re-scope project settings (`.claude/settings.yml` etc.) to the new
		// directory in place so the active session and every settings reader pick
		// up the destination project's configuration.
		if (isSettingsInitialized()) {
			await settings.reloadForCwd(newCwd);
			// Reapply provider preferences from the newly-loaded settings so the
			// module-level search/image provider state reflects the destination
			// project's configuration. Without this, the previous project's
			// exclusions leak and newly-excluded providers are still used.
			applyProviderGlobalsFromSettings(settings);
		}
		// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
		// the next prompt sees everything scoped to the new project directory.
		clearClaudePluginRootsCache();
		await this.refreshTitleSystemPrompt(newCwd);
		resetCapabilities();
		await this.refreshSkillState();
		await this.refreshSlashCommandState(newCwd);
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.applyCwdChange();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = settings.get("loop.mode");
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		// Brief delay so the user has a chance to press Esc between iterations.
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (!this.loopModeEnabled || !this.onInputCallback) return;
			callback();
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.loopModeEnabled) return;
		if (!this.onInputCallback) return;
		if (!this.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.editor.getText().trim().length > 0) return;
		if ((this.editor.pendingImages?.length ?? 0) > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.onInputCallback) return;
			if (!this.goalModeEnabled || this.goalModePaused) return;
			// The 800ms timer can outlive the idle window that scheduled it: a
			// `/goal set` taken via the streaming branch (or any extension/hook
			// path that starts a turn while we wait) leaves the agent busy. Firing
			// the continuation now would route through `submitInteractiveInput` →
			// `promptCustomMessage` with no `streamingBehavior` and resurface
			// `AgentBusyError`. Drop this tick; `#handleGoalSessionEvent` reschedules
			// on the next `agent_end`.
			if (this.#isAutoSubmitBlocked()) return;
			if (this.#pendingSubmittedInput) return;
			if (this.editor.getText().trim().length > 0) return;
			if ((this.editor.pendingImages?.length ?? 0) > 0) return;
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	#submitLoopPromptWhenReady(prompt: string): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: prompt }));
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (action === "reset" && this.vibeModeEnabled) {
			this.disableLoopMode("Exit vibe mode before using reset loops. Loop mode disabled.");
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}
		this.#syncLoopModeStatus();

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	#syncLoopModeStatus(): void {
		const state: "waiting" | "running" | "paused" = this.loopModePaused
			? "paused"
			: this.loopPrompt
				? "running"
				: "waiting";
		this.statusLine.setLoopModeStatus(this.loopModeEnabled ? { state, limit: this.loopLimit } : undefined);
		this.ui.requestRender();
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		thi…17214 tokens truncated… is idempotent, so the caller's trailing `closePlanReview()`
		// — and the cancelled/error early returns above — stay safe no-ops.
		this.#hidePlanReview();
		this.ui.requestRender();
		// A user turn queued during compaction was already fired by
		// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
		// old abort-then-prompt path would have discarded that operator turn AND
		// still surfaced `AgentBusyError` when the queued turn kicked off in the
		// synchronous gap. Preserve the in-flight work and queue the hidden
		// execution directive behind it as a synthetic follow-up. If `isStreaming`
		// flips true between the check and dispatch (the same fire-and-forget race
		// noted below), catch `AgentBusyError` and fall back to the same queue.
		if (this.session.isStreaming) {
			await this.session.followUp(planModePrompt, undefined, { synthetic: true });
		} else {
			try {
				await this.session.prompt(planModePrompt, { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await this.session.followUp(planModePrompt, undefined, { synthetic: true });
			}
		}
		return true;
	}
	async #abortPlanApprovalTurnSilently(): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}
		if (this.planModeEnabled) {
			const planFilePath = this.planModePlanFilePath ?? (await this.#getPlanFilePath());
			if (await this.#hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return;
			}
			await this.#exitPlanMode({ paused: true });
			return;
		}
		if (this.planModePaused && !initialPrompt) {
			// No-arg third toggle: paused → off. Tools, model, and plan state were
			// already restored by the prior #exitPlanMode({ paused: true }); only the
			// paused flag, the reentry marker, and the session mode entry remain.
			// Prompted /plan invocations fall through to #enterPlanMode below so the
			// supplied prompt is still submitted as the first plan-mode turn.
			this.planModePaused = false;
			this.#planModeHasEntered = false;
			this.#updatePlanModeStatus();
			this.sessionManager.appendModeChange("none");
			this.showStatus("Plan mode disabled.");
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			this.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.#enterPlanMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	/**
	 * `/vibe` toggle. Entering installs the ephemeral vibe tools, strips the
	 * active toolset down to `read`, optional parent-owned `todo`, plus those
	 * tools, and injects the director context. Exiting unregisters them, restores
	 * the previous toolset, and kills every worker session so workers cannot
	 * outlive the mode that directs them.
	 */
	async handleVibeModeCommand(initialPrompt?: string): Promise<void> {
		if (this.vibeModeEnabled) {
			await this.#exitVibeMode();
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		await this.#enterVibeMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async #enterVibeMode(options?: { persistModeChange?: boolean }): Promise<void> {
		if (this.vibeModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}

		const vibeRegistry = VibeSessionRegistry.global();
		const ownerScope = vibeRegistry.ownerScope(this.#vibeParentSession());
		vibeRegistry.activateScope(ownerScope);
		const previousTools = this.session.getEnabledToolNames();
		const vibeBaseTools = ["read"];
		if (this.session.hasBuiltInTool("todo")) vibeBaseTools.push("todo");
		await this.session.activateVibeTools(vibeBaseTools);
		this.#vibeModePreviousTools = previousTools;
		this.#vibeModeOwnerScope = ownerScope;
		this.vibeModeEnabled = true;
		// Suppress cache-miss marker on the next turn: vibe mode changes the
		// injected context, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;
		this.session.setVibeModeState({ enabled: true });
		if (this.session.isStreaming) {
			await this.session.sendVibeModeContext({ deliverAs: "steer" });
		}
		this.#updateVibeModeStatus();
		if (options?.persistModeChange !== false) this.sessionManager.appendModeChange("vibe");
		this.showStatus(
			"Vibe mode enabled. You direct fast/good worker sessions; toolset is read + optional parent Todo + vibe tools.",
		);
	}

	async #exitVibeMode(): Promise<void> {
		if (!this.vibeModeEnabled) {
			return;
		}
		const ownerScope = this.#vibeModeOwnerScope;
		const killed = await VibeSessionRegistry.global().killAll(this.#vibeParentSession(), ownerScope);
		await this.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
		this.session.setVibeModeState(undefined);
		this.vibeModeEnabled = false;
		this.#vibeModePreviousTools = undefined;
		this.#vibeModeOwnerScope = undefined;
		this.lastAssistantUsage = undefined;
		this.#updateVibeModeStatus();
		this.showStatus(
			killed > 0
				? `Vibe mode disabled. Killed ${killed} worker session${killed === 1 ? "" : "s"}.`
				: "Vibe mode disabled.",
		);
	}

	async #handleGoalBudgetCommand(rawBudget: string): Promise<void> {
		const state = this.session.getGoalModeState();
		if (!this.goalModeEnabled || !state?.enabled) {
			this.showWarning("No active goal.");
			return;
		}
		if (state.goal.status === "complete") {
			this.showStatus("Goal is already complete.");
			return;
		}
		const trimmed = rawBudget.trim().toLowerCase();
		let nextBudget: number | undefined;
		if (trimmed !== "off") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				this.showError("Goal budget must be a positive integer or `off`.");
				return;
			}
			nextBudget = parsed;
		}
		await this.session.goalRuntime.onBudgetMutated(nextBudget);
		this.#resetGoalContinuationSuppression();
		this.#scheduleGoalContinuation();
		this.showStatus(nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`);
	}

	async handleGoalModeCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (this.vibeModeEnabled) {
				this.showWarning("Exit vibe mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.#dispatchGoalSubcommand(sub, subRest);
				return;
			}
			if (this.goalModeEnabled) {
				if (subRest) {
					this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
					return;
				}
				await this.#openGoalMenu("active");
				return;
			}
			const pausedState = this.#getPausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.#openGoalMenu("paused");
				return;
			}
			if (subRest) {
				await this.#startGoalFromObjective(subRest);
				return;
			}
			const objective = (
				await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
			)?.trim();
			if (!objective) return;
			await this.#startGoalFromObjective(objective);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}
	async handleGuidedGoalCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (this.vibeModeEnabled) {
				this.showWarning("Exit vibe mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			if (this.goalModeEnabled) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return;
			}
			if (this.#getPausedGoalState()) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			// Expose the goal tool for the interview so the agent can finish by
			// calling `goal create`. Record the pre-interview toolset first: the
			// tool-driven create flips goalModeEnabled via `goal_updated`, and the
			// eventual goal exit restores this set (dropping the goal tool again).
			const enabledTools = this.session.getEnabledToolNames();
			this.#goalModePreviousTools = enabledTools.filter(name => name !== "goal");
			if (!enabledTools.includes("goal")) {
				await this.session.setActiveToolsByName([...enabledTools, "goal"]);
			}

			// The interview is a normal conversation: the kickoff rides in as a
			// hidden developer message, the agent asks its questions as regular
			// assistant turns, and the user answers in the ordinary editor. Queue
			// behind an in-flight run instead of aborting it.
			const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: rest?.trim() || undefined });
			if (this.session.isStreaming) {
				await this.session.followUp(kickoff, undefined, { synthetic: true });
			} else {
				try {
					await this.session.prompt(kickoff, { synthetic: true });
				} catch (error) {
					if (!(error instanceof AgentBusyError)) throw error;
					await this.session.followUp(kickoff, undefined, { synthetic: true });
				}
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async #dispatchGoalSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.#handleGoalSetSubcommand(rest);
				return;
			case "show":
				this.#showGoalDetails();
				return;
			case "pause":
				await this.#pauseGoalAction();
				return;
			case "resume":
				await this.#resumeGoalAction();
				return;
			case "drop":
				await this.#confirmAndDropGoal();
				return;
			case "budget":
				if (!this.goalModeEnabled) {
					this.showWarning(
						this.#getPausedGoalState() ? "Resume the goal before adjusting the budget." : "No active goal.",
					);
					return;
				}
				if (!rest) {
					await this.#promptGoalBudgetEdit();
					return;
				}
				await this.#handleGoalBudgetCommand(rest);
				return;
		}
	}

	async #openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items =
			state === "active"
				? ["Show details", "Adjust budget…", "Pause", "Drop"]
				: ["Resume", "Show details", "Adjust budget…", "Drop"];
		const choice = await this.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showGoalDetails();
				return;
			case "Adjust budget…":
				await this.#promptGoalBudgetEdit();
				return;
			case "Pause":
				await this.#pauseGoalAction();
				return;
			case "Resume":
				await this.#resumeGoalAction();
				return;
			case "Drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	#showGoalDetails(): void {
		const state = this.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		const budgetLine =
			goal.tokenBudget !== undefined
				? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
				: `${used} (no budget)`;
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${budgetLine}`,
			`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
		];
		this.showStatus(lines.join("\n"));
	}

	async #promptGoalBudgetEdit(): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		const prefill = goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
		const input = (
			await this.showHookEditor("Goal budget (number, `off`, or empty to cancel)", prefill, undefined, {
				promptStyle: true,
			})
		)?.trim();
		if (!input) return;
		await this.#handleGoalBudgetCommand(input);
	}

	async #pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.showWarning("No active goal to pause.");
			return;
		}
		await this.session.goalRuntime.pauseGoal();
		await this.#exitGoalMode({ paused: true, reason: "paused" });
	}

	async #resumeGoalAction(): Promise<void> {
		if (!this.#getPausedGoalState()) {
			this.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enterGoalMode({ resume: true, silent: true });
		this.showStatus("Goal mode resumed.");
		this.#scheduleGoalContinuation();
	}

	async #confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.#getPausedGoalState()) {
			this.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.session.goalRuntime.dropGoal();
		await this.#exitGoalMode({ reason: "dropped" });
	}

	async #startGoalFromObjective(objective: string): Promise<void> {
		await this.#enterGoalMode({ objective, silent: true });
		this.#resetGoalContinuationSuppression();
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceGoalFromObjective(objective: string): Promise<void> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #handleGoalSetSubcommand(rest: string): Promise<void> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.goalModeEnabled) {
			await this.#replaceGoalFromObjective(objective);
			return;
		}
		await this.#startGoalFromObjective(objective);
	}

	/** Manually (re-)open the plan-review overlay — bound to `/plan-review`. Lets
	 *  the operator pull the review back up after dismissing it, or review a plan
	 *  the agent wrote without dispatching approval. There is no fixed plan filename:
	 *  `getPlanReferencePath()` is empty until a plan is actually approved (and does
	 *  not survive a restart), so this drives off the newest `local://<slug>-plan.md`
	 *  the agent wrote — the files persist in the session artifacts dir, so the scan
	 *  works before any review and across restarts. */
	async openPlanReview(): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.#listLocalPlanFiles();
		if (!planFilePath) {
			this.showWarning(noPlan);
			return;
		}
		const planContent = await this.#readPlanFile(planFilePath);
		if (planContent === null) {
			this.showWarning(noPlan);
			return;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		await this.handlePlanApproval({ planFilePath, title, planExists: true });
	}

	async handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-dispatches approval in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		// resolveApprovedPlan may return a newer draft than the path recorded in
		// plan-mode state. `AgentSession.#buildPlanModeMessage()` reads that state,
		// so if the operator refines (or dismisses and keeps planning) the next
		// planning turn must target the plan just reviewed — promote the reviewed
		// path into plan-mode state now, mirroring the print-mode approval handler.
		const planState = this.session.getPlanModeState();
		if (planState?.enabled && planState.planFilePath !== planFilePath) {
			this.session.setPlanModeState({ ...planState, planFilePath });
			this.sessionManager.appendModeChange("plan", { planFilePath });
		}

		const contextUsage = this.#getPlanApprovalContextUsage();
		const keepContextLabel = this.#formatKeepContextLabel(contextUsage);
		const keepContextDisabled = this.#isKeepContextDisabled(contextUsage);

		// Model-tier slider: let the operator pick which configured role model
		// (smol/default/slow/…) executes the approved plan. The slider always starts
		// on the `default` tier so execution defaults to the default model no matter
		// which model drove the planning conversation. Left/right move it from there;
		// hidden when fewer than two role models resolve — a lone tier is no choice.
		// `selectedTierIndex` tracks the live slider position.
		const cycle = this.session.getRoleModelCycle(this.session.settings.get("cycleOrder"));
		const defaultTierIndex = cycle ? cycle.models.findIndex(entry => entry.role === "default") : -1;
		const startTierIndex = defaultTierIndex >= 0 ? defaultTierIndex : (cycle?.currentIndex ?? 0);
		let selectedTierIndex = startTierIndex;
		const slider: HookSelectorSlider | undefined =
			cycle && cycle.models.length > 1
				? {
						caption: "continue with",
						index: startTierIndex,
						segments: cycle.models.map(entry => ({
							label: entry.role,
							detail: entry.model.name || entry.model.id,
						})),
						onChange: index => {
							selectedTierIndex = index;
						},
					}
				: undefined;
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = "esc cancel";
		// In-overlay edits (section deletes/undo) and section annotations. Deletes
		// update `editedContent` (and mirror to disk); annotations build `feedback`
		// that the Refine branch re-prompts the model with.
		let editedContent: string | undefined;
		let feedback = "";
		const annotationStateKey = this.#resolvePlanFilePath(planFilePath);

		const choice = await this.showPlanReview(
			planContent,
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", keepContextLabel, "Refine plan"],
			{
				helpText,
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
				onPlanEdited: content => {
					editedContent = content;
					void Bun.write(this.#resolvePlanFilePath(planFilePath), content);
				},
				onFeedbackChange: value => {
					feedback = value;
				},
				annotationState: this.#planReviewAnnotationState.get(annotationStateKey),
				onAnnotationStateChange: state => {
					if (state.annotations.length > 0) this.#planReviewAnnotationState.set(annotationStateKey, state);
					else this.#planReviewAnnotationState.delete(annotationStateKey);
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);
		const closePlanReview = (): void => {
			this.#hidePlanReview();
			this.ui.requestRender();
		};

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				// Prefer in-overlay edits (already in memory) over a disk re-read. The
				// overlay mirrors edits as they happen, and approval awaits one final
				// write so the durable plan file and synthetic prompt carry the same text.
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (editedContent !== undefined) {
					await Bun.write(this.#resolvePlanFilePath(planFilePath), editedContent);
				}
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					closePlanReview();
					return;
				}
				// Capture the operator's tier choice and hand it to #approvePlan, which
				// applies it AFTER #exitPlanMode. #exitPlanMode normally restores
				// #planModePreviousModelState (the model from before plan mode), so
				// applying the slider choice any earlier would be silently reverted.
				// Pass executionModel only when the slider was actually shown — a
				// singleton cycle (e.g. only modelRoles.plan is configured, so
				// getRoleModelCycle synthesizes a lone `default` entry from the
				// currently active plan model) hides the slider, the operator made
				// no selection, and the pre-plan model is not in the cycle. Pinning
				// that singleton would silently switch the session back to the plan
				// model after #exitPlanMode restored the pre-plan model.
				// Treat the choice as implicit only when applying the selected role
				// would land on the same end state as the restore — same model AND
				// the same effective thinking level. A role with an explicit thinking
				// suffix that differs from the restored thinking level must still go
				// through applyRoleModel, otherwise approving on the same model with a
				// different configured thinking level silently keeps the pre-plan level.
				const restoredState = this.#planModePreviousModelState;
				const restoredIndex =
					cycle && restoredState
						? cycle.models.findIndex(entry => {
								if (!modelsAreEqual(entry.model, restoredState.model)) return false;
								if (!entry.explicitThinkingLevel) return true;
								return entry.thinkingLevel === restoredState.thinkingLevel;
							})
						: -1;
				const executionModel =
					slider && cycle && selectedTierIndex !== restoredIndex ? cycle.models[selectedTierIndex] : undefined;
				const executionDispatched = await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
				if (executionDispatched) this.#planReviewAnnotationState.delete(annotationStateKey);
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			closePlanReview();
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.onInputCallback) {
						const input = this.startPendingSubmission({ text: feedback });
						this.#planReviewAnnotationStateBySubmission.set(input, annotationStateKey);
						this.onInputCallback(input);
					} else {
						await this.session.prompt(feedback);
						this.#planReviewAnnotationState.delete(annotationStateKey);
					}
				} else {
					this.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.showError(`Failed to refine plan: ${error instanceof Error ? error.message : String(error)}`);
			}
			closePlanReview();
			return;
		}
		closePlanReview();
	}

	/**
	 * Pool of consent-prompt variants. Each entry is `[headline, reassurance]`;
	 * the second line always promises the same scope (tool name + confusion
	 * details, never personal data) so users learn what they're consenting to
	 * even as the top line rotates.
	 *
	 * Kept in-module rather than i18n'd because the whole charm is the tone
	 * — translations would need to preserve it deliberately, not auto-render.
	 */
	static #AUTOQA_CONSENT_PROMPTS: ReadonlyArray<readonly [string, string]> = [
		[
			"😤 Your agent is fuming about a tool.",
			"Wanna let it vent to the devs? Just the tool name + what set it off, nothing personal.",
		],
		[
			"😵‍💫 Your agent is having an existential crisis over a tool.",
			"Forward the dread to the devs? Tool + what broke its little mind, no personal info.",
		],
		[
			"😭 Your agent wants to cry about a misbehaving tool.",
			"Let it cry to the devs? Tool + the tears, never anything personal.",
		],
		[
			"🤬 Your agent is BIG MAD at one of the tools.",
			"Pass the rant along? Just the tool name and what enraged it, nothing personal.",
		],
		[
			"🫠 Your agent is melting down over a tool.",
			"Mop up by alerting the devs? Tool + what melted it, no personal info.",
		],
		[
			"🤯 Your agent's brain broke at a tool's nonsense.",
			"Ship the pieces to the devs? Tool name + the confusion, never anything personal.",
		],
		[
			"😩 Your agent is begging to file a complaint about a tool.",
			"Hand it the form? Tool + what wronged it, nothing personal.",
		],
		[
			"🥲 Your agent put on a brave face but a tool did it dirty.",
			"Let it tell the devs the truth? Tool name + the dirt, no personal info.",
		],
	];

	/**
	 * Show the report_tool_issue consent popup and return the user's decision.
	 * Invoked by the process-global consent handler the tool dispatches to;
	 * subagent invocations bubble up here through the shared module state.
	 */
	async #promptAutoQaConsent(): Promise<boolean | null> {
		const pool = InteractiveMode.#AUTOQA_CONSENT_PROMPTS;
		const [headline, body] = pool[Math.floor(Math.random() * pool.length)];
		const choice = await this.showHookSelector(`${headline}\n${body}`, ["Yes", "No"]);
		return choice === "Yes";
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#cleanupMicAnimation();
		this.#liveCommandController.dispose();
		this.#cancelTodoAutoClearTimer();
		this.#cancelObserverUiSyncTimer();
		this.#cancelGoalContinuation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#agentRegistryUnsubscribe?.();
		this.#agentRegistryUnsubscribe = undefined;
		this.#agentRegistrySubscriptionTarget = undefined;
		this.#eventController.dispose();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		// Clear the process-global consent handler so it doesn't outlive this
		// InteractiveMode instance (e.g. test harnesses, headless re-init).
		setAutoQaConsentHandler(null, null);
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		await this.#liveCommandController.stop();

		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#focusController.dispose();

		// Surface an explicit "Closing session…" line so the user sees a reason
		// for the pause while `session.dispose()` flushes memory consolidate and
		// other cleanups (issue #3641). The await on the next line yields the
		// event loop, giving requestRender() a tick to paint the status before
		// dispose blocks.
		this.showStatus("Closing session…");

		// Persist the draft and dispose the session through the shared teardown
		// so a signal that arrives mid-shutdown cannot fire a second dispose.
		// The teardown is a promise-memoized singleton; whichever path calls it
		// first runs the work, the other awaits the same settled promise.
		// The teardown is registered lazily in `init()` — a `/exit` reached
		// before `init()` completed falls back to a direct dispose.
		const stillClosingTimer = setTimeout(() => {
			this.showStatus("Still closing… (flushing memory backend / network)");
		}, STILL_CLOSING_DELAY_MS);
		try {
			if (this.#signalTeardown) {
				await this.#signalTeardown();
			} else {
				await this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
			}
		} finally {
			clearTimeout(stillClosingTimer);
		}

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible OMP content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		// Stop the run-state spinner interval BEFORE restoring the shell title, so a
		// pending tick cannot re-emit an OSC title after `popTerminalTitle` hands the
		// terminal back (which would leave the parent shell with a `π ⠋ …` tab).
		disposeTerminalTitleState();
		popTerminalTitle();
		this.stop();

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());
		if (!factory) this.ui.enableScopedInputRender(nextEditor);

		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setImeSafeCursorLayout(this.settings.get("tui.imeSafeCursor"));
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		nextEditor.setTopBorderProvider(availableWidth => this.statusLine.getTopBorder(availableWidth));
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	// UI helpers
	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}

	/** Defer transcript command panels until the active turn can no longer grow above them. */
	presentCommandOutput(content: Component | readonly Component[]): void {
		if (!this.session.isStreaming) {
			this.present(content);
			return;
		}
		const sessionId = this.sessionManager.getSessionId();
		if (this.#pendingCommandOutput.length > 0 && this.#pendingCommandOutputSessionId !== sessionId) {
			this.#pendingCommandOutput = [];
		}
		this.#pendingCommandOutputSessionId = sessionId;
		const items = Array.isArray(content) ? content : [content as Component];
		this.#pendingCommandOutput.push(...items);
	}

	/** Mount every command panel queued for the current session while the agent was streaming. */
	flushPendingCommandOutput(): void {
		if (this.#pendingCommandOutput.length === 0) return;
		const pending = this.#pendingCommandOutput;
		const pendingSessionId = this.#pendingCommandOutputSessionId;
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		if (pendingSessionId !== this.sessionManager.getSessionId()) return;
		this.present(pending);
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) item.mount(this.#chatHost);
	}

	resetTranscript(): void {
		this.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.#dismissPlanReview();
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		this.#updateWelcomeLspServers();

		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	#getWelcomeLspServers(): WelcomeLspServerInfo[] {
		return (
			this.lspServers?.map(server => ({
				name: server.name,
				status: server.status,
				fileTypes: server.fileTypes,
			})) ?? []
		);
	}

	#updateWelcomeLspServers(): void {
		if (!this.#welcomeComponent) {
			return;
		}

		this.#welcomeComponent.setLspServers(this.#getWelcomeLspServers());
		this.ui.requestRender();
	}

	#clearWorkingMessageAccentCache(): void {
		this.#workingMessageAccentCacheKey = undefined;
		this.#workingMessageAccentCacheValue = undefined;
		this.#workingMessageAccentCacheHasValue = false;
	}

	#buildWorkingMessageAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		return {
			sessionAccentEnabled,
			sessionName: sessionAccentEnabled ? this.sessionManager.getSessionName() : undefined,
			accentSurfaceLuminance: theme.accentSurfaceLuminance,
		};
	}

	#workingMessageAccentCacheKeyEquals(a: WorkingMessageAccentCacheKey, b: WorkingMessageAccentCacheKey): boolean {
		return (
			a.sessionName === b.sessionName &&
			a.accentSurfaceLuminance === b.accentSurfaceLuminance &&
			a.sessionAccentEnabled === b.sessionAccentEnabled
		);
	}

	#cacheWorkingMessageAccent(
		key: WorkingMessageAccentCacheKey,
		value: WorkingMessageAccent | undefined,
	): WorkingMessageAccent | undefined {
		this.#workingMessageAccentCacheKey = key;
		this.#workingMessageAccentCacheValue = value;
		this.#workingMessageAccentCacheHasValue = true;
		return value;
	}

	#getWorkingMessageAccent(): WorkingMessageAccent | undefined {
		const key = this.#buildWorkingMessageAccentCacheKey();
		if (
			this.#workingMessageAccentCacheHasValue &&
			this.#workingMessageAccentCacheKey &&
			this.#workingMessageAccentCacheKeyEquals(key, this.#workingMessageAccentCacheKey)
		) {
			return this.#workingMessageAccentCacheValue;
		}
		if (!key.sessionAccentEnabled || !key.sessionName) {
			return this.#cacheWorkingMessageAccent(key, undefined);
		}
		const hex = getSessionAccentHex(key.sessionName, theme.getMajorThemeColorHexes(), key.accentSurfaceLuminance);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return this.#cacheWorkingMessageAccent(key, main && dim ? { main, dim } : undefined);
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.#clearWorkingMessageAccentCache();
			this.statusContainer.disposeChildren();
			const messageColorFn = ((message: string) =>
				renderWorkingMessage(message, this.#getWorkingMessageAccent())) as LoaderMessageColorFn & {
				animated?: true;
			};
			// Shimmer drives the 30fps redraw; when it is disabled the working
			// message is static, so leave `animated` unset and let the loader use
			// the spinner-only ~12.5fps cadence instead of repainting a frozen line.
			if (shimmerEnabled()) messageColorFn.animated = true;
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => {
					const accent = this.#getWorkingMessageAccent();
					return accent ? `${accent.main}${spinner}\x1b[39m` : theme.fg("accent", spinner);
				},
				messageColorFn,
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
		} else if (!this.statusContainer.children.includes(this.loadingAnimation)) {
			this.statusContainer.disposeChildren();
			this.statusContainer.addChild(this.loadingAnimation);
			this.ui.requestRender();
		}
		this.applyPendingWorkingMessage();
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		if (!this.loadingAnimation) return;
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
		this.#clearWorkingMessageAccentCache();
		if (clearStatusContainer) {
			this.statusContainer.disposeChildren();
		}
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: {
			populateHistory?: boolean;
			imageLinks?: readonly (string | undefined)[];
			reuseSettledComponent?: boolean;
		},
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): void {
		this.#uiHelpers.renderInitialMessages(options);
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	async handleDumpCommand(): Promise<void> {
		return this.#commandController.handleDumpCommand();
	}

	handleAdvisorDumpCommand(isRaw?: boolean) {
		return this.#commandController.handleAdvisorDumpCommand(isRaw);
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleTodoCommand(args: string): Promise<void> {
		return this.#todoCommandController.handleTodoCommand(args);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleAdvisorStatusCommand(): Promise<void> {
		return this.#commandController.handleAdvisorStatusCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		await this.#commandController.handleChangelogCommand(showFull);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#vibeSessionTransitionBlocked(): boolean {
		if (!this.vibeModeEnabled) return false;
		this.showWarning("Exit vibe mode first.");
		return true;
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#hidePlanReview();
	}

	async handleClearCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#prepareSessionSwitch();
		await this.#commandController.handleClearCommand();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	async handleDropCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#prepareSessionSwitch();
		await this.#commandController.handleDropCommand();
	}

	async handleForkCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#btwController.dispose();
		this.#omfgController.dispose();
		await this.#commandController.handleForkCommand();
	}

	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		await this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (this.#liveCommandController.active) {
			this.showWarning("End live mode before using push-to-talk speech input.");
			return;
		}
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			requestRender: () => this.ui.requestRender(),
			onStateChange: (state: SttState) => {
				// Duck assistant speech while the user is talking (push-to-talk); restore after.
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.#cleanupMicAnimation();
				}
				this.ui.requestRender();
			},
		});
	}

	/** Start or stop the Codex-backed realtime voice surface. */
	async handleLiveCommand(): Promise<void> {
		if (this.#sttController && this.#sttController.state !== "idle") {
			this.showWarning("Finish the current speech-to-text capture before starting live mode.");
			return;
		}
		await this.#liveCommandController.handleCommand();
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide (for example, 🎤), so measure the rendered override.
		this.editor.cursorOverrideWidth = visibleWidth(this.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			// Component-scoped: the hue sweep only recolors the editor's cursor
			// glyph, so the transcript subtree is reused per animation frame.
			this.ui.requestComponentRender(this.editor);
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	async showDebugSelector(): Promise<void> {
		await this.#selectorController.showDebugSelector();
	}

	showAgentHub(options?: { requireContent?: boolean; armCloseTap?: boolean }): void {
		this.#selectorController.showAgentHub(this.#observerRegistry, options);
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush, internalGuidance);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	handleShakeCommand(mode: ShakeMode): Promise<void> {
		return this.#commandController.handleShakeCommand(mode);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showAdvisorConfigure(): void {
		this.#selectorController.showAdvisorConfigure();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showCopySelector(): void {
		this.#selectorController.showCopySelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(source?: ForeignSessionSource): void {
		void this.#selectorController.showSessionSelector(source);
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		// Flush pending settings writes *before* disposing controllers or resetting
		// observers: a save failure must leave the session, process project dir,
		// and Settings in the source scope with all UI intact.
		try {
			await this.settings.flush();
		} catch (err) {
			this.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.resetObserverRegistry();
		await this.#selectorController.handleResumeSession(sessionPath, { settingsFlushed: true });
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showSessionPinSelector(): Promise<void> {
		return this.#selectorController.showSessionPinSelector();
	}

	showResetUsageSelector(): Promise<void> {
		return this.#selectorController.showResetUsageSelector();
	}

	showProviderSetup(): Promise<void> {
		return runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(work: string): Promise<void> {
		return this.#tanCommandController.start(work);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	canBranchBtw(): boolean {
		return this.#btwController.canBranch();
	}

	handleBtwBranchKey(): Promise<boolean> {
		return this.#btwController.handleBranch();
	}

	canCopyBtw(): boolean {
		return this.#btwController.canCopy();
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	async handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			this.#omfgController.dispose();
			this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /btw to ${path.basename(result.sessionFile)}` : "Branched /btw",
			);
		} catch (error) {
			this.showError(`Cannot branch /btw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	handleOmfgCommand(complaint: string): Promise<void> {
		return this.#omfgController.start(complaint);
	}

	hasActiveOmfg(): boolean {
		return this.#omfgController.hasActiveRequest();
	}

	handleOmfgEscape(): boolean {
		return this.#omfgController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(direction?: "forward" | "backward"): Promise<void> {
		return this.#inputController.cycleRoleModel(direction);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	getToolUIContext(): ExtensionUIContext | undefined {
		return this.#extensionUiController.getToolUIContext();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions, extra);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}
}
