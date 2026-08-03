import { describe, expect, test } from "bun:test";
import {
	assertSafeChatGptWebEvidence,
	CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION,
	createChatGptWebLocalEvidence,
} from "../src/evidence";

function evidence() {
	return createChatGptWebLocalEvidence({
		commit: "0123456789abcdef0123456789abcdef01234567",
		os: "win32",
		arch: "x64",
		bunVersion: "1.3.14",
		browserVersion: "Chrome 140",
		scenarioId: "browser-only-text",
		passed: true,
		invariants: { noMcpProcess: true, noCredentialOutput: true },
	});
}

describe("ChatGPT Web local evidence", () => {
	test("uses a versioned allowlisted shape with invariant observations", () => {
		const value = evidence();
		expect(value.schemaVersion).toBe(CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION);
		expect(value.invariants).toEqual({ noMcpProcess: true, noCredentialOutput: true });
		expect(() => assertSafeChatGptWebEvidence(value)).not.toThrow();
	});

	test("rejects account, profile, cookie, token, path, and raw-response material", () => {
		const base = evidence();
		for (const [key, value] of [
			["profilePath", "/home/private/browser-profile"],
			["accountId", "acct-CANARY"],
			["cookie", "cookie-CANARY"],
			["token", "token-CANARY"],
			["rawResponse", "answer-CANARY"],
		]) {
			expect(() => assertSafeChatGptWebEvidence({ ...base, [key]: value })).toThrow();
		}
	});

	test("rejects stale schema and non-boolean invariants", () => {
		const base = evidence();
		expect(() => assertSafeChatGptWebEvidence({ ...base, schemaVersion: 2 })).toThrow();
		expect(() => assertSafeChatGptWebEvidence({ ...base, invariants: { noMcpProcess: "yes" } })).toThrow();
	});
});
