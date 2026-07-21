import { isInsideLimux, setPreserveScrollback } from "@oh-my-pi/pi-tui";
import type { SettingValue } from "../config/settings-schema";

/**
 * Apply the `terminal.preserveScrollback` setting to the TUI's destructive
 * scrollback-clear gate:
 * - `"never"`: destructive scrollback erases (ED3, `CSI 3 J`) stay enabled.
 * - `"always"`: full repaints never erase native scrollback — they degrade to
 *   the non-destructive repaint path.
 * - `"auto"`: preserve only inside limux, whose ghostty-core viewport snaps to
 *   bottom and collapses the host scrollbar when ED3 erases history.
 */
export function applyPreserveScrollbackSetting(mode: SettingValue<"terminal.preserveScrollback">): void {
	setPreserveScrollback(mode === "always" || (mode === "auto" && isInsideLimux()));
}
