import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

describe("createSubagentSettings xdevPromote override", () => {
	const parent = Settings.isolated({ "tools.xdevPromote": ["lsp"] });

	it("inherits the parent's tools.xdevPromote when no override is given", () => {
		expect(createSubagentSettings(parent).get("tools.xdevPromote")).toEqual(["lsp"]);
	});

	it("lets an agent frontmatter xdevPromote replace the inherited value", () => {
		expect(createSubagentSettings(parent, { "tools.xdevPromote": ["ast_edit"] }).get("tools.xdevPromote")).toEqual([
			"ast_edit",
		]);
	});

	it("keeps readSummarize false and xdevPromote independent overrides", () => {
		const child = createSubagentSettings(parent, {
			"read.summarize.enabled": false,
			"tools.xdevPromote": ["ast_edit"],
		});
		expect(child.get("read.summarize.enabled")).toBe(false);
		expect(child.get("tools.xdevPromote")).toEqual(["ast_edit"]);
	});
});
