import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	test("migrates a legacy selected provider into a complete priority order", () => {
		const legacySettings: Record<string, unknown> = { "live.provider": "xai-grok" };
		const settings = Settings.isolated(legacySettings);

		expect(settings.get("providers.voiceOrder")).toEqual(["grok", "codex"]);
	});

	test("keeps an explicit voice provider order over a legacy provider", () => {
		const legacySettings: Record<string, unknown> = {
			"live.provider": "openai-codex",
			"providers.voiceOrder": ["grok"],
		};
		const settings = Settings.isolated(legacySettings);

		expect(settings.get("providers.voiceOrder")).toEqual(["grok"]);
	});

	test("normalizes a standalone flat Codex voice from persisted settings", async () => {
		using tempDir = TempDir.createSync("@omp-live-settings-");
		await Bun.write(tempDir.join("config.yml"), '"live.codexVoice": vale\n');

		const settings = await Settings.loadReadOnly({
			agentDir: tempDir.path(),
			cwd: tempDir.path(),
		});

		expect(settings.get("live.codexVoice")).toBe("vale");
	});
});
