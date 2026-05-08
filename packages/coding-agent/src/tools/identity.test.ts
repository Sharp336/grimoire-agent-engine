import { describe, expect, it } from "bun:test";
import { IdentityTool } from "./identity";
import type { ToolSession } from ".";

describe("IdentityTool", () => {
	const mockSession: ToolSession = {
		cwd: "/test",
		hasUI: false,
		settings: {
			get: () => undefined,
		} as unknown as ToolSession["settings"],
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModelString: () => "claude-test",
		getAgentId: () => "0-Main",
		taskDepth: 0,
		skills: [],
	} as ToolSession;

	it("whoRu returns agent identity", async () => {
		const tool = new IdentityTool(mockSession);
		const result = await tool.execute("tc-1", { action: "whoRu" });
		expect(result.isError).toBeFalsy();
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Oh My Pi");
		expect(text).toContain("claude-test");
		expect(text).toContain("0-Main");
	});

	it("whoisme returns empty when no persona", async () => {
		const tool = new IdentityTool(mockSession);
		const result = await tool.execute("tc-2", { action: "whoisme" });
		expect(result.isError).toBeFalsy();
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("尚未配置用户人设");
	});

	it("update_persona requires section and data", async () => {
		const tool = new IdentityTool(mockSession);
		const result = await tool.execute("tc-3", { action: "update_persona" });
		expect(result.isError).toBe(true);
	});

	it("rejects invalid section", async () => {
		const tool = new IdentityTool(mockSession);
		const result = await tool.execute("tc-4", { action: "update_persona", section: "invalid", data: {} });
		expect(result.isError).toBe(true);
	});
});
