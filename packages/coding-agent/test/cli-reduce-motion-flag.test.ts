import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --reduce-motion flag", () => {
	it("parses the bare form as on", () => {
		const result = parseArgs(["--reduce-motion"]);
		expect(result.reduceMotion).toBe("on");
	});

	it("parses a space-separated value", () => {
		const result = parseArgs(["--reduce-motion", "strict"]);
		expect(result.reduceMotion).toBe("strict");
	});

	it("parses an equals-form value", () => {
		const result = parseArgs(["--reduce-motion=strict"]);
		expect(result.reduceMotion).toBe("strict");
	});

	it("accepts off", () => {
		const result = parseArgs(["--reduce-motion=off"]);
		expect(result.reduceMotion).toBe("off");
	});

	it("rejects unknown values", () => {
		expect(() => parseArgs(["--reduce-motion", "bogus"])).toThrow(
			'--reduce-motion accepts "on", "strict", or "off" (got "bogus")',
		);
	});

	it("defaults reduceMotion to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.reduceMotion).toBeUndefined();
	});

	it("releases flag-looking tokens back to their own handlers", () => {
		const result = parseArgs(["--reduce-motion", "--print", "hello"]);
		expect(result.reduceMotion).toBe("on");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("treats an empty-string token as the bare form", () => {
		const result = parseArgs(["--reduce-motion", ""]);
		expect(result.reduceMotion).toBe("on");
		expect(result.messages).toEqual([""]);
	});
});
