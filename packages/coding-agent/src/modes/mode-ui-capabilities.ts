import type { Mode } from "../cli/args";

export interface ModeUiCapabilities {
	/** Native tools such as Ask may depend on an interactive presentation host. */
	toolPresentation: boolean;
	/** Extension UI factories and terminal events have a negotiated remote host. */
	remoteInteractiveSurface: boolean;
}

/**
 * Single startup policy for native tool and extension UI availability.
 *
 * TUI and rpc-ui reach the same native tool surface through independent hosts;
 * headless rpc intentionally has neither presentation host nor Ask tool.
 */
export function getModeUiCapabilities(mode: Mode, terminalInteractive: boolean): ModeUiCapabilities {
	const remoteInteractiveSurface = mode === "rpc-ui";
	return {
		toolPresentation: terminalInteractive || remoteInteractiveSurface,
		remoteInteractiveSurface,
	};
}
