import { describe, expect, it } from "bun:test";
import {
	decodeJwtPayload,
	isJwtExpiringWithin,
	JWT_EXPIRY_SKEW_MS,
	jwtExpiryMs,
} from "../../../src/registry/oauth/jwt";

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

describe("isJwtExpiringWithin", () => {
	it("compares exp against the threshold and treats an unreadable token as expiring", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isJwtExpiringWithin(jwt({ exp: now + 3600 }), 300)).toBe(false);
		expect(isJwtExpiringWithin(jwt({ exp: now + 60 }), 300)).toBe(true);
		expect(isJwtExpiringWithin(jwt({ exp: now - 60 }), 300)).toBe(true);

		// Refreshing an opaque credential is the safe direction, so a token with
		// no readable expiry counts as expiring.
		expect(isJwtExpiringWithin("opaque-api-key", 300)).toBe(true);
		expect(isJwtExpiringWithin(jwt({}), 300)).toBe(true);
	});
});
