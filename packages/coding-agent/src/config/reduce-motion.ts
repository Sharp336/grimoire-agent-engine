import { isSettingsInitialized, settings } from "./settings";

export type ReduceMotionLevel = "off" | "on" | "strict";

export function reduceMotionLevel(): ReduceMotionLevel {
	return isSettingsInitialized() ? settings.get("display.reduceMotion") : "off";
}

export function isReduceMotion(): boolean {
	return reduceMotionLevel() !== "off";
}
