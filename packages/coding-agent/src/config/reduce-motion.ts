import { isSettingsInitialized, settings } from "./settings";

export type ReduceMotionLevel = "off" | "on" | "strict";

/** Strict mode's TUI minimum render interval (~4fps). */
export const REDUCE_MOTION_STRICT_RENDER_INTERVAL_MS = 250;

/** Current reduce-motion level; "off" before settings init (early boot, tests). */
export function reduceMotionLevel(): ReduceMotionLevel {
	if (!isSettingsInitialized()) return "off";
	return settings.get("display.reduceMotion");
}

export function isReduceMotion(): boolean {
	return reduceMotionLevel() !== "off";
}
