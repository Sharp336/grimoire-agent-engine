import { describe, expect, it } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { executeHashlineSingle } from "../../src/edit/hashline/execute";
import { parseHashlineEditInput } from "../../src/edit/hashline/parse-input";
import type { ToolSession } from "../../src/tools";

describe("parseHashlineEditInput", () => {
	it("wraps prose-only input in ToolError with hashline guidance", () => {
		expect(() => parseHashlineEditInput("please update MapBuilder.cs for me", "/tmp")).toThrow(ToolError);
		try {
			parseHashlineEditInput("please update MapBuilder.cs for me", "/tmp");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			const message = (error as ToolError).message;
			expect(message).toMatch(/PATH#TAG|anchored edits/i);
			expect(message).toMatch(/python -c|node -e|bun -e/i);
		}
	});
});

describe("executeHashlineSingle prose input", () => {
	it("surfaces ToolError for prose-only edit input", async () => {
		const session = { cwd: "/tmp" } as ToolSession;
		await expect(
			executeHashlineSingle({
				session,
				input: "please update MapBuilder.cs for me",
				writethrough: async () => undefined,
				beginDeferredDiagnosticsForPath: () => ({
					onDeferredDiagnostics: () => {},
					signal: new AbortController().signal,
					finalize: () => {},
				}),
			}),
		).rejects.toThrow(ToolError);
	});
});
