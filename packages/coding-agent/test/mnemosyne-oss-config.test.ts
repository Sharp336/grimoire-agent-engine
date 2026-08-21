import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemosyneOssConfig } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/config";

describe("loadMnemosyneOssConfig", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("resolves an interoperable scoped store without enabling hosted services", async () => {
		const base = Settings.isolated({
			"memory.backend": "mnemosyne-oss",
			"mnemosyne-oss.dataDir": "shared-store",
			"mnemosyne-oss.bank": "team-memory",
			"mnemosyne-oss.scoping": "per-project-tagged",
			"mnemosyne-oss.localEmbeddings": false,
			"mnemosyne-oss.localConsolidation": false,
			"mnemosyne-oss.localLlmRepo": "ignored-local-repo",
			"mnemosyne-oss.recallLimit": 0,
			"mnemosyne-oss.injectionTokenLimit": 12,
		});
		const cwd = "/tmp/mnemosyne-oss-config-project";
		const config = loadMnemosyneOssConfig(await base.cloneForCwd(cwd), "/tmp/agent");

		expect(config.diagnostic).toBeUndefined();
		expect(config.dataDir).toBe(path.join(cwd, "shared-store"));
		expect(config.retainBank).toBe(config.bank);
		expect(config.recallBanks).toEqual([config.bank, "team-memory"]);
		expect(config.sharedBanks).toEqual(["team-memory"]);
		expect(config.localEmbeddings).toBe(false);
		expect(config.ownership).toBe("shared");
		expect(config.localLlmRepo).toBeUndefined();
		expect(config.recallLimit).toBe(1);
		expect(config.injectionTokenLimit).toBe(256);
	});

	it("returns an inert diagnostic for an invalid explicit bank name", () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemosyne-oss",
			"mnemosyne-oss.bank": "team/shared",
		});
		const config = loadMnemosyneOssConfig(settings, "/tmp/agent");

		expect(config.diagnostic).toContain('bank "team/shared" is invalid');
	});
});
