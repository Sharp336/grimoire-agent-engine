import { describe, expect, it } from "bun:test";
import { sanitizeCursorCallerHeaders } from "@oh-my-pi/pi-ai/providers/cursor";

// Cursor now forwards caller headers (including `before_provider_headers`
// extension edits), and it speaks HTTP/2. Node's `http2.request()` THROWS on
// pseudo-headers and on the HTTP/1 connection-specific headers HTTP/2 forbids,
// rather than dropping them, so anything that slips through here does not
// degrade the request, it kills it.

describe("sanitizeCursorCallerHeaders", () => {
	it("keeps ordinary caller headers", () => {
		expect(sanitizeCursorCallerHeaders({ "x-trace": "abc", "x-waygate-activity": "mode=plan" })).toEqual({
			"x-trace": "abc",
			"x-waygate-activity": "mode=plan",
		});
	});

	it("drops HTTP/2 pseudo-headers, which belong to the transport", () => {
		expect(sanitizeCursorCallerHeaders({ ":path": "/evil", ":method": "GET", "x-keep": "1" })).toEqual({
			"x-keep": "1",
		});
	});

	it("drops every connection-specific header HTTP/2 forbids", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			connection: "keep-alive",
			"keep-alive": "timeout=5",
			"proxy-connection": "keep-alive",
			"transfer-encoding": "chunked",
			upgrade: "h2c",
			"http2-settings": "AAMAAABkAAQAoAAAAAIAAAAA",
			"x-keep": "1",
		});
		expect(sanitized).toEqual({ "x-keep": "1" });
	});

	it("matches forbidden names case-insensitively", () => {
		expect(sanitizeCursorCallerHeaders({ Connection: "close", "Transfer-Encoding": "chunked" })).toEqual({});
	});

	it("handles absent headers", () => {
		expect(sanitizeCursorCallerHeaders(undefined)).toEqual({});
	});
});
