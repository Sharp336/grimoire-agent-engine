import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";

function makeTool(name: string): AgentTool {
	return {
		name,
		description: `${name} tool`,
		label: `${name} tool`,
		parameters: {} as unknown as never,
		strict: false,
		approval: "exec",
		execute: async () => ({
			content: [
				{
					type: "text",
					text: `${name} output`,
				},
			],
		}),
	} as unknown as AgentTool;
}

function makeSettings(): AgentToolContext["settings"] {
	return {
		get(key: string): unknown {
			switch (key) {
				case "tools.approvalMode":
					return "always-ask";
				case "tools.approval":
					return {};
				default:
					return undefined;
			}
		},
	} as AgentToolContext["settings"];
}

function makeRunner(hasUI = false): ExtensionRunner {
	return {
		hasUI: () => hasUI,
		hasHandlers: () => false,
		getUIContext: () => {
			throw new Error("UI context should not be used");
		},
	} as unknown as ExtensionRunner;
}

describe("ExtensionToolWrapper approval message hints", () => {
	it("shows command-glob hint only for bash", async () => {
		const readTool = new ExtensionToolWrapper(makeTool("read"), makeRunner(false));
		const bashTool = new ExtensionToolWrapper(makeTool("bash"), makeRunner(false));
		const context = { settings: makeSettings() } as AgentToolContext;

		let readError = "";
		let bashError = "";

		try {
			await readTool.execute("read", {}, undefined, undefined, context);
		} catch (err) {
			readError = String(err);
		}

		try {
			await bashTool.execute("bash", {}, undefined, undefined, context);
		} catch (err) {
			bashError = String(err);
		}

		expect(readError).toContain('Tool "read" requires approval but no interactive UI available.');
		expect(readError).not.toContain("command-glob map");
		expect(readError).toContain("Add tools.approval.read: allow to config");

		expect(bashError).toContain('Tool "bash" requires approval but no interactive UI available.');
		expect(bashError).toContain("Add tools.approval.bash: allow (or a bash command-glob map) to config");
	});

	it("still includes config alternatives when no UI context exists", async () => {
		const tool = new ExtensionToolWrapper(makeTool("read"), makeRunner(false));
		const context = { settings: makeSettings() } as AgentToolContext;
		let message = "";

		await tool
			.execute("read", {}, undefined, undefined, context)
			.then(() => {
				throw new Error("Execution should require approval");
			})
			.catch(error => {
				message = String(error);
			});

		expect(message).toContain("2. Add tools.approval.read: allow to config");
	});
});
