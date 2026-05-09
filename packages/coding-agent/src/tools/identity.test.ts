import { describe, expect, it } from "bun:test";
import type { ToolSession } from ".";
import { IdentityTool } from "./identity";

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
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Oh My Pi");
		expect(text).toContain("claude-test");
		expect(text).toContain("0-Main");
	});

	it("whoisme returns empty when no persona", async () => {
		const tool = new IdentityTool(mockSession);
		const result = await tool.execute("tc-2", { action: "whoisme" });
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("尚未配置用户人设");
	});

	it("update_persona requires section and data", async () => {
		const tool = new IdentityTool(mockSession);
		await expect(tool.execute("tc-3", { action: "update_persona" })).rejects.toThrow();
	});

	it("rejects invalid section", async () => {
		const tool = new IdentityTool(mockSession);
		await expect(tool.execute("tc-4", { action: "update_persona", section: "invalid", data: {} })).rejects.toThrow();
	});

	it("whoRu detects actual provider from getActiveModelDetails", async () => {
		const session = {
			...mockSession,
			getActiveModelString: () => "anthropic/claude-sonnet-4-20250514",
			getActiveModelDetails: () => ({
				provider: "kimi-code",
				baseUrl: "https://api.kimi.com/coding",
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
			}),
		};
		const tool = new IdentityTool(session as ToolSession);
		const result = await tool.execute("tc-5", { action: "whoRu" });
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("提供商：kimi-code");
		expect(text).toContain("模型：anthropic/claude-sonnet-4-20250514");
	});

	it("whoRu falls back to model string when getActiveModelDetails is unavailable", async () => {
		const session = {
			...mockSession,
			getActiveModelString: () => "openai/gpt-4",
			getActiveModelDetails: undefined,
		};
		const tool = new IdentityTool(session as ToolSession);
		const result = await tool.execute("tc-6", { action: "whoRu" });
		const text = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("提供商：openai");
		expect(text).toContain("模型：openai/gpt-4");
	});
});
