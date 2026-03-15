import { describe, expect, it } from "bun:test";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

describe("BashTool interception errors", () => {
	it("includes the suggested tool in ToolError context", async () => {
		const session = {
			settings: {
				get: (key: string) => {
					if (key === "async.enabled") return false;
					if (key === "astGrep.enabled") return false;
					if (key === "astEdit.enabled") return false;
					if (key === "bashInterceptor.enabled") return true;
					return false;
				},
				getBashInterceptorRules: () => DEFAULT_BASH_INTERCEPTOR_RULES,
			},
			skills: [],
			internalRouter: undefined,
			getArtifactsDir: () => "/tmp",
			getSessionId: () => "test-session",
		} as any;

		const tool = new BashTool(session);

		await expect(
			tool.execute(
				"call-1",
				{ command: "cat README.md" },
				undefined,
				undefined,
				{ toolNames: ["read"] } as any,
			),
		).rejects.toMatchObject({
			name: "ToolError",
			message: expect.stringContaining("Blocked:"),
			context: { suggestedTool: "read" },
		});
	});
});
