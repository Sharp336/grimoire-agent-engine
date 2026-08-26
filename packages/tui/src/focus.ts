/**
 * Terminal focus tracking (DECSET/DECRST 1004, CSI ?1004).
 *
 * With the mode enabled the terminal emits `ESC[I` on focus-in and `ESC[O` on
 * focus-out (Windows Terminal reports tab activation/deactivation). This is
 * the basis for bell semantics: a needing-user tint shows only while the tab
 * is inactive and clears on activation.
 */
export const FOCUS_TRACKING_ON = "\x1b[?1004h";
export const FOCUS_TRACKING_OFF = "\x1b[?1004l";

/**
 * Decode a CSI ?1004 focus report. Exact-prefix match: `ESC[I` → focused,
 * `ESC[O` → unfocused. Returns the unconsumed remainder of `data` so trailing
 * bytes can flow on to normal key handling; null when `data` does not start
 * with a focus report.
 */
export function parseFocusEvent(data: string): { focused: boolean; rest: string } | null {
	if (data.startsWith("\x1b[I")) return { focused: true, rest: data.slice(3) };
	if (data.startsWith("\x1b[O")) return { focused: false, rest: data.slice(3) };
	return null;
}
