import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvolutionBoardTool } from "@oh-my-pi/pi-coding-agent/tools/evolution-board";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("EvolutionBoardTool", () => {
	it("returns error when no evolution board file exists", async () => {
		const tool = new EvolutionBoardTool(createSession());
		const result = await tool.execute("test-id", { action: "list" });
		expect((result.content[0] as { type: string; text: string }).text).toContain("No evolution board found");
	});
});
