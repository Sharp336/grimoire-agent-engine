import { describe, expect, it } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { scrubBrowserToolResult } from "../secrets/broker/secret-broker-extension";

describe("Phase C Task C1b: tainted-session browser-tool output scrubbing", () => {
	it("scrubs text blocks containing a tainted value; leaves unrelated text and images untouched", () => {
		const taint = new Set(["supersecret-value-1234"]);
		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: "field value: supersecret-value-1234" },
			{ type: "text", text: "unrelated page text" },
			{ type: "image", data: "base64-bytes", mimeType: "image/png" } as ImageContent,
		];
		const out = scrubBrowserToolResult(content, taint);
		expect(out).toHaveLength(3);
		expect((out[0] as TextContent).text).toBe("field value: [REDACTED]");
		expect((out[1] as TextContent).text).toBe("unrelated page text");
		expect((out[2] as ImageContent).data).toBe("base64-bytes");
	});

	it("returns content unchanged when the taint set is empty (no credentials loaded)", () => {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "supersecret-value-1234 appears here" }];
		const out = scrubBrowserToolResult(content, new Set());
		expect((out[0] as TextContent).text).toBe("supersecret-value-1234 appears here");
	});

	it("handles string-typed text content (some tool results use raw strings)", () => {
		const taint = new Set(["supersecret-value-1234"]);
		// AgentMessage text blocks can be string-shaped in some flows; the scrubber
		// must not throw on either shape.
		const content = [{ type: "text", text: "value=supersecret-value-1234" }] as unknown as (
			| TextContent
			| ImageContent
		)[];
		const out = scrubBrowserToolResult(content, taint);
		expect((out[0] as TextContent).text).toBe("value=[REDACTED]");
	});

	it("scrubs base64-encoded variants of the tainted value (scrubOutput defense-in-depth)", () => {
		const value = "supersecret-value-1234";
		const taint = new Set([value]);
		const b64 = Buffer.from(value).toString("base64");
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: `encoded: ${b64}` }];
		const out = scrubBrowserToolResult(content, taint);
		expect((out[0] as TextContent).text).toContain("[REDACTED]");
		expect((out[0] as TextContent).text).not.toContain(b64);
	});
});
