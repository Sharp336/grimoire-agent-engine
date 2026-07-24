import { describe, expect, it } from "bun:test";
import { getDefault, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

describe("settings: tools.formatCallSource", () => {
	it("defaults to false and uses tools Display metadata", () => {
		expect(getDefault("tools.formatCallSource")).toBe(false);
		expect(getUi("tools.formatCallSource")).toMatchObject({
			tab: "tools",
			group: "Display",
			label: "Format Tool Call Source",
			description:
				"Format completed eval/shell/code-file tool call source with compatible installed formatters. Does not modify the source executed or written by the tool.",
		});
	});
});
