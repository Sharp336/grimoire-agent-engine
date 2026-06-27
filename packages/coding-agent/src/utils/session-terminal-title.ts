import type { Settings } from "../config/settings";
import { theme } from "../modes/theme/theme";
import type { SessionManager } from "../session/session-manager";
import {
	setSessionTerminalTitle,
	type TerminalTitleFormatOptions,
	type TerminalTitleState,
} from "./title-generator";

export type SessionTerminalTitleContext = {
	settings: Settings;
	sessionManager: SessionManager;
	isStreaming?: () => boolean;
	getTerminalTitleState?: () => TerminalTitleState;
};

let globalSessionTerminalTitleContext: SessionTerminalTitleContext | undefined;

/** Register the active interactive session for title refresh (cleared on shutdown). */
export function setSessionTerminalTitleContext(ctx: SessionTerminalTitleContext | undefined): void {
	globalSessionTerminalTitleContext = ctx;
}

export function getSessionTerminalTitleContext(): SessionTerminalTitleContext | undefined {
	return globalSessionTerminalTitleContext;
}

function resolveTerminalTitleState(ctx: SessionTerminalTitleContext): TerminalTitleState {
	if (ctx.getTerminalTitleState) return ctx.getTerminalTitleState();
	if (ctx.isStreaming?.()) return "running";
	return "idle";
}

export function buildSessionTerminalTitleFormatOptions(
	ctx: SessionTerminalTitleContext,
	stateOverride?: TerminalTitleState,
): TerminalTitleFormatOptions {
	const dynamicTitle = ctx.settings.get("terminal.dynamicTitle") === true;
	if (!dynamicTitle) return { dynamicTitle: false };
	const state = stateOverride ?? resolveTerminalTitleState(ctx);
	return {
		dynamicTitle: true,
		state,
		symbolPreset: theme.getSymbolPreset(),
		getSymbol: key => theme.symbol(key),
	};
}

/** Refresh OSC 0 session title from settings, theme preset, and run state. */
export function refreshSessionTerminalTitle(stateOverride?: TerminalTitleState): void {
	const ctx = globalSessionTerminalTitleContext;
	if (!ctx) return;
	const options = buildSessionTerminalTitleFormatOptions(ctx, stateOverride);
	setSessionTerminalTitle(ctx.sessionManager.getSessionName(), ctx.sessionManager.getCwd(), options);
}