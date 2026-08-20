import { truncateToWidth, visibleWidth } from "./utils";

export interface RightSidebarOptions {
	width: number;
	minWidth: number;
	minMainWidth: number;
}

export interface ResolvedRightSidebarLayout {
	terminalWidth: number;
	mainWidth: number;
	sidebarWidth: number;
	sidebarContentWidth: number;
	visible: boolean;
}

/** Close main-row SGR and OSC 8 state before entering reserved columns. */
export const RIGHT_SIDEBAR_BOUNDARY_RESET = "\x1b[0m\x1b]8;;\x07";

function finiteInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function resolveRightSidebarLayout(
	terminalWidth: number,
	options: RightSidebarOptions,
): ResolvedRightSidebarLayout {
	const width = Math.max(1, finiteInteger(terminalWidth, 1));
	const preferred = Math.max(2, finiteInteger(options.width, 2));
	const minimum = Math.max(2, Math.min(preferred, finiteInteger(options.minWidth, preferred)));
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth, 1));

	if (width < minimumMain + minimum) {
		return {
			terminalWidth: width,
			mainWidth: width,
			sidebarWidth: 0,
			sidebarContentWidth: 0,
			visible: false,
		};
	}

	const sidebarWidth = Math.min(preferred, width - minimumMain);
	return {
		terminalWidth: width,
		mainWidth: width - sidebarWidth,
		sidebarWidth,
		sidebarContentWidth: sidebarWidth - 1,
		visible: true,
	};
}

export function composeRightSidebar(
	window: readonly string[],
	sidebarLines: readonly string[],
	layout: ResolvedRightSidebarLayout,
	separator = "│",
): readonly string[] {
	if (!layout.visible) return window;
	if (visibleWidth(separator) !== 1) throw new Error("Right sidebar separator must occupy one column");

	const output = new Array<string>(window.length);
	for (let row = 0; row < window.length; row++) {
		const main = truncateToWidth(window[row] ?? "", layout.mainWidth);
		const mainPadding = " ".repeat(Math.max(0, layout.mainWidth - visibleWidth(main)));
		const sidebar = truncateToWidth(sidebarLines[row] ?? "", layout.sidebarContentWidth);
		output[row] = `${main}${RIGHT_SIDEBAR_BOUNDARY_RESET}${mainPadding}${separator}${sidebar}`;
	}
	return output;
}
