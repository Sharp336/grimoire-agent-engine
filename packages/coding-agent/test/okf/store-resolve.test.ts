import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { HindsightConfig } from "../../src/hindsight/config";
import { deriveOkfBankId } from "../../src/okf/store/store-resolve";

function makeConfig(bankIdPrefix = ""): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix,
		scoping: "per-project",
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: false,
		retainMode: "full-session",
		retainEveryNTurns: 1,
		retainOverlapTurns: 0,
		retainContext: "",
		recallBudget: "mid",
		recallMaxTokens: 1000,
		recallTypes: [],
		recallContextTurns: 0,
		recallMaxQueryChars: 200,
		recallPromptPreamble: "",
		debug: false,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 0,
		mentalModelMaxRenderChars: 0,
	};
}

describe("okf/store-resolve deriveOkfBankId", () => {
	it("scopes the default bank per project (no explicit bankId)", async () => {
		const settings = Settings.isolated();
		const config = makeConfig();
		// Temp dirs outside the git repo so projectLabel falls back to the basename.
		const projA = await mkdtemp(path.join(os.tmpdir(), "okf-projA-"));
		const projB = await mkdtemp(path.join(os.tmpdir(), "okf-projB-"));
		try {
			const bankA = deriveOkfBankId(settings, config, projA);
			const bankB = deriveOkfBankId(settings, config, projB);
			expect(bankA).toMatch(/^okf-/);
			expect(bankB).toMatch(/^okf-/);
			// Different projects must not share a bank — otherwise reindex() of one
			// deletes the other's concepts from the shared Hindsight store.
			expect(bankA).not.toBe(bankB);
		} finally {
			await rm(projA, { recursive: true, force: true });
			await rm(projB, { recursive: true, force: true });
		}
	});

	it("uses the same bank for the same project across sessions", async () => {
		const settings = Settings.isolated();
		const config = makeConfig();
		const proj = await mkdtemp(path.join(os.tmpdir(), "okf-stable-"));
		try {
			expect(deriveOkfBankId(settings, config, proj)).toBe(deriveOkfBankId(settings, config, proj));
		} finally {
			await rm(proj, { recursive: true, force: true });
		}
	});

	it("uses an explicit okf.bankId verbatim (shared bank)", async () => {
		const settings = Settings.isolated();
		settings.set("okf.bankId", "shared-okf");
		const config = makeConfig();
		const projA = await mkdtemp(path.join(os.tmpdir(), "okf-projA-"));
		const projB = await mkdtemp(path.join(os.tmpdir(), "okf-projB-"));
		try {
			expect(deriveOkfBankId(settings, config, projA)).toBe("shared-okf");
			expect(deriveOkfBankId(settings, config, projB)).toBe("shared-okf");
		} finally {
			await rm(projA, { recursive: true, force: true });
			await rm(projB, { recursive: true, force: true });
		}
	});

	it("honors the bankIdPrefix for both default and explicit banks", async () => {
		const settings = Settings.isolated();
		const config = makeConfig("u-james");
		const proj = await mkdtemp(path.join(os.tmpdir(), "okf-projX-"));
		try {
			expect(deriveOkfBankId(settings, config, proj).startsWith("u-james-")).toBe(true);
			settings.set("okf.bankId", "shared");
			expect(deriveOkfBankId(settings, config, proj)).toBe("u-james-shared");
		} finally {
			await rm(proj, { recursive: true, force: true });
		}
	});
});
