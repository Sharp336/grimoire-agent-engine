/**
 * Session terminal title run-state (OSC 0) — glanceable tab titles for multi-session use.
 */
import type { Settings } from "../config/settings";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { formatSessionTerminalTitle, setTerminalTitle, type TitleRunState } from "./title-generator";

export type { TitleRunState };

export type SessionTerminalTitleSignals = {
	/** Extension/hook modal (ask, approval, selector) is open. */
	dialogActive?: boolean;
	/** Fullscreen plan-review overlay is open. */
	planReviewActive?: boolean;
};

let boundCtx: InteractiveModeContext | undefined;
let extensionTitleOverride: string | undefined;
let explicitRunState: TitleRunState | undefined;
let signals: SessionTerminalTitleSignals = {};
let afterTurnWaiting = false;

export function bindSessionTerminalTitleContext(ctx: InteractiveModeContext | undefined): void {
	boundCtx = ctx;
	if (!ctx) {
		extensionTitleOverride = undefined;
		explicitRunState = undefined;
		signals = {};
		afterTurnWaiting = false;
	}
}

export function setSessionTerminalTitleSignals(partial: SessionTerminalTitleSignals): void {
	signals = { ...signals, ...partial };
	refreshSessionTerminalTitle();
}

export function setExtensionTerminalTitleOverride(title: string | undefined): void {
	extensionTitleOverride = title?.trim() ? title : undefined;
	if (extensionTitleOverride) {
		setTerminalTitle(extensionTitleOverride);
		return;
	}
	refreshSessionTerminalTitle();
}

export function markSessionTerminalTitleTurnStarted(): void {
	afterTurnWaiting = false;
	explicitRunState = undefined;
	refreshSessionTerminalTitle();
}

export function markSessionTerminalTitleTurnEnded(): void {
	afterTurnWaiting = true;
	explicitRunState = undefined;
	refreshSessionTerminalTitle();
}

export function resolveSessionTerminalRunState(ctx: InteractiveModeContext): TitleRunState {
	if (signals.planReviewActive || signals.dialogActive) {
		return "needs_attention";
	}
	const session = ctx.viewSession ?? ctx.session;
	if (
		session.isStreaming ||
		session.isCompacting ||
		session.isRetrying ||
		(session as { isGeneratingHandoff?: boolean }).isGeneratingHandoff ||
		ctx.loadingAnimation ||
		ctx.autoCompactionLoader ||
		ctx.retryLoader
	) {
		return "running";
	}
	if (afterTurnWaiting) {
		return "waiting_for_input";
	}
	return "idle";
}

function runStateGlyph(state: TitleRunState, _settings: Settings | undefined): string {
	const titleSymbols = theme.title;
	switch (state) {
		case "running":
			return titleSymbols.running || titleSymbols.working || "";
		case "waiting_for_input":
			return titleSymbols.waiting || "";
		case "needs_attention":
			return titleSymbols.needsAttention || "";
		case "idle":
			return titleSymbols.idle || titleSymbols.none || "";
		default:
			return "";
	}
}

export function refreshSessionTerminalTitle(): void {
	const ctx = boundCtx;
	if (!ctx) return;

	if (extensionTitleOverride) {
		setTerminalTitle(extensionTitleOverride);
		return;
	}

	const sessionName = ctx.sessionManager.getSessionName();
	const cwd = ctx.sessionManager.getCwd();
	const showRunState = ctx.settings?.get("terminal.showRunStateInTitle") === true;
	const runState = explicitRunState ?? resolveSessionTerminalRunState(ctx);
	const glyph = showRunState ? runStateGlyph(runState, ctx.settings) : undefined;

	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd, { runStateGlyph: glyph }));
}

export function setSessionTerminalTitleFromSession(
	sessionName: string | undefined,
	cwd?: string,
	settings?: Settings,
): void {
	if (extensionTitleOverride) {
		setTerminalTitle(extensionTitleOverride);
		return;
	}
	const showRunState = settings?.get("terminal.showRunStateInTitle") === true;
	const ctx = boundCtx;
	const runState = ctx ? (explicitRunState ?? resolveSessionTerminalRunState(ctx)) : "idle";
	const glyph = showRunState ? runStateGlyph(runState, settings) : undefined;
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd, { runStateGlyph: glyph }));
}