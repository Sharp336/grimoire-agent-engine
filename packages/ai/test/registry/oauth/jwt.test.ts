import { describe, expect, it } from "bun:test";
import { isCursorTokenExpiringSoon } from "../../../src/registry/oauth/cursor";
import { decodeJwtPayload, JWT_EXPIRY_SKEW_MS, jwtExpiryMs, jwtExpirySeconds } from "../../../src/registry/oauth/jwt";

function jwt(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("decodeJwtPayload", () => {
	it("decodes a payload using the URL-safe base64 alphabet", () => {
		// JWT payloads are base64url, so the decoder must accept `-` and `_`.
		// `??~` forces both substitutions. Bare `atob` throws on this input,
		// which is why the descriptors that used it unescaped by hand first.
		const payload = { sub: "??~", exp: 1_900_000_000 };
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		expect(encoded).toMatch(/[-_]/);

		expect(decodeJwtPayload(`header.${encoded}.signature`)).toEqual(payload);
	});

	it("rejects everything that is not a three-segment JSON-object token", () => {
		expect(decodeJwtPayload("not-a-jwt")).toBeNull();
		expect(decodeJwtPayload("two.segments")).toBeNull();
		expect(decodeJwtPayload("header..signature")).toBeNull();
		expect(decodeJwtPayload("header.%%%.signature")).toBeNull();
		// A bare array or scalar payload is structurally valid base64url JSON but
		// is not a claims object, so callers never see one.
		expect(decodeJwtPayload(`header.${Buffer.from("[1,2]").toString("base64url")}.signature`)).toBeNull();
		expect(decodeJwtPayload(`header.${Buffer.from('"str"').toString("base64url")}.signature`)).toBeNull();
	});
});

describe("jwtExpiryMs", () => {
	it("applies the skew to a finite exp and reports undefined otherwise", () => {
		const exp = 1_900_000_000;
		expect(jwtExpiryMs(jwt({ exp }))).toBe(exp * 1000 - JWT_EXPIRY_SKEW_MS);
		expect(jwtExpiryMs(jwt({ exp }), 0)).toBe(exp * 1000);

		expect(jwtExpiryMs(jwt({}))).toBeUndefined();
		expect(jwtExpiryMs(jwt({ exp: "soon" }))).toBeUndefined();
		expect(jwtExpiryMs(jwt({ exp: Number.POSITIVE_INFINITY }))).toBeUndefined();
		expect(jwtExpiryMs("opaque-api-key")).toBeUndefined();
	});
});

describe("jwtExpirySeconds", () => {
	it("reports the raw exp only when it is finite, leaving the meaning to callers", () => {
		const exp = 1_900_000_000;
		expect(jwtExpirySeconds(jwt({ exp }))).toBe(exp);

		// Absence is reported as `undefined` rather than resolved here: Cursor
		// reads it as "not expiring", other callers as "refresh now".
		expect(jwtExpirySeconds(jwt({}))).toBeUndefined();
		expect(jwtExpirySeconds(jwt({ exp: "soon" }))).toBeUndefined();
		expect(jwtExpirySeconds("opaque-api-key")).toBeUndefined();
	});
});

describe("isCursorTokenExpiringSoon", () => {
	it("refreshes only on a real deadline or an unreadable payload", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isCursorTokenExpiringSoon(jwt({ exp: now + 3600 }))).toBe(false);
		expect(isCursorTokenExpiringSoon(jwt({ exp: now + 60 }))).toBe(true);

		// A decodable payload that states no usable deadline must NOT trigger a
		// refresh — Cursor accepts long-lived pasted keys, and churning those on
		// every request is the regression this pins.
		expect(isCursorTokenExpiringSoon(jwt({}))).toBe(false);
		expect(isCursorTokenExpiringSoon(jwt({ exp: "soon" }))).toBe(false);

		// A payload that cannot be read at all still forces a refresh.
		expect(isCursorTokenExpiringSoon("opaque-api-key")).toBe(true);
		expect(isCursorTokenExpiringSoon("header.%%%.signature")).toBe(true);
	});
});
