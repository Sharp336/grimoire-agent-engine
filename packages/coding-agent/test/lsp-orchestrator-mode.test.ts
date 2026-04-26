import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "../src/lsp";
import type { ToolSession } from "../src/tools";

function createToolSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		orchestratorMode: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("LspTool orchestrator mode guards", () => {
	it("blocks applying rename edits in orchestrator mode", async () => {
		const tool = new LspTool(createToolSession());
		const result = await tool.execute("call-1", {
			action: "rename",
			file: "src/example.ts",
			line: 1,
			new_name: "renamed",
		});

		expect(result.details?.success).toBe(false);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text content");
		expect(result.content[0].text).toContain("Orchestrator mode requires delegating mutations through the task tool");
	});

	it("blocks applying code actions in orchestrator mode", async () => {
		const tool = new LspTool(createToolSession());
		const result = await tool.execute("call-2", {
			action: "code_actions",
			file: "src/example.ts",
			line: 1,
			apply: true,
			query: "source.organizeImports",
		});

		expect(result.details?.success).toBe(false);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text content");
		expect(result.content[0].text).toContain("Orchestrator mode requires delegating mutations through the task tool");
	});
});
