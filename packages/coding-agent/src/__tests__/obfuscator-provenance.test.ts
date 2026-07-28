import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "../secrets/obfuscator";

describe("Phase D Task D2: provenance tags in deobfuscateForDisplay", () => {
	it("default source is user-typed for addSecret", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addSecret({ type: "plain", content: "prov-secret-value-0001" });
		const obfuscated = obfuscator.obfuscate("prov-secret-value-0001");
		const display = obfuscator.deobfuscateForDisplay(obfuscated);
		expect(display).toContain("prov-secret-value-0001");
		expect(display).toContain("source:user-typed");
		expect(display).toContain("visible-to:human");
		expect(display).toContain("ttl:session");
	});

	it("explicit source via addSecret (e.g. bitwarden from /redact)", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addSecret({ type: "plain", content: "prov-secret-value-0002", source: "bitwarden" });
		const display = obfuscator.deobfuscateForDisplay(obfuscator.obfuscate("prov-secret-value-0002"));
		expect(display).toContain("source:bitwarden");
	});

	it("constructor-loaded entries report source secrets-yml", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "prov-secret-value-0003" }]);
		const display = obfuscator.deobfuscateForDisplay(obfuscator.obfuscate("prov-secret-value-0003"));
		expect(display).toContain("source:secrets-yml");
	});

	it("marker format: value wrapped in ANSI + full provenance suffix", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addSecret({ type: "plain", content: "prov-secret-value-0004", source: "infisical" });
		const display = obfuscator.deobfuscateForDisplay(obfuscator.obfuscate("prov-secret-value-0004"));
		expect(display).toBe(
			`\x1b[1;35mprov-secret-value-0004\x1b[0m [redacted from LLM — source:infisical, visible-to:human, ttl:session]`,
		);
	});

	it("raw deobfuscate() path is unchanged (no provenance decoration)", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addSecret({ type: "plain", content: "prov-secret-value-0005", source: "bitwarden" });
		const raw = obfuscator.deobfuscate(obfuscator.obfuscate("prov-secret-value-0005"));
		expect(raw).toBe("prov-secret-value-0005");
	});

	it("obfuscate path unchanged (no provenance leakage into provider-bound text)", () => {
		const obfuscator = new SecretObfuscator([]);
		obfuscator.addSecret({ type: "plain", content: "prov-secret-value-0006", source: "bitwarden" });
		const obfuscated = obfuscator.obfuscate("prov-secret-value-0006");
		expect(obfuscated).not.toContain("bitwarden");
		expect(obfuscated).not.toContain("source:");
	});
});
