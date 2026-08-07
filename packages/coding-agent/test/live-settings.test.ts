import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("live voice settings", () => {
	test("migrates the legacy shared voice into Codex without changing Grok", () => {
		const legacySettings: Record<string, unknown> = { "live.voice": "vale" };
		const settings = Settings.isolated(legacySettings);

		expect(settings.get("live.codexVoice")).toBe("vale");
		expect(settings.get("live.grokVoice")).toBe("eve");
	});

	test("keeps explicit provider-specific voices over the legacy value", () => {
		const legacySettings: Record<string, unknown> = {
			"live.voice": "vale",
			"live.codexVoice": "maple",
			"live.grokVoice": "leo",
		};
		const settings = Settings.isolated(legacySettings);

		expect(settings.get("live.codexVoice")).toBe("maple");
		expect(settings.get("live.grokVoice")).toBe("leo");
	});
});
