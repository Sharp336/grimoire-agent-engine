import { describe, expect, it } from "bun:test";
import { splitTopLevelDelimitedPath } from "../src/delimited-path";

describe("splitTopLevelDelimitedPath", () => {
	it("splits documented top-level delimiters without splitting escaped or brace-contained values", () => {
		expect(splitTopLevelDelimitedPath("README.md;skill://legacy", "semicolon")).toEqual([
			"README.md",
			"skill://legacy",
		]);
		expect(splitTopLevelDelimitedPath("README.md\\;skill://legacy", "semicolon")).toEqual([
			"README.md\\;skill://legacy",
		]);
		expect(splitTopLevelDelimitedPath("src/{a;b}.ts;skill://legacy", "semicolon")).toEqual([
			"src/{a;b}.ts",
			"skill://legacy",
		]);
	});
});
