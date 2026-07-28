import { createHmac } from "node:crypto";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";
import type { BitwardenProvider } from "./provider-bitwarden";

/**
 * Phase C Task C4 — TOTP provider (RFC 6238, no dependencies).
 *
 * The rotation flow's 2FA half: the agent orchestrates; it never sees the
 * seed OR the code. The seed resolves from the Bitwarden item's
 * `login.totp` field (otpauth:// URL or raw base32); the code is
 * generated broker-side with node:crypto and injected like any other
 * secret. Fail-closed (R2): missing/malformed seed, non-SHA1 algorithm,
 * or any resolution error throws.
 */

// ─── RFC 6238 HOTP/TOTP ─────────────────────────────────────────────────────

export function hotp(secret: Buffer, counter: bigint, digits: number): string {
	const counterBytes = Buffer.alloc(8);
	counterBytes.writeBigUInt64BE(counter);
	const digest = createHmac("sha1", secret).update(counterBytes).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	const value = binary % 10 ** digits;
	return String(value).padStart(digits, "0");
}

export function totp(secret: Buffer, timeMs: number, period = 30, digits = 6): string {
	const counter = BigInt(Math.floor(timeMs / 1000 / period));
	return hotp(secret, counter, digits);
}

// ─── RFC 4648 base32 ────────────────────────────────────────────────────────

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
	const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
	if (clean.length === 0) throw new Error("base32: empty input");
	const bits: number[] = [];
	for (const ch of clean) {
		const value = B32_ALPHABET.indexOf(ch);
		if (value === -1) throw new Error(`base32: invalid character "${ch}"`);
		for (let i = 4; i >= 0; i--) bits.push((value >> i) & 1);
	}
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
		bytes.push(byte);
	}
	return Buffer.from(bytes);
}

// ─── otpauth:// URL parsing ─────────────────────────────────────────────────

export interface TotpParams {
	secret: Buffer;
	digits: number;
	period: number;
	algorithm: string;
}

export function parseOtpAuth(url: string): TotpParams {
	const parsed = new URL(url);
	if (parsed.protocol !== "otpauth:") {
		throw new Error(`unsupported TOTP scheme: ${parsed.protocol}`);
	}
	const secretParam = parsed.searchParams.get("secret");
	if (!secretParam) {
		throw new Error("otpauth URL missing secret parameter");
	}
	const algorithm = (parsed.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
	if (algorithm !== "SHA1") {
		throw new Error(`unsupported TOTP algorithm: ${algorithm} (only SHA1 supported)`);
	}
	const digits = Number.parseInt(parsed.searchParams.get("digits") ?? "6", 10);
	const period = Number.parseInt(parsed.searchParams.get("period") ?? "30", 10);
	if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
		throw new Error(`unsupported TOTP digits: ${digits}`);
	}
	if (!Number.isInteger(period) || period <= 0) {
		throw new Error(`unsupported TOTP period: ${period}`);
	}
	return { secret: base32Decode(secretParam), digits, period, algorithm };
}

// ─── Provider ───────────────────────────────────────────────────────────────

interface BitwardenSeedSource {
	isAvailable(): Promise<boolean>;
	getItemJson(itemId: string): Promise<unknown>;
}

export class TotpProvider implements VaultProvider {
	readonly name = "totp";
	readonly #bitwarden: BitwardenSeedSource;
	readonly #now: () => number;

	constructor(opts: { bitwarden: BitwardenSeedSource; now?: () => number }) {
		this.#bitwarden = opts.bitwarden;
		this.#now = opts.now ?? Date.now;
	}

	async isAvailable(): Promise<boolean> {
		return this.#bitwarden.isAvailable();
	}

	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (handle.provider !== "totp") {
			throw new Error(`TotpProvider: wrong provider "${handle.provider}"`);
		}
		const item = (await this.#bitwarden.getItemJson(handle.itemId)) as
			| { login?: { totp?: string } }
			| null
			| undefined;
		const totpField = item?.login?.totp;
		if (typeof totpField !== "string" || totpField.length === 0) {
			throw new Error(`TotpProvider: item ${handle.itemId} has no TOTP seed (login.totp is empty)`);
		}
		const params = totpField.startsWith("otpauth://")
			? parseOtpAuth(totpField)
			: { secret: base32Decode(totpField), digits: 6, period: 30, algorithm: "SHA1" };
		const now = this.#now();
		const code = totp(params.secret, now, params.period, params.digits);
		const expiresAt = (Math.floor(now / 1000 / params.period) + 1) * params.period * 1000;
		return { handle, value: code, expiresAt };
	}
}

export type { BitwardenProvider };
