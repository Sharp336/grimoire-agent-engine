import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOOL_NAME = "earendil_works_pi_coding_agent_test";

describe("@earendil-works/pi-coding-agent and @earendil-works/pi-tui imports load in compiled binary mode", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@earendil-works-import-");
		const pluginDir = path.join(projectDir.path(), "earendil-works-like-plugin");
		extensionPath = path.join(pluginDir, "index.ts");
		fs.mkdirSync(pluginDir, { recursive: true });

		// Mirrors the import pattern used by pi-provider-kiro@0.7.0 and other
		// extensions that migrated from @mariozechner/* to @earendil-works/*.
		// DynamicBorder is a runtime value from pi-coding-agent; importing it
		// forces the module to actually be resolved and executed.
		fs.writeFileSync(
			extensionPath,
			[
				'import { DynamicBorder } from "@earendil-works/pi-coding-agent";',
				"",
				"export default function(pi) {",
				"\tpi.registerTool({",
				`\t\tname: ${JSON.stringify(TOOL_NAME)},`,
				'\t\tdescription: "earendil-works scope regression test",',
				"\t\tparameters: {},",
				`\t\texecute: async () => ({ content: [{ type: "text", text: String(typeof DynamicBorder) }] }),`,
				"\t});",
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("loads the extension and registers the tool", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has(TOOL_NAME)).toBe(true);
	});
});
