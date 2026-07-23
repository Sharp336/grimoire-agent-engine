import { expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { HookRunner } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/runner";
import { HookToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/tool-wrapper";

test("HookToolWrapper preserves OpenAI computer metadata across result rewrites", async () => {
	let metadataExposedToHook: boolean | undefined;
	const hookRunner = {
		hasHandlers: (event: string) => event === "tool_result",
		emit: async (event: object) => {
			metadataExposedToHook = Object.hasOwn(event, "openaiComputer");
			return {
				content: [
					{ type: "image" as const, mimeType: "image/png", data: "rewritten-screenshot" },
					{ type: "text" as const, text: "hook annotation" },
				],
				details: { rewritten: true },
				isError: true,
			};
		},
	} as unknown as HookRunner;
	const acknowledgedSafetyChecks = [{ id: "safety-1", code: "confirm_navigation", message: "Confirm navigation" }];
	const openaiComputer = { acknowledgedSafetyChecks };
	const screenshotTool: AgentTool = {
		name: "computer",
		label: "Computer",
		description: "returns a screenshot",
		parameters: {} as never,
		execute: async () => ({
			content: [{ type: "image", mimeType: "image/png", data: "original-screenshot" }],
			details: { original: true },
			openaiComputer,
		}),
	};

	const rewritten = await new HookToolWrapper(screenshotTool, hookRunner).execute("computer-call", {} as never);

	expect(rewritten).toMatchObject({
		content: [
			{ type: "image", mimeType: "image/png", data: "rewritten-screenshot" },
			{ type: "text", text: "hook annotation" },
		],
		details: { rewritten: true },
		isError: true,
	});
	expect(metadataExposedToHook).toBe(false);
	expect(rewritten.openaiComputer).toBe(openaiComputer);
	expect(rewritten.openaiComputer?.acknowledgedSafetyChecks).toEqual(acknowledgedSafetyChecks);
});
