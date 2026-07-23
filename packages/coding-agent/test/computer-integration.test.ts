import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault, getPathsForTab, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
} from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/computer-integration-test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("computer builtin integration", () => {
	it("is registered as essential but gated off by default", async () => {
		expect(BUILTIN_TOOL_NAMES).toContain("computer");
		expect(ESSENTIAL_BUILTIN_TOOL_NAMES.computer).toBe(true);
		expect(defaultLoadModeForToolName("computer")).toBe("essential");
		expect(await BUILTIN_TOOLS.computer(makeSession())).toBeNull();

		const tools = await createTools(makeSession(), ["computer"]);
		expect(tools).toEqual([]);
	});

	it("stays top-level and preserves its OpenAI marker when enabled and wrapped", async () => {
		const settings = Settings.isolated({ "computer.enabled": true });
		const tools = await createTools(makeSession(settings), ["computer"]);
		expect(tools).toHaveLength(1);
		const computer = tools[0]!;

		expect(computer.name).toBe("computer");
		expect(computer.loadMode).toBe("essential");
		expect(computer.openaiNativeTool).toBe("computer");
		expect(isMountableUnderXdev(computer)).toBe(false);

		const wrapped = new ExtensionToolWrapper(computer, {} as ExtensionRunner);
		expect(Reflect.get(wrapped, "openaiNativeTool")).toBe("computer");
	});

	it("exposes disabled and start URL settings in the tools UI", () => {
		expect(getDefault("computer.enabled")).toBe(false);
		expect(getDefault("computer.startUrl")).toBe("about:blank");
		expect(getPathsForTab("tools")).toEqual(expect.arrayContaining(["computer.enabled", "computer.startUrl"]));
		expect(getUi("computer.enabled")).toMatchObject({
			group: "Computer Use",
			label: "Computer Use",
		});
		expect(getUi("computer.startUrl")).toMatchObject({
			group: "Computer Use",
			label: "Computer Start URL",
		});
	});
});
