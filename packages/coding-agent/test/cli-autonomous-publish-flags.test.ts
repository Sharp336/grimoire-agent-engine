import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

describe("parseArgs — autonomous publish flags", () => {
	it("parses autonomous publish flags as launch flags", () => {
		const result = parseArgs([
			"--auto-next-steps",
			"--auto-commit",
			"--auto-pr",
			"--auto-group-pr",
			"--auto-agents",
			"3",
			"ship it",
		]);

		expect(result.autoNextSteps).toBe(true);
		expect(result.autoCommit).toBe(true);
		expect(result.autoPr).toBe(true);
		expect(result.autoGroupPr).toBe(true);
		expect(result.autoAgents).toBe(3);
		expect(result.messages).toEqual(["ship it"]);
	});

	it("does not consume the following flag as a value", () => {
		const result = parseArgs(["--auto-pr", "--model", "opus"]);

		expect(result.autoPr).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});

	it("parses --auto-agents=N form", () => {
		const result = parseArgs(["--auto-next-steps", "--auto-agents=2", "ship it"]);

		expect(result.autoAgents).toBe(2);
		expect(result.messages).toEqual(["ship it"]);
	});
});

describe("profile bootstrap — autonomous publish flags", () => {
	it("extracts trailing profiles after autonomous publish booleans", () => {
		expect(extractProfileFlags(["--auto-commit", "--profile", "work"])).toEqual({
			argv: ["--auto-commit"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--auto-pr", "--profile", "work"])).toEqual({
			argv: ["--auto-pr"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--auto-group-pr", "--profile", "work"])).toEqual({
			argv: ["--auto-group-pr"],
			profile: "work",
			aliasName: undefined,
		});
	});

	it("preserves --auto-agents value while extracting trailing profiles", () => {
		expect(extractProfileFlags(["--auto-agents", "3", "--profile", "work"])).toEqual({
			argv: ["--auto-agents", "3"],
			profile: "work",
			aliasName: undefined,
		});
	});
});
