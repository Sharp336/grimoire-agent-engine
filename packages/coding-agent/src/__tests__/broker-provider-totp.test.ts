import { describe, expect, it } from "bun:test";
import {
	base32Decode,
	hotp,
	parseOtpAuth,
	TotpProvider,
	totp,
} from "../secrets/broker/provider-totp";

// RFC 6238 Appendix B seed (ASCII "12345678901234567890").
const RFC_SEED = Buffer.from("12345678901234567890", "ascii");

describe("Phase C Task C4: TOTP primitives", () => {
	it("RFC 6238 SHA1 8-digit test vectors", () => {
		expect(hotp(RFC_SEED, BigInt(Math.floor(59 / 30)), 8)).toBe("94287082");
		expect(hotp(RFC_SEED, BigInt(Math.floor(1111111109 / 30)), 8)).toBe("07081804");
		expect(hotp(RFC_SEED, BigInt(Math.floor(1111111111 / 30)), 8)).toBe("14050471");
		expect(hotp(RFC_SEED, BigInt(Math.floor(1234567890 / 30)), 8)).toBe("89005924");
	});

	it("totp generates 6-digit codes by default", () => {
		const code = totp(RFC_SEED, 59_000);
		expect(code).toMatch(/^\d{6}$/);
		expect(code).toBe("287082");
	});

	it("base32Decode round-trips the RFC 4648 vector", () => {
		expect(base32Decode("JBSWY3DPEE======").toString()).toBe("Hello!");
		expect(base32Decode("JBSWY3DPEE").toString()).toBe("Hello!");
	});

	it("base32Decode throws on invalid characters", () => {
		expect(() => base32Decode("not!base32")).toThrow();
	});

	it("parseOtpAuth parses secret/digits/period", () => {
		const params = parseOtpAuth("otpauth://totp/example?secret=JBSWY3DPEE&digits=8&period=60");
		expect(params.secret.toString()).toBe("Hello!");
		expect(params.digits).toBe(8);
		expect(params.period).toBe(60);
		expect(params.algorithm).toBe("SHA1");
	});

	it("parseOtpAuth fails closed on non-SHA1 algorithm", () => {
		expect(() => parseOtpAuth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512")).toThrow(
			/algorithm/i,
		);
	});

	it("parseOtpAuth fails closed on missing secret", () => {
		expect(() => parseOtpAuth("otpauth://totp/x")).toThrow(/secret/i);
	});
});

describe("Phase C Task C4: TotpProvider", () => {
	function fakeBitwarden(totpField: string | null) {
		return {
			isAvailable: async () => true,
			getItemJson: async (_itemId: string) => ({
				login: totpField === null ? {} : { totp: totpField },
			}),
		};
	}

	it("resolve() generates the correct code from an otpauth URL seed", async () => {
		const secretB32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		const provider = new TotpProvider({
			bitwarden: fakeBitwarden(`otpauth://totp/example?secret=${secretB32}`),
			now: () => 59_000,
		});
		const result = await provider.resolve({ provider: "totp", itemId: "fake-item-id" });
		expect(result.value).toBe("287082");
		expect(result.expiresAt).toBe(60_000);
	});

	it("resolve() accepts a raw base32 seed (no otpauth URL)", async () => {
		const secretB32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		const provider = new TotpProvider({
			bitwarden: fakeBitwarden(secretB32),
			now: () => 59_000,
		});
		const result = await provider.resolve({ provider: "totp", itemId: "fake-item-id" });
		expect(result.value).toBe("287082");
	});

	it("resolve() fails closed when the item has no TOTP seed", async () => {
		const provider = new TotpProvider({ bitwarden: fakeBitwarden(null), now: () => 59_000 });
		await expect(provider.resolve({ provider: "totp", itemId: "fake-item-id" })).rejects.toThrow(/TOTP|seed/i);
	});

	it("resolve() fails closed on a malformed seed", async () => {
		const provider = new TotpProvider({ bitwarden: fakeBitwarden("not-valid-base32!!!"), now: () => 59_000 });
		await expect(provider.resolve({ provider: "totp", itemId: "fake-item-id" })).rejects.toThrow();
	});

	it("resolve() throws on a wrong-provider handle", async () => {
		const provider = new TotpProvider({ bitwarden: fakeBitwarden(null), now: () => 59_000 });
		await expect(provider.resolve({ provider: "bitwarden", itemId: "x" })).rejects.toThrow(/wrong provider/i);
	});

	it("expiresAt is the end of the current 30s step", async () => {
		const provider = new TotpProvider({
			bitwarden: fakeBitwarden("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
			now: () => 45_000,
		});
		const result = await provider.resolve({ provider: "totp", itemId: "fake-item-id" });
		expect(result.expiresAt).toBe(60_000);
	});
});
