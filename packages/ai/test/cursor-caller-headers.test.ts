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

	// A caller spelling differing only in case does not OVERRIDE the fixed header,
	// it duplicates it, and node rejects the request rather than picking one.
	it("drops caller copies of headers the request sets itself, in any casing", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			Authorization: "Bearer stolen",
			TE: "gzip",
			"Content-Type": "text/plain",
			"X-Request-Id": "forged",
			"x-ghost-mode": "false",
			"x-keep": "1",
		});
		expect(sanitized).toEqual({ "x-keep": "1" });
	});

	// HTTP/2 field names are lower-case, so the surviving names are normalized and
	// two caller spellings of one field collapse instead of duplicating.
	it("lower-cases surviving names", () => {
		expect(sanitizeCursorCallerHeaders({ "X-Trace": "abc" })).toEqual({ "x-trace": "abc" });
	});

	it("handles absent headers", () => {
		expect(sanitizeCursorCallerHeaders(undefined)).toEqual({});
	});
});
