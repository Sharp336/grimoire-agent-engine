import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { parseGrokUsageResponse, xaiOAuthUsageProvider } from "@oh-my-pi/pi-ai/usage/xai";

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function encodeVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = remaining % 128;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) byte |= 0x80;
		bytes.push(byte);
	} while (remaining > 0);
	return Uint8Array.from(bytes);
}

function encodeMessageField(fieldNumber: number, payload: Uint8Array): Uint8Array {
	return concatBytes(encodeVarint(fieldNumber * 8 + 2), encodeVarint(payload.length), payload);
}

function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
	return concatBytes(encodeVarint(fieldNumber * 8), encodeVarint(value));
}

function encodeFixed32Field(fieldNumber: number, value: number): Uint8Array {
	const bytes = new Uint8Array(5);
	bytes[0] = fieldNumber * 8 + 5;
	new DataView(bytes.buffer).setFloat32(1, value, true);
	return bytes;
}

function grpcWebFrame(payload: Uint8Array, flags: number = 0): Uint8Array {
	const frame = new Uint8Array(payload.length + 5);
	frame[0] = flags;
	new DataView(frame.buffer).setUint32(1, payload.length, false);
	frame.set(payload, 5);
	return frame;
}

function grokUsageResponse(usedPercent: number, preferredResetSeconds: number): Uint8Array {
	const fallbackReset = encodeMessageField(7, encodeVarintField(1, preferredResetSeconds - 3600));
	const preferredReset = encodeMessageField(5, encodeVarintField(1, preferredResetSeconds));
	const payload = encodeMessageField(
		1,
		concatBytes(encodeFixed32Field(1, usedPercent), fallbackReset, preferredReset),
	);
	const trailers = grpcWebFrame(new TextEncoder().encode("grpc-status: 0\r\n"), 0x80);
	return concatBytes(grpcWebFrame(payload), trailers);
}

function oauthParams(): UsageFetchParams {
	return {
		provider: "xai-oauth",
		credential: {
			type: "oauth",
			accessToken: "grok-test-token",
			email: "grok@example.com",
			accountId: "grok-account",
		},
	};
}

describe("xAI Grok OAuth usage provider", () => {
	it("fetches and normalizes Grok subscription credits", async () => {
		const resetSeconds = 2_000_000_000;
		let requestedUrl = "";
		let requestedInit: RequestInit | undefined;
		const fetch: FetchImpl = async (input, init) => {
			requestedUrl = String(input);
			requestedInit = init;
			return new Response(grokUsageResponse(92.5, resetSeconds), {
				status: 200,
				headers: { "content-type": "application/grpc-web+proto" },
			});
		};
		const report = await xaiOAuthUsageProvider.fetchUsage(oauthParams(), { fetch });

		expect(requestedUrl).toBe("https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig");
		expect(requestedInit?.method).toBe("POST");
		expect(Array.from(requestedInit?.body as Uint8Array)).toEqual([0, 0, 0, 0, 0]);
		const headers = new Headers(requestedInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer grok-test-token");
		expect(headers.get("origin")).toBe("https://grok.com");
		expect(headers.get("referer")).toBe("https://grok.com/?_s=usage");
		expect(headers.get("content-type")).toBe("application/grpc-web+proto");
		expect(headers.get("x-grpc-web")).toBe("1");
		expect(headers.get("x-user-agent")).toBe("connect-es/2.1.1");
		expect(report?.provider).toBe("xai-oauth");
		expect(report?.metadata).toEqual({ email: "grok@example.com", accountId: "grok-account" });
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]).toMatchObject({
			id: "xai-oauth:grok-credits",
			label: "Grok Credits",
			status: "warning",
			window: { id: "grok-credits", label: "Current Period", resetsAt: resetSeconds * 1000 },
			amount: {
				used: 92.5,
				limit: 100,
				remaining: 7.5,
				usedFraction: 0.925,
				remainingFraction: 0.075,
				unit: "percent",
			},
		});
	});

	it("prefers the documented reset path over an earlier fallback timestamp", () => {
		const resetSeconds = 2_000_000_000;
		expect(parseGrokUsageResponse(grokUsageResponse(25, resetSeconds), 1_900_000_000_000)).toEqual({
			usedPercent: 25,
			resetsAt: resetSeconds * 1000,
		});
	});

	it("rejects non-zero gRPC trailers", () => {
		const payload = encodeMessageField(1, encodeFixed32Field(1, 25));
		const trailers = grpcWebFrame(
			new TextEncoder().encode("grpc-status: 16\r\ngrpc-message: unauthenticated\r\n"),
			0x80,
		);
		expect(() => parseGrokUsageResponse(concatBytes(grpcWebFrame(payload), trailers))).toThrow(
			/Grok billing RPC failed with status 16: unauthenticated/,
		);
		expect(() => parseGrokUsageResponse(trailers)).toThrow(/Grok billing RPC failed with status 16: unauthenticated/);
	});

	it("rejects malformed responses", () => {
		expect(() => parseGrokUsageResponse(Uint8Array.of(0))).toThrow(/no valid protobuf payload/);
	});

	it("supports only xAI OAuth credentials with an access token", () => {
		expect(xaiOAuthUsageProvider.supports?.(oauthParams())).toBe(true);
		expect(
			xaiOAuthUsageProvider.supports?.({ provider: "xai", credential: { type: "api_key", apiKey: "xai-key" } }),
		).toBe(false);
		expect(xaiOAuthUsageProvider.supports?.({ provider: "xai-oauth", credential: { type: "oauth" } })).toBe(false);
	});

	it("surfaces non-OK billing responses", async () => {
		const ctx: UsageFetchContext = {
			fetch: async () => new Response("denied", { status: 403 }),
		};
		await expect(xaiOAuthUsageProvider.fetchUsage(oauthParams(), ctx)).rejects.toThrow(
			/Grok billing request failed with HTTP 403: denied/,
		);
	});
});
