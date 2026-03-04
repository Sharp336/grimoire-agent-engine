import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs --extra-root", () => {
	it("collects repeated --extra-root values", () => {
		const parsed = parseArgs([
			"--extra-root",
			"/repos/service-a",
			"--extra-root",
			"/repos/service-b",
			"implement feature",
		]);

		expect(parsed.extraRoots).toEqual(["/repos/service-a", "/repos/service-b"]);
		expect(parsed.messages).toEqual(["implement feature"]);
	});
});
