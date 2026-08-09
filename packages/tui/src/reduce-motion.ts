/**
 * Reduce-motion flag for `--reduced-resources` mode.
 *
 * When enabled, interactive components render a static status line instead of
 * driving spinner/shimmer/thinking timers, and the terminal title stops
 * rotating its working glyph. The flag is set once at startup from the CLI
 * option; animation components read it at start/render time, so no reload is
 * needed and the observable UI stays identical apart from the absent motion.
 *
 * This is deliberately a lightweight module-level switch (mirroring the
 * module-scoped runtime state used by the terminal-title spinner) rather than
 * threading an option through every component constructor. It only suppresses
 * visual animation; all harness power (tools, memory, LSP) is preserved.
 */
let reduceMotion = false;

/** Whether UI animations should be suppressed (--reduced-resources). */
export function isReduceMotion(): boolean {
	return reduceMotion;
}

/** Enable or disable reduce-motion. Called once at startup from the CLI flag. */
export function setReduceMotion(enabled: boolean): void {
	reduceMotion = enabled;
}
