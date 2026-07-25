import { describe, expect, it } from "bun:test";
import { getUi, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";

/**
 * Heuristic used only to catch a credential setting that was added without
 * masking. It is a review aid, never an authorization boundary: a name is not
 * a security property, and callers must not decide disclosure from it.
 */
const CREDENTIAL_NAME = /token|apikey|api_key|password|passwd|credential|secret|bearer/i;

/** Paths the heuristic matches on wording alone; none of them hold a credential. */
const NOT_CREDENTIALS: Record<string, true> = {
	"display.showTokenUsage": true,
	"share.redactSecrets": true,
	"secrets.enabled": true,
	"compaction.thresholdTokens": true,
	"compaction.reserveTokens": true,
	"compaction.keepRecentTokens": true,
	"compaction.idleThresholdTokens": true,
	"branchSummary.reserveTokens": true,
	"memories.phase1InputTokenLimit": true,
	"memories.fallbackTokenLimit": true,
	"memories.summaryInjectionTokenLimit": true,
	"mnemopi.injectionTokenLimit": true,
	"hindsight.recallMaxTokens": true,
	"commit.mapReduceMaxFileTokens": true,
};

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

describe("settings schema credential masking", () => {
	it("masks every credential that the settings panel can display", () => {
		const unmasked = paths.filter(path => {
			const ui = getUi(path);
			if (!ui || ui.secret === true) return false;
			return CREDENTIAL_NAME.test(path) && NOT_CREDENTIALS[path] !== true;
		});
		// A visible setting holding a credential must render as dots, not plain
		// text: `ui.secret` is what drives masking in the row and the editor.
		expect(unmasked).toEqual([]);
	});

	it("keeps the known credential settings marked", () => {
		for (const path of ["mnemopi.embeddingApiKey", "mnemopi.llmApiKey", "hindsight.apiToken"] as const) {
			expect(getUi(path)?.secret).toBe(true);
		}
	});

	it("only marks string settings secret", () => {
		for (const path of paths) {
			if (getUi(path)?.secret !== true) continue;
			expect(SETTINGS_SCHEMA[path].type).toBe("string");
		}
	});

	it("lists every heuristic exemption against a real setting", () => {
		// Keeps the allowlist honest: a renamed or deleted setting must not leave
		// a stale exemption that silently excuses a future credential.
		const known = new Set<string>(paths);
		expect(Object.keys(NOT_CREDENTIALS).filter(path => !known.has(path))).toEqual([]);
	});
});
