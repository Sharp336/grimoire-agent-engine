import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { deobfuscateAgentMessages, deobfuscateToolArguments, SecretObfuscator } from "../secrets/obfuscator";

describe("Tier-1: obfuscator mutation + display styling", () => {
	describe("addSecret() — runtime mutation", () => {
		it("plain obfuscate-mode entry: obfuscate → placeholder, deobfuscate → original", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "plain", content: "my-secret-value-1234" });

			const placeholder = obfuscator.obfuscate("my-secret-value-1234");
			expect(placeholder).toMatch(/^\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
			expect(placeholder).not.toContain("my-secret-value-1234");

			const restored = obfuscator.deobfuscate(placeholder);
			expect(restored).toBe("my-secret-value-1234");
		});

		it("regex entry: matches new values after addSecret()", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "regex", content: "sk-test-[A-Za-z0-9]+" });

			const result = obfuscator.obfuscate("token is sk-test-foobar here");
			expect(result).not.toContain("sk-test-foobar");
			expect(result).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
		});

		it("invalid regex throws (fail-closed)", () => {
			const obfuscator = new SecretObfuscator([]);
			expect(() => obfuscator.addSecret({ type: "regex", content: "[invalid" })).toThrow();
		});
	});

	describe("deobfuscateForDisplay() — display styling", () => {
		it("wraps the restored value in bold-magenta ANSI + [redacted from LLM] marker", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "plain", content: "my-secret-value-1234" });

			const placeholder = obfuscator.obfuscate("my-secret-value-1234");
			const displayed = obfuscator.deobfuscateForDisplay(placeholder);

			expect(displayed).toContain("\x1b[1;35m");
			expect(displayed).toContain("my-secret-value-1234");
			expect(displayed).toContain("\x1b[0m [redacted from LLM — source:user-typed, visible-to:human, ttl:session]");
		});

		it("deobfuscate() returns the raw value (no ANSI, no marker) — unchanged behavior", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "plain", content: "my-secret-value-1234" });

			const placeholder = obfuscator.obfuscate("my-secret-value-1234");
			const raw = obfuscator.deobfuscate(placeholder);

			expect(raw).toBe("my-secret-value-1234");
			expect(raw).not.toContain("\x1b");
			expect(raw).not.toContain("[redacted from LLM]");
		});
	});

	describe("display vs tool-call path wiring", () => {
		it("display path (deobfuscateAgentMessages) uses styled restoration for assistant text", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "plain", content: "my-secret-value-1234" });

			const placeholder = obfuscator.obfuscate("my-secret-value-1234");
			const messages = [
				{
					role: "assistant",
					content: [{ type: "text", text: `the value is ${placeholder}` }],
				},
			] as unknown as AgentMessage[];

			const result = deobfuscateAgentMessages(obfuscator, messages);
			const first = result[0];
			expect(first && typeof first === "object" && "content" in first).toBe(true);
			const content = (first as { content: unknown }).content;
			expect(Array.isArray(content)).toBe(true);
			const textBlock = (content as Array<{ type: string; text: string }>)[0];
			expect(textBlock.type).toBe("text");

			expect(textBlock.text).toContain("\x1b[1;35m");
			expect(textBlock.text).toContain("my-secret-value-1234");
			expect(textBlock.text).toContain(
				"\x1b[0m [redacted from LLM — source:user-typed, visible-to:human, ttl:session]",
			);
		});

		it("tool-call path (deobfuscateToolArguments) uses raw restoration — no styling", () => {
			const obfuscator = new SecretObfuscator([]);
			obfuscator.addSecret({ type: "plain", content: "my-secret-value-1234" });

			const placeholder = obfuscator.obfuscate("my-secret-value-1234");
			const args = { arg: placeholder };
			const result = deobfuscateToolArguments(obfuscator, args);

			expect(result).toEqual({ arg: "my-secret-value-1234" });
			expect(JSON.stringify(result)).not.toContain("\x1b");
			expect(JSON.stringify(result)).not.toContain("[redacted from LLM]");
		});
	});
});
