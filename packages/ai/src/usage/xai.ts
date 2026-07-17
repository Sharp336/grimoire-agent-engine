import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
} from "../usage";

const XAI_OAUTH_PROVIDER = "xai-oauth";
const GROK_BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const EMPTY_GRPC_WEB_MESSAGE = new Uint8Array(5);
const MIN_UNIX_TIMESTAMP_SECONDS = 1_700_000_000;
const MAX_UNIX_TIMESTAMP_SECONDS = 2_100_000_000;
const MAX_PROTOBUF_DEPTH = 4;

interface ProtobufFixed32Field {
	path: number[];
	value: number;
	order: number;
}

interface ProtobufVarintField {
	path: number[];
	value: number;
}

interface ProtobufScan {
	fixed32Fields: ProtobufFixed32Field[];
	varintFields: ProtobufVarintField[];
	nextOrder: number;
}

export interface GrokUsageSnapshot {
	usedPercent: number;
	resetsAt?: number;
}

function readVarint(bytes: Uint8Array, cursor: { index: number }): number | undefined {
	let value = 0;
	let multiplier = 1;
	for (let count = 0; cursor.index < bytes.length && count < 10; count++) {
		const byte = bytes[cursor.index++];
		value += (byte & 0x7f) * multiplier;
		if ((byte & 0x80) === 0) return Number.isSafeInteger(value) ? value : undefined;
		multiplier *= 128;
	}
	return undefined;
}

function scanProtobuf(bytes: Uint8Array, depth: number, path: number[], scan: ProtobufScan): void {
	const cursor = { index: 0 };
	while (cursor.index < bytes.length) {
		const fieldStart = cursor.index;
		const key = readVarint(bytes, cursor);
		if (key === undefined || key === 0) {
			cursor.index = fieldStart + 1;
			continue;
		}
		const fieldNumber = Math.floor(key / 8);
		const wireType = key & 0x07;
		const fieldPath = [...path, fieldNumber];
		switch (wireType) {
			case 0: {
				const value = readVarint(bytes, cursor);
				if (value === undefined) cursor.index = fieldStart + 1;
				else scan.varintFields.push({ path: fieldPath, value });
				break;
			}
			case 1:
				if (cursor.index + 8 > bytes.length) return;
				cursor.index += 8;
				break;
			case 2: {
				const length = readVarint(bytes, cursor);
				if (length === undefined || length < 0 || cursor.index + length > bytes.length) {
					cursor.index = fieldStart + 1;
					break;
				}
				const end = cursor.index + length;
				if (depth < MAX_PROTOBUF_DEPTH) {
					scanProtobuf(bytes.subarray(cursor.index, end), depth + 1, fieldPath, scan);
				}
				cursor.index = end;
				break;
			}
			case 5: {
				if (cursor.index + 4 > bytes.length) return;
				const view = new DataView(bytes.buffer, bytes.byteOffset + cursor.index, 4);
				scan.fixed32Fields.push({ path: fieldPath, value: view.getFloat32(0, true), order: scan.nextOrder++ });
				cursor.index += 4;
				break;
			}
			default:
				cursor.index = fieldStart + 1;
		}
	}
}

function looksLikeProtobuf(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return false;
	const fieldNumber = bytes[0] >> 3;
	const wireType = bytes[0] & 0x07;
	return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
}

function decodeGrpcWebFrames(bytes: Uint8Array): { payloads: Uint8Array[]; trailers: Map<string, string> } | null {
	const payloads: Uint8Array[] = [];
	const trailers = new Map<string, string>();
	let index = 0;
	while (index < bytes.length) {
		if (index + 5 > bytes.length) return null;
		const flags = bytes[index];
		const length =
			bytes[index + 1] * 0x1000000 + bytes[index + 2] * 0x10000 + bytes[index + 3] * 0x100 + bytes[index + 4];
		const start = index + 5;
		const end = start + length;
		if (end > bytes.length) return null;
		if ((flags & 0x80) === 0) {
			payloads.push(bytes.subarray(start, end));
		} else {
			const text = new TextDecoder().decode(bytes.subarray(start, end));
			for (const line of text.split(/\r?\n/)) {
				const separator = line.indexOf(":");
				if (separator <= 0) continue;
				const key = line.slice(0, separator).trim().toLowerCase();
				const rawValue = line.slice(separator + 1).trim();
				let value = rawValue;
				try {
					value = decodeURIComponent(rawValue);
				} catch {
					// Keep malformed percent-encoding verbatim so the upstream error remains visible.
				}
				trailers.set(key, value);
			}
		}
		index = end;
	}
	return { payloads, trailers };
}

function assertGrpcStatus(status: string | null | undefined, message?: string | null): void {
	if (status === null || status === undefined || status === "" || status === "0") return;
	throw new Error(`Grok billing RPC failed with status ${status}${message ? `: ${message}` : ""}`);
}

function samePath(path: number[], expected: readonly number[]): boolean {
	return path.length === expected.length && path.every((value, index) => value === expected[index]);
}

export function parseGrokUsageResponse(bytes: Uint8Array, nowMs: number = Date.now()): GrokUsageSnapshot {
	const decoded = decodeGrpcWebFrames(bytes);
	let payloads: Uint8Array[];
	if (decoded) {
		assertGrpcStatus(decoded.trailers.get("grpc-status"), decoded.trailers.get("grpc-message"));
		if (decoded.payloads.length === 0) throw new Error("Grok billing returned no valid protobuf payload");
		payloads = decoded.payloads;
	} else if (looksLikeProtobuf(bytes)) {
		payloads = [bytes];
	} else {
		throw new Error("Grok billing returned no valid protobuf payload");
	}

	const scan: ProtobufScan = { fixed32Fields: [], varintFields: [], nextOrder: 0 };
	for (const payload of payloads) scanProtobuf(payload, 0, [], scan);

	const percentField = scan.fixed32Fields
		.filter(
			field => field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100,
		)
		.sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0];
	const resetCandidates = scan.varintFields
		.filter(field => field.value >= MIN_UNIX_TIMESTAMP_SECONDS && field.value <= MAX_UNIX_TIMESTAMP_SECONDS)
		.map(field => ({ ...field, resetsAt: field.value * 1000 }))
		.filter(field => field.resetsAt > nowMs);
	const preferredReset = resetCandidates
		.filter(field => samePath(field.path, [1, 5, 1]))
		.sort((left, right) => left.resetsAt - right.resetsAt)[0];
	const fallbackReset = resetCandidates.sort((left, right) => left.resetsAt - right.resetsAt)[0];
	const resetsAt = preferredReset?.resetsAt ?? fallbackReset?.resetsAt;
	const hasUsagePeriod = scan.varintFields.some(
		field =>
			(field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6) ||
			(samePath(field.path, [1, 8, 1]) && (field.value === 1 || field.value === 2)),
	);
	const usedPercent =
		percentField?.value ?? (scan.fixed32Fields.length === 0 && resetsAt && hasUsagePeriod ? 0 : undefined);
	if (usedPercent === undefined) throw new Error("Could not parse Grok billing usage");
	return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function resolveStatus(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

async function fetchXaiOAuthUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const accessToken = params.credential.accessToken;
	if (params.provider !== XAI_OAUTH_PROVIDER || params.credential.type !== "oauth" || !accessToken) return null;
	const response = await ctx.fetch(GROK_BILLING_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Origin: "https://grok.com",
			Referer: "https://grok.com/?_s=usage",
			Accept: "*/*",
			"Content-Type": "application/grpc-web+proto",
			"x-grpc-web": "1",
			"x-user-agent": "connect-es/2.1.1",
			"User-Agent": "oh-my-pi/xai",
		},
		body: EMPTY_GRPC_WEB_MESSAGE,
		signal: params.signal,
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 400);
		throw new Error(`Grok billing request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	assertGrpcStatus(response.headers.get("grpc-status"), response.headers.get("grpc-message"));
	const snapshot = parseGrokUsageResponse(new Uint8Array(await response.arrayBuffer()));
	const usedFraction = snapshot.usedPercent / 100;
	const remainingPercent = Math.max(0, 100 - snapshot.usedPercent);
	const limit: UsageLimit = {
		id: "xai-oauth:grok-credits",
		label: "Grok Credits",
		scope: {
			provider: XAI_OAUTH_PROVIDER,
			...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
			windowId: "grok-credits",
			shared: true,
		},
		window: {
			id: "grok-credits",
			label: "Current Period",
			...(snapshot.resetsAt !== undefined ? { resetsAt: snapshot.resetsAt } : {}),
		},
		amount: {
			used: snapshot.usedPercent,
			limit: 100,
			remaining: remainingPercent,
			usedFraction,
			remainingFraction: remainingPercent / 100,
			unit: "percent",
		},
		status: resolveStatus(usedFraction),
	};
	return {
		provider: XAI_OAUTH_PROVIDER,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: {
			...(params.credential.email ? { email: params.credential.email } : {}),
			...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
		},
	};
}

export const xaiOAuthUsageProvider: UsageProvider = {
	id: XAI_OAUTH_PROVIDER,
	supports: params =>
		params.provider === XAI_OAUTH_PROVIDER && params.credential.type === "oauth" && !!params.credential.accessToken,
	fetchUsage: fetchXaiOAuthUsage,
	validatesCredentials: true,
};
