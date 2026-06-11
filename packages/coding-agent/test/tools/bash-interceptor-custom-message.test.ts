import { describe, expect, it } from "bun:test";
import type { BashInterceptorRule } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { HASHLINE_EDIT_INPUT_GUIDANCE } from "@oh-my-pi/pi-coding-agent/edit/hashline/guidance";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

describe("custom edit interceptor messages", () => {
	const tools = ["edit"];

	it("preserves configured message for custom python edit rules", () => {
		const custom: BashInterceptorRule[] = [
			{
				pattern: "^python\\s+manage\\.py",
				tool: "edit",
				message: "Use the project task runner, not bash, for manage.py.",
			},
		];
		const result = checkBashInterception("python manage.py migrate", tools, custom);
		expect(result.block).toBe(true);
		expect(result.message).toContain("Use the project task runner");
		expect(result.message).not.toContain(HASHLINE_EDIT_INPUT_GUIDANCE);
	});

	it("matches custom rules against raw command with leading env assignment", () => {
		const custom: BashInterceptorRule[] = [
			{
				pattern: "^AWS_PROFILE=prod\\s+terraform",
				tool: "bash",
				message: "Run terraform via the approved wrapper.",
			},
		];
		const result = checkBashInterception("AWS_PROFILE=prod terraform apply", ["bash"], custom);
		expect(result.block).toBe(true);
		expect(result.message).toContain("approved wrapper");
	});
});
