import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isH2UnavailableBeforeDispatch, isTransientTransportError } from "@oh-my-pi/pi-ai/transport";

describe("Cursor shared HTTP/2 transport classification", () => {
	it("recognizes an ALPN negotiation failure as transient", () => {
		const error = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
		expect(isTransientTransportError(error)).toBeTrue();
	});

	it("allows HTTP/1 fallback for the standard unsupported-H2 error", () => {
		const error = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
		expect(isH2UnavailableBeforeDispatch(error)).toBeTrue();
	});

	it("recognizes HTTP/2 stream resets and common socket failures", () => {
		expect(isTransientTransportError(new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"))).toBeTrue();
		expect(isTransientTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBeTrue();
	});

	it("does not replay arbitrary HTTP/2 or authentication failures", () => {
		expect(isTransientTransportError(new Error("HTTP/2 protocol invariant failed"))).toBeFalse();
		expect(isTransientTransportError(Object.assign(new Error("Forbidden"), { status: 403 }))).toBeFalse();
	});
	it("classifies a pre-dispatch connection timeout as unavailable before dispatch", () => {
		// The proxy CONNECT tunnel (and any direct TLS handshake) raises a
		// StreamTimeoutError carrying no `.code`, so it is missed by both the
		// code table and the ALPN/connect regex. It must still trigger fallback.
		const error = new AIError.StreamTimeoutError("Proxy tunnel timed out after 30000ms");
		expect(isH2UnavailableBeforeDispatch(error)).toBeTrue();
	});

	it("does not classify a plain timeout-shaped message without the StreamTimeoutError type", () => {
		// The fix is type-based (establishment-phase StreamTimeoutError), not a
		// broad message match, so a plain Error with the same wording is left alone.
		expect(isH2UnavailableBeforeDispatch(new Error("Proxy tunnel timed out after 30000ms"))).toBeFalse();
	});
});
