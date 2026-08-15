import { createHmac, timingSafeEqual } from "node:crypto";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/** Wire protocol major. Bump when an updated client cannot safely reuse an older broker. */
export const MNEMOPI_EMBED_BROKER_PROTOCOL = 2;

export interface MnemopiEmbedBrokerRequest {
	protocol: typeof MNEMOPI_EMBED_BROKER_PROTOCOL;
	id: string;
	message: MnemopiEmbedWorkerInbound;
	mac: string;
}

export type MnemopiEmbedBrokerResponse =
	| {
			protocol: typeof MNEMOPI_EMBED_BROKER_PROTOCOL;
			id: string;
			ok: true;
			message: MnemopiEmbedWorkerOutbound;
			mac: string;
	  }
	| {
			protocol: typeof MNEMOPI_EMBED_BROKER_PROTOCOL;
			id: string;
			ok: false;
			error: string;
			mac: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function payloadMac(token: string, payload: unknown): string {
	return createHmac("sha256", token).update(JSON.stringify(payload)).digest("hex");
}

function verifyMac(token: string, payload: unknown, received: unknown): void {
	const mac = nonEmptyString(received, "mac");
	const expected = payloadMac(token, payload);
	const receivedBytes = Buffer.from(mac, "hex");
	const expectedBytes = Buffer.from(expected, "hex");
	if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
		throw new Error("Mnemopi embed broker authentication failed");
	}
}

export function parseMnemopiEmbedWorkerInbound(value: unknown): MnemopiEmbedWorkerInbound {
	if (!isRecord(value)) throw new Error("message must be an object");
	const type = nonEmptyString(value.type, "message.type");
	const id = nonEmptyString(value.id, "message.id");
	if (type === "ping") return { type, id };
	const model = nonEmptyString(value.model, "message.model");
	const cacheDir = value.cacheDir === undefined ? undefined : nonEmptyString(value.cacheDir, "message.cacheDir");
	if (type === "init") return { type, id, model, cacheDir };
	if (type !== "embed") throw new Error(`unsupported message.type: ${type}`);
	if (!Array.isArray(value.texts) || !value.texts.every(text => typeof text === "string")) {
		throw new Error("message.texts must be an array of strings");
	}
	const batchSize = value.batchSize;
	if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || Number(batchSize) <= 0)) {
		throw new Error("message.batchSize must be a positive integer");
	}
	return { type, id, model, cacheDir, texts: value.texts, batchSize: batchSize as number | undefined };
}

export function parseMnemopiEmbedWorkerOutbound(value: unknown): MnemopiEmbedWorkerOutbound {
	if (!isRecord(value)) throw new Error("message must be an object");
	const type = nonEmptyString(value.type, "message.type");
	if (type === "log") {
		if (value.level !== "debug" && value.level !== "warn" && value.level !== "error") {
			throw new Error("message.level is invalid");
		}
		const msg = nonEmptyString(value.msg, "message.msg");
		if (value.meta !== undefined && !isRecord(value.meta)) throw new Error("message.meta must be an object");
		return { type, level: value.level, msg, meta: value.meta };
	}
	const id = nonEmptyString(value.id, "message.id");
	if (type === "pong" || type === "ready") return { type, id };
	if (type === "error") return { type, id, error: nonEmptyString(value.error, "message.error") };
	if (type !== "vectors") throw new Error(`unsupported message.type: ${type}`);
	if (
		!Array.isArray(value.vectors) ||
		!value.vectors.every(
			row =>
				Array.isArray(row) && row.every(component => typeof component === "number" && Number.isFinite(component)),
		)
	) {
		throw new Error("message.vectors must be an array of finite number arrays");
	}
	return { type, id, vectors: value.vectors as number[][] };
}

export function encodeMnemopiEmbedBrokerRequest(
	token: string,
	id: string,
	message: MnemopiEmbedWorkerInbound,
): MnemopiEmbedBrokerRequest {
	const payload = { protocol: MNEMOPI_EMBED_BROKER_PROTOCOL, id, message } as const;
	return { ...payload, mac: payloadMac(token, payload) };
}

export function parseMnemopiEmbedBrokerRequest(value: unknown, token: string): MnemopiEmbedBrokerRequest {
	if (!isRecord(value)) throw new Error("broker request must be an object");
	if (value.protocol !== MNEMOPI_EMBED_BROKER_PROTOCOL) {
		throw new Error(`unsupported mnemopi embed broker protocol: ${String(value.protocol)}`);
	}
	const id = nonEmptyString(value.id, "id");
	const payload = { protocol: MNEMOPI_EMBED_BROKER_PROTOCOL, id, message: value.message } as const;
	verifyMac(token, payload, value.mac);
	return {
		protocol: MNEMOPI_EMBED_BROKER_PROTOCOL,
		id,
		message: parseMnemopiEmbedWorkerInbound(value.message),
		mac: nonEmptyString(value.mac, "mac"),
	};
}

export function encodeMnemopiEmbedBrokerResponse(
	token: string,
	response: { id: string; ok: true; message: MnemopiEmbedWorkerOutbound } | { id: string; ok: false; error: string },
): MnemopiEmbedBrokerResponse {
	const normalized =
		response.ok && response.message.type === "vectors"
			? {
					...response,
					message: { ...response.message, vectors: response.message.vectors.map(row => Array.from(row)) },
				}
			: response;
	const payload = { protocol: MNEMOPI_EMBED_BROKER_PROTOCOL, ...normalized } as const;
	return { ...payload, mac: payloadMac(token, payload) };
}

export function parseMnemopiEmbedBrokerResponse(value: unknown, token: string): MnemopiEmbedBrokerResponse {
	if (!isRecord(value)) throw new Error("broker response must be an object");
	if (value.protocol !== MNEMOPI_EMBED_BROKER_PROTOCOL) {
		throw new Error(`unsupported mnemopi embed broker protocol: ${String(value.protocol)}`);
	}
	const id = nonEmptyString(value.id, "id");
	if (value.ok === false) {
		const rawError = value.error;
		const payload = { protocol: MNEMOPI_EMBED_BROKER_PROTOCOL, id, ok: false as const, error: rawError } as const;
		verifyMac(token, payload, value.mac);
		return {
			...payload,
			error: nonEmptyString(rawError, "error"),
			mac: nonEmptyString(value.mac, "mac"),
		};
	}
	if (value.ok !== true) throw new Error("broker response is malformed");
	const rawMessage = value.message;
	const payload = { protocol: MNEMOPI_EMBED_BROKER_PROTOCOL, id, ok: true as const, message: rawMessage } as const;
	verifyMac(token, payload, value.mac);
	return {
		...payload,
		message: parseMnemopiEmbedWorkerOutbound(rawMessage),
		mac: nonEmptyString(value.mac, "mac"),
	};
}
