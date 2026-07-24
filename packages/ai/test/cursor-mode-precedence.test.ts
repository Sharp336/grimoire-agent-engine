import { describe, expect, it } from "bun:test";
import { Http2Config } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { selectMode } from "../src/providers/cursor/server-config";

describe("transport mode selection", () => {
	it("FORCE_ALL_DISABLED forces HTTP/1 regardless of local preference", () => {
		expect(selectMode(Http2Config.FORCE_ALL_DISABLED, false)).toBe("http1");
		expect(selectMode(Http2Config.FORCE_ALL_DISABLED, true)).toBe("http1");
	});

	it("FORCE_BIDI_DISABLED forces HTTP/1", () => {
		expect(selectMode(Http2Config.FORCE_BIDI_DISABLED, false)).toBe("http1");
		expect(selectMode(Http2Config.FORCE_BIDI_DISABLED, true)).toBe("http1");
	});

	it("FORCE_ALL_ENABLED forces HTTP/2 regardless of local preference", () => {
		expect(selectMode(Http2Config.FORCE_ALL_ENABLED, true)).toBe("http2");
		expect(selectMode(Http2Config.FORCE_ALL_ENABLED, false)).toBe("http2");
	});

	it("FORCE_BIDI_ENABLED forces HTTP/2", () => {
		expect(selectMode(Http2Config.FORCE_BIDI_ENABLED, true)).toBe("http2");
		expect(selectMode(Http2Config.FORCE_BIDI_ENABLED, false)).toBe("http2");
	});

	it("UNSPECIFIED defaults to HTTP/2 and honors local preference", () => {
		expect(selectMode(Http2Config.UNSPECIFIED, false)).toBe("http2");
		expect(selectMode(Http2Config.UNSPECIFIED, true)).toBe("http1");
	});

	it("server force outranks local preference", () => {
		expect(selectMode(Http2Config.FORCE_ALL_DISABLED, false)).toBe("http1");
		expect(selectMode(Http2Config.FORCE_ALL_ENABLED, true)).toBe("http2");
	});
});
