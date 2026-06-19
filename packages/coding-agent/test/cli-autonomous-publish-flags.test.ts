import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

describe("parseArgs — autonomous publish flags", () => {
	it("parses --auto-commit and --auto-pr as boolean launch flags", () => {
		const result = parseArgs(["--auto-next-steps", "--auto-commit", "--auto-pr", "ship it"]);

		expect(result.autoNextSteps).toBe(true);
		expect(result.autoCommit).toBe(true);
		expect(result.autoPr).toBe(true);
		expect(result.messages).toEqual(["ship it"]);
	});

	it("does not consume the following flag as a value", () => {
		const result = parseArgs(["--auto-pr", "--model", "opus"]);

		expect(result.autoPr).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
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
	});
});
