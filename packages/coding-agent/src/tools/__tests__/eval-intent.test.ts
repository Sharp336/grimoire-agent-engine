import { describe, expect, it } from "bun:test";
import { EvalTool } from "../eval";

describe("EvalTool.intent", () => {
	it("returns 'running python' for a py cell", () => {
		const tool = new EvalTool(null);
		expect(tool.intent({ language: "py" })).toBe("running python");
	});

	it("returns the title when provided, regardless of language", () => {
		const tool = new EvalTool(null);
		expect(tool.intent({ language: "py", title: "load config" })).toBe("load config");
	});

	it("does not fall back to 'running javascript' when language is missing (partial stream)", () => {
		const tool = new EvalTool(null);
		// During streaming, args.language is often undefined before the full JSON parses.
		// The old default was "javascript" — wrong for Python cells.
		const result = tool.intent({});
		expect(result).not.toBe("running javascript");
		expect(result).toBe("running eval");
	});
});
