import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretObfuscator } from "../secrets/obfuscator";
import {
	applyRedactors,
	loadRedactors,
	learnRedactor,
} from "../secrets/broker/deterministic-redactor";

const HTML = `<html><body>
	<div class="success">Password changed!</div>
	<span class="new-pw">new-fake-pw-6789</span>
</body></html>`;

describe("Phase C Task C2: deterministic redactors", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("learnRedactor validates a css-text pattern extracts exactly the observed value, then registers + persists it", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const path = join(dir, "redactors.json");
		const obfuscator = new SecretObfuscator([]);
		const result = learnRedactor({
			domain: "example.com",
			kind: "css-text",
			pattern: "span.new-pw",
			sampleDocument: HTML,
			observedValue: "new-fake-pw-6789",
			obfuscator,
			storePath: path,
		});
		expect(result.ok).toBe(true);
		// Value registered into the obfuscator
		const obfuscated = obfuscator.obfuscate("the page shows new-fake-pw-6789 now");
		expect(obfuscated).not.toContain("new-fake-pw-6789");
		// Persisted
		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored).toHaveLength(1);
		expect(stored[0].domain).toBe("example.com");
	});

	it("learnRedactor fails closed when the pattern extracts nothing", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const obfuscator = new SecretObfuscator([]);
		const result = learnRedactor({
			domain: "example.com",
			kind: "css-text",
			pattern: "span.does-not-exist",
			sampleDocument: HTML,
			observedValue: "new-fake-pw-6789",
			obfuscator,
			storePath: join(dir, "redactors.json"),
		});
		expect(result.ok).toBe(false);
	});

	it("learnRedactor fails closed when the pattern extracts a DIFFERENT value than observed", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const obfuscator = new SecretObfuscator([]);
		const result = learnRedactor({
			domain: "example.com",
			kind: "css-text",
			pattern: "div.success",
			sampleDocument: HTML,
			observedValue: "new-fake-pw-6789",
			obfuscator,
			storePath: join(dir, "redactors.json"),
		});
		expect(result.ok).toBe(false);
	});

	it("learnRedactor is idempotent (re-learning the same value does not duplicate)", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const path = join(dir, "redactors.json");
		const obfuscator = new SecretObfuscator([]);
		for (let i = 0; i < 2; i++) {
			const result = learnRedactor({
				domain: "example.com",
				kind: "css-text",
				pattern: "span.new-pw",
				sampleDocument: HTML,
				observedValue: "new-fake-pw-6789",
				obfuscator,
				storePath: path,
			});
			expect(result.ok).toBe(true);
		}
		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored).toHaveLength(1);
	});

	it("learnRedactor supports regex kind with one capture group", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const path = join(dir, "redactors.json");
		const obfuscator = new SecretObfuscator([]);
		const sms = "Your new password is sms-fake-pw-4321. It expires in 24h.";
		const result = learnRedactor({
			domain: "sms-gateway",
			kind: "regex",
			pattern: "new password is ([A-Za-z0-9-]+)",
			sampleDocument: sms,
			observedValue: "sms-fake-pw-4321",
			obfuscator,
			storePath: path,
		});
		expect(result.ok).toBe(true);
		expect(obfuscator.obfuscate(sms)).not.toContain("sms-fake-pw-4321");
	});

	it("learnRedactor fails closed for a regex with zero or multiple capture groups", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const obfuscator = new SecretObfuscator([]);
		for (const pattern of ["no groups here", "(a)(b)"]) {
			const result = learnRedactor({
				domain: "x",
				kind: "regex",
				pattern,
				sampleDocument: "abc",
				observedValue: "a",
				obfuscator,
				storePath: join(dir, "redactors.json"),
			});
			expect(result.ok).toBe(false);
		}
	});

	it("applyRedactors extracts and obfuscates values for the domain", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const path = join(dir, "redactors.json");
		const obfuscator = new SecretObfuscator([]);
		learnRedactor({
			domain: "example.com",
			kind: "css-text",
			pattern: "span.new-pw",
			sampleDocument: HTML,
			observedValue: "new-fake-pw-6789",
			obfuscator,
			storePath: path,
		});
		const redactors = loadRedactors(path);
		const scrubbed = applyRedactors("example.com", HTML, obfuscator, redactors);
		expect(scrubbed).not.toContain("new-fake-pw-6789");
		expect(scrubbed).toContain("Password changed!");
	});

	it("applyRedactors leaves other domains' documents untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "redactor-test-"));
		const path = join(dir, "redactors.json");
		const obfuscator = new SecretObfuscator([]);
		learnRedactor({
			domain: "example.com",
			kind: "css-text",
			pattern: "span.new-pw",
			sampleDocument: HTML,
			observedValue: "new-fake-pw-6789",
			obfuscator,
			storePath: path,
		});
		const redactors = loadRedactors(path);
		const other = applyRedactors("other.org", HTML, obfuscator, redactors);
		expect(other).toBe(HTML);
	});

	it("loadRedactors returns [] for a missing store file", () => {
		expect(loadRedactors(join(tmpdir(), "definitely-missing-redactors.json"))).toEqual([]);
	});
});
