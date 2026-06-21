/**
 * AES-GCM encrypted local cache for broker-served model catalogs.
 *
 * The catalog is sanitized before it leaves the broker, but it still controls
 * outbound routing. Bind the cache to broker URL + bearer token so a copied file
 * cannot silently retarget another gateway client.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { ModelsConfigResponse } from "./types";
import { modelsConfigResponseSchema } from "./wire-schemas";

const MAGIC = new Uint8Array([0x4f, 0x4d, 0x50, 0x43]); // "OMPC"
const VERSION = 1;
const VERSION_OFFSET = MAGIC.byteLength;
const IV_OFFSET = VERSION_OFFSET + 1;
const IV_LENGTH = 12;
const HEADER_LENGTH = IV_OFFSET + IV_LENGTH;
const AES_ALGORITHM = "AES-GCM";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const HEX = "0123456789abcdef";

export const DEFAULT_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReadAuthBrokerCatalogCacheOptions {
	path: string;
	token: string;
	url: string;
	ttlMs: number;
	now?: () => number;
}

export interface WriteAuthBrokerCatalogCacheOptions {
	path: string;
	token: string;
	url: string;
	catalog: ModelsConfigResponse;
}

export async function readAuthBrokerCatalogCache(
	opts: ReadAuthBrokerCatalogCacheOptions,
): Promise<ModelsConfigResponse | null> {
	if (opts.ttlMs <= 0) return null;
	let data: Uint8Array;
	try {
		data = await fs.readFile(opts.path);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	try {
		const plaintext = await decryptCachePayload(data, opts.token, opts.url);
		if (!plaintext) return null;
		const parsed: unknown = JSON.parse(TEXT_DECODER.decode(plaintext));
		const result = modelsConfigResponseSchema(parsed);
		if (result instanceof type.errors) {
			logger.debug("auth-broker catalog cache schema invalid", { path: opts.path });
			return null;
		}
		const catalog = result as ModelsConfigResponse;
		const now = opts.now?.() ?? Date.now();
		if (now - catalog.generatedAt > opts.ttlMs) return null;
		return catalog;
	} catch (error) {
		logger.debug("auth-broker catalog cache read failed", { path: opts.path, error: String(error) });
		return null;
	}
}

export async function writeAuthBrokerCatalogCache(opts: WriteAuthBrokerCatalogCacheOptions): Promise<void> {
	const payload = await encryptCachePayload(opts.catalog, opts.token, opts.url);
	await fs.mkdir(path.dirname(opts.path), { recursive: true });
	const tmpPath = `${opts.path}.${process.pid}.${randomHex(8)}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.open(tmpPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(payload);
		} finally {
			await handle.close();
		}
		await fs.chmod(tmpPath, 0o600);
		await fs.rename(tmpPath, opts.path);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.rm(tmpPath, { force: true }).catch(() => {});
	}
}

async function encryptCachePayload(catalog: ModelsConfigResponse, token: string, url: string): Promise<Uint8Array> {
	const key = await deriveAesKey(token, ["encrypt"]);
	const iv = new Uint8Array(IV_LENGTH);
	globalThis.crypto.getRandomValues(iv);
	const plaintext = TEXT_ENCODER.encode(JSON.stringify(catalog));
	const ciphertext = new Uint8Array(
		await globalThis.crypto.subtle.encrypt(
			{
				name: AES_ALGORITHM,
				iv,
				additionalData: TEXT_ENCODER.encode(url),
			},
			key,
			plaintext,
		),
	);
	const payload = new Uint8Array(HEADER_LENGTH + ciphertext.byteLength);
	payload.set(MAGIC, 0);
	payload[VERSION_OFFSET] = VERSION;
	payload.set(iv, IV_OFFSET);
	payload.set(ciphertext, HEADER_LENGTH);
	return payload;
}

async function decryptCachePayload(data: Uint8Array, token: string, url: string): Promise<Uint8Array | null> {
	if (data.byteLength <= HEADER_LENGTH) {
		logger.debug("auth-broker catalog cache file too short");
		return null;
	}
	for (let i = 0; i < MAGIC.byteLength; i++) {
		if (data[i] !== MAGIC[i]) {
			logger.debug("auth-broker catalog cache magic mismatch");
			return null;
		}
	}
	if (data[VERSION_OFFSET] !== VERSION) {
		logger.debug("auth-broker catalog cache version mismatch", { version: data[VERSION_OFFSET] });
		return null;
	}
	const key = await deriveAesKey(token, ["decrypt"]);
	const iv = asStrict(data.subarray(IV_OFFSET, HEADER_LENGTH));
	const ciphertext = asStrict(data.subarray(HEADER_LENGTH));
	try {
		return new Uint8Array(
			await globalThis.crypto.subtle.decrypt(
				{
					name: AES_ALGORITHM,
					iv,
					additionalData: TEXT_ENCODER.encode(url),
				},
				key,
				ciphertext,
			),
		);
	} catch (error) {
		logger.debug("auth-broker catalog cache decrypt failed", { error: String(error) });
		return null;
	}
}

async function deriveAesKey(token: string, usages: Array<"encrypt" | "decrypt">): Promise<CryptoKey> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(token));
	return globalThis.crypto.subtle.importKey("raw", digest, AES_ALGORITHM, false, usages);
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
	return out;
}
