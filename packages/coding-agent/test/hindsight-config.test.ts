import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

describe("loadHindsightConfig mental-model budget", () => {
	it("uses the configured mental-model generation budget", () => {
		const config = loadHindsightConfig(Settings.isolated({ "hindsight.mentalModelMaxTokens": 2048 }), {});
		expect(config.mentalModelMaxTokens).toBe(2048);
	});

	it("falls back to the safe default outside Hindsight's accepted range", () => {
		const config = loadHindsightConfig(Settings.isolated({ "hindsight.mentalModelMaxTokens": 8193 }), {});
		expect(config.mentalModelMaxTokens).toBe(4096);
	});
});
