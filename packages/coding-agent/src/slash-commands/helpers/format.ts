import { shimmerText } from "../../modes/theme/shimmer";
import { theme as currentTheme, type Theme } from "../../modes/theme/theme";

/** Format a millisecond duration as a coarse-grained human label. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

/**
 * Format a millisecond duration as a clock: `mm:ss` below one hour, `h:mm:ss` at
 * or above it. Live HUDs need second resolution; {@link formatDuration} is
 * deliberately coarse and stays that way.
 */
export function formatElapsedClock(ms: number): string {
	const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

type ProgressBarTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;

const unstyledProgressBarTheme: ProgressBarTheme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
	getFgAnsi() {
		return "";
	},
};

function resolveProgressBarTheme(uiTheme: ProgressBarTheme | undefined): ProgressBarTheme {
	return uiTheme ?? currentTheme ?? unstyledProgressBarTheme;
}

/**
 * Render an ASCII progress bar with a trailing percent label.
 * `fraction` is clamped to `[0, 1]`. `undefined` renders a dotted placeholder.
 */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	if (fraction === undefined) return `[${shimmerText("·".repeat(width), progressBarTheme)}]`;
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * width);
	const pct = Math.round(clamped * 100);
	const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
	return `[${shimmerText(bar, progressBarTheme)}] ${pct}%`;
}
