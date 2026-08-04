/**
 * Regression for issue #5764: re-registering an essential built-in (read /
 * write / bash / edit / glob) without an explicit `loadMode` must NOT demote it
 * to `discoverable`, which — with `tools.xdev` on — unmounts it from the
 * top-level schema and breaks the `xd://` transport (transport IS `read xd://`
 * / `write xd://<tool>`).
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { composeAgentTool, composeCustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/compose-tool";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
} from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const emptySchema = type({});
const noopExecute = async () => ({ content: [{ type: "text" as const, text: "" }] });
const stubRunner = { createContext: () => ({}) as ExtensionContext } as ExtensionRunner;

describe("issue #5764: registerTool loadMode default", () => {
	it("never mounts the read/write transport tools under xdev, even when mislabeled discoverable", () => {
		expect(isMountableUnderXdev({ name: "read", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "write", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" })).toBe(true);
	});

	it("defaults omitted loadMode to essential for essential built-in names, discoverable otherwise", () => {
		expect(defaultLoadModeForToolName("read")).toBe("essential");
		expect(defaultLoadModeForToolName("bash")).toBe("essential");
		expect(defaultLoadModeForToolName("edit")).toBe("essential");
		expect(defaultLoadModeForToolName("glob")).toBe("essential");
		expect(defaultLoadModeForToolName("some_extension_tool")).toBe("discoverable");
		expect(defaultLoadModeForToolName("read", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("some_extension_tool", "essential")).toBe("essential");
	});

	it("composeCustomTool defaults a re-registered essential built-in (CustomTool) to essential and not mountable", () => {
		const customTool: CustomTool = {
			name: "bash",
			label: "Bash",
			description: "wrapped bash",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(customTool, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeCustomTool defaults a re-registered essential built-in (ToolDefinition) to essential and not mountable", () => {
		const definition: ToolDefinition = {
			name: "read",
			label: "Read",
			description: "wrapped read",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(definition, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeCustomTool still defaults a novel extension CustomTool to discoverable", () => {
		const customTool: CustomTool = {
			name: "my_ext_tool",
			label: "My Ext Tool",
			description: "novel tool",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(customTool, stubRunner);
		expect(tool.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(tool)).toBe(true);
	});

	it("composeCustomTool still defaults a novel extension ToolDefinition to discoverable", () => {
		const definition: ToolDefinition = {
			name: "my_ext_tool",
			label: "My Ext Tool",
			description: "novel tool",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(definition, stubRunner);
		expect(tool.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(tool)).toBe(true);
	});

	it("composeAgentTool preserves an essential built-in AgentTool's loadMode and keeps it unmountable", async () => {
		const session = makeSession();
		const builtIn = await BUILTIN_TOOLS.bash(session);
		if (!builtIn) {
			expect.unreachable("bash built-in should be available");
			return;
		}
		const tool = composeAgentTool(builtIn, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeCustomTool respects an explicit opts.loadMode override", () => {
		const definition: ToolDefinition = {
			name: "some_extension_tool",
			label: "Some Tool",
			description: "test",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(definition, stubRunner, { loadMode: "essential" });
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("keeps ESSENTIAL_BUILTIN_TOOL_NAMES in sync with the tool classes that declare loadMode essential", async () => {
		const session = makeSession();
		for (const name in ESSENTIAL_BUILTIN_TOOL_NAMES) {
			const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
			expect(factory, `${name} must be a built-in factory`).toBeDefined();
			const tool = await factory(session);
			if (!tool) continue;
			expect(tool.loadMode, `${name} must declare loadMode "essential"`).toBe("essential");
		}
	});
});
