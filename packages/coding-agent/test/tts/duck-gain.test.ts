import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveDuckGain } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("resolveDuckGain (#8282)", () => {
	it("defaults to the historical 0.25 when unset", () => {
		expect(resolveDuckGain()).toBe(0.25);
	});

	it("returns the configured value", () => {
		settings.set("speech.duckGain", 0);
		expect(resolveDuckGain()).toBe(0);
		settings.set("speech.duckGain", 0.5);
		expect(resolveDuckGain()).toBe(0.5);
		settings.set("speech.duckGain", 1);
		expect(resolveDuckGain()).toBe(1);
	});

	it("clamps out-of-range values to 0..1", () => {
		settings.set("speech.duckGain", -0.5);
		expect(resolveDuckGain()).toBe(0);
		settings.set("speech.duckGain", 2);
		expect(resolveDuckGain()).toBe(1);
	});

	it("falls back to 0.25 on a non-finite value", () => {
		settings.set("speech.duckGain", Number.NaN);
		expect(resolveDuckGain()).toBe(0.25);
	});
});
