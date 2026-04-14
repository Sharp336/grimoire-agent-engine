import { describe, expect, it } from "bun:test";
import { loginMeridian } from "../src/utils/oauth/meridian";

describe("meridian login", () => {
	it("uses placeholder token and Meridian instructions by default", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginMeridian({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "";
			},
		});

		expect(authUrl).toBe("https://github.com/rynfar/meridian");
		expect(authInstructions).toContain("http://127.0.0.1:3456");
		expect(authInstructions).toContain('default token "x"');
		expect(promptMessage).toContain("MERIDIAN_BASE_URL");
		expect(promptMessage).not.toContain("ANTHROPIC_BASE_URL");
		expect(promptPlaceholder).toBe("x");
		expect(apiKey).toBe("x");
	});

	it("returns a provided placeholder token unchanged after trimming", async () => {
		const apiKey = await loginMeridian({
			onPrompt: async () => "  meridian-local  ",
		});

		expect(apiKey).toBe("meridian-local");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginMeridian({})).rejects.toThrow("Meridian login requires onPrompt callback");
	});
});
