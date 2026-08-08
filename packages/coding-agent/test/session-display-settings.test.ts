import { describe, expect, it } from "bun:test";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("session display settings", () => {
	it("defaults new session context controls to enabled", () => {
		expect(getDefault("display.showTimestamps")).toBe(true);
		expect(getDefault("display.showRecentUserMessages")).toBe(true);
		expect(getDefault("display.showGoalHistory")).toBe(true);
	});
});
