import { describe, expect, it } from "bun:test";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { bashInterceptScriptedEditMessage, HASHLINE_EDIT_INPUT_GUIDANCE } from "../../src/edit/hashline/guidance";

describe("HASHLINE_EDIT_INPUT_GUIDANCE", () => {
	it("mentions hashline edit and bash scripting", () => {
		expect(HASHLINE_EDIT_INPUT_GUIDANCE).toMatch(/PATH#TAG/);
		expect(HASHLINE_EDIT_INPUT_GUIDANCE).toMatch(/python -c/);
	});
});

describe("bash intercept scripted edit messages", () => {
	const tools = ["read", "edit"];
	const pythonRules = DEFAULT_BASH_INTERCEPTOR_RULES.filter(r => r.tool === "edit" && r.pattern.includes("python"));

	it("includes shared guidance when blocking python -c writes", () => {
		const result = checkBashInterception("python -c \"open('a.ts','w').write('x')\"", tools, pythonRules);
		expect(result.block).toBe(true);
		expect(result.message).toContain(HASHLINE_EDIT_INPUT_GUIDANCE);
	});

	it("bashInterceptScriptedEditMessage embeds guidance", () => {
		const msg = bashInterceptScriptedEditMessage("`python -c`");
		expect(msg).toContain("`python -c`");
		expect(msg).toContain(HASHLINE_EDIT_INPUT_GUIDANCE);
	});
});
