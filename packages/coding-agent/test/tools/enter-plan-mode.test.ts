import { describe, expect, it } from "bun:test";
import { EnterPlanModeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createToolSession(overrides: Partial<ToolSession>): ToolSession {
	return overrides as ToolSession;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

describe("EnterPlanModeTool.createIf", () => {
	it("constructs the tool only when the host supports agent plan entry", () => {
		expect(EnterPlanModeTool.createIf(createToolSession({ supportsAgentPlanEntry: true }))).toBeInstanceOf(
			EnterPlanModeTool,
		);
		expect(EnterPlanModeTool.createIf(createToolSession({ supportsAgentPlanEntry: false }))).toBeNull();
		expect(EnterPlanModeTool.createIf(createToolSession({}))).toBeNull();
	});
});

describe("EnterPlanModeTool.execute", () => {
	it("requests plan mode entry and reports the read-only transition", async () => {
		let calls = 0;
		const tool = new EnterPlanModeTool(
			createToolSession({
				supportsAgentPlanEntry: true,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				canEnterPlanMode: () => true,
				requestEnterPlanMode: async () => {
					calls += 1;
				},
			}),
		);

		const result = await tool.execute("call-1", { reason: "multi-file refactor" });

		expect(calls).toBe(1);
		expect(result.details?.entered).toBe(true);
		expect(result.details?.reason).toBe("multi-file refactor");
		expect(firstText(result)).toContain("read-only");
		expect(firstText(result)).toContain("resolve");
	});

	it("is a no-op when already in plan mode and never re-invokes the host", async () => {
		let calls = 0;
		const tool = new EnterPlanModeTool(
			createToolSession({
				supportsAgentPlanEntry: true,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
				canEnterPlanMode: () => true,
				requestEnterPlanMode: async () => {
					calls += 1;
				},
			}),
		);

		const result = await tool.execute("call-1", {});

		expect(calls).toBe(0);
		expect(result.details?.entered).toBe(false);
		expect(firstText(result)).toBe("Already in plan mode.");
	});

	it("refuses while goal mode is active", async () => {
		const tool = new EnterPlanModeTool(
			createToolSession({
				supportsAgentPlanEntry: true,
				getPlanModeState: () => undefined,
				getGoalModeState: () => ({ enabled: true, goal: { status: "active" } }) as never,
				canEnterPlanMode: () => true,
				requestEnterPlanMode: async () => undefined,
			}),
		);

		await expect(tool.execute("call-1", {})).rejects.toThrow(/goal mode/i);
	});

	it("refuses while a goal is paused", async () => {
		const tool = new EnterPlanModeTool(
			createToolSession({
				supportsAgentPlanEntry: true,
				getPlanModeState: () => undefined,
				getGoalModeState: () => ({ enabled: false, goal: { status: "paused" } }) as never,
				canEnterPlanMode: () => true,
				requestEnterPlanMode: async () => undefined,
			}),
		);

		await expect(tool.execute("call-1", {})).rejects.toThrow(/goal mode/i);
	});

	it("errors when the host has no plan-entry handler installed", async () => {
		let calls = 0;
		const tool = new EnterPlanModeTool(
			createToolSession({
				supportsAgentPlanEntry: true,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				canEnterPlanMode: () => false,
				requestEnterPlanMode: async () => {
					calls += 1;
				},
			}),
		);

		await expect(tool.execute("call-1", {})).rejects.toThrow(/not available/i);
		expect(calls).toBe(0);
	});
});
