import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --preset flag", () => {
	it("parses --preset with a space-separated value", () => {
		const result = parseArgs(["--preset", "smart"]);
		expect(result.preset).toBe("smart");
		expect(result.messages).toEqual([]);
	});

	it("accepts --profile as an alias for --preset", () => {
		const result = parseArgs(["--profile", "smart"]);
		expect(result.preset).toBe("smart");
		expect(result.messages).toEqual([]);
	});

	it("parses the special 'list' value verbatim (resolution happens later)", () => {
		const result = parseArgs(["--preset", "list"]);
		expect(result.preset).toBe("list");
	});

	it("parses --preset=value without leaking the value into messages", () => {
		const result = parseArgs(["--preset=smart", "hello"]);
		expect(result.preset).toBe("smart");
		expect(result.messages).toEqual(["hello"]);
	});

	it("leaves preset undefined when no value follows --preset", () => {
		const result = parseArgs(["--preset"]);
		expect(result.preset).toBeUndefined();
		expect(result.messages).toEqual([]);
	});

	it("defaults preset to undefined when the flag is absent", () => {
		const result = parseArgs(["hello"]);
		expect(result.preset).toBeUndefined();
	});

	it("coexists with other flags", () => {
		const result = parseArgs(["--preset", "smart", "--model", "opus", "hello"]);
		expect(result.preset).toBe("smart");
		expect(result.model).toBe("opus");
		expect(result.messages).toContain("hello");
	});
});
