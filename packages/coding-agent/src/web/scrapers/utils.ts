import { isLocalOrMetadataHost } from "@oh-my-pi/pi-ai";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";

export { isRecord };

import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import { MAX_BYTES, MAX_REDIRECTS } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BinaryFetchSuccess {
	ok: true;
	buffer: Uint8Array;
	contentDisposition?: string;
}

export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

async function readResponseWithLimit(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new ToolAbortError();
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`response exceeds ${maxBytes} bytes`);
			}

			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}

	return new Uint8Array(Buffer.concat(chunks, totalBytes));
}

/**
 * Fetch binary content from a URL.
 *
 * SSRF guard: the initial URL hostname and every redirect target are validated
 * with {@link isLocalOrMetadataHost} before connecting. Redirects are followed
 * manually so a public URL that redirects to an internal address is blocked.
 */
export async function fetchBinary(url: string, timeout: number = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
	// SSRF guard: refuse non-public addresses before any network activity.
	const ssrfError = checkBinarySsrfGuard(url);
	if (ssrfError) return ssrfError;

	const requestSignal = ptree.combineSignals(signal, timeout * 1000);
	try {
		// Follow redirects manually so every hop's hostname is SSRF-checked.
		let currentUrl = url;
		let response: Response | undefined;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			response = await fetch(currentUrl, {
				signal: requestSignal,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; TextBot/1.0)",
				},
				redirect: "manual",
			});
			// Non-3xx (or 3xx without Location) — terminal response.
			if (response.status < 300 || response.status >= 400 || response.status === 304) {
				break;
			}
			const location = response.headers.get("location");
			if (!location) {
				break;
			}
			void response.body?.cancel().catch(() => {});
			const redirectUrl = new URL(location, currentUrl).href;
			const redirectParsed = new URL(redirectUrl);
			// Reject cross-protocol redirects (file://, data:, etc.). On Bun
			// `fetch("file:///...")` reads local files, and a non-HTTP(S) target
			// has no host to classify, so the hostname guard alone can't stop it.
			if (redirectParsed.protocol !== "http:" && redirectParsed.protocol !== "https:") {
				return { ok: false, error: `Refused to follow redirect to non-HTTP(S) protocol: ${redirectParsed.protocol}` };
			}
			const redirectHost = redirectParsed.hostname;
			if (isLocalOrMetadataHost(redirectHost)) {
				return { ok: false, error: `Refused to follow redirect to non-public address: ${redirectHost}` };
			}
			currentUrl = redirectUrl;
		}
		// `response` is always assigned inside the loop, so the old `!response`
		// guard was dead. When the redirect chain exceeds MAX_REDIRECTS the loop
		// exits with `response` still holding a 3xx — detect that explicitly rather
		// than falling through to the HTTP-status check (which would mislabel it).
		if (response && response.status >= 300 && response.status < 400) {
			return { ok: false, error: `Redirect loop exceeded ${MAX_REDIRECTS} hops` };
		}

		if (!response || !response.ok) {
			return { ok: false, error: `HTTP ${response?.status ?? 0}` };
		}

		const contentDisposition = response.headers.get("content-disposition") || undefined;
		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_BYTES) {
				return { ok: false, error: `content-length ${size} exceeds ${MAX_BYTES}` };
			}
		}
		const buffer = await readResponseWithLimit(response, MAX_BYTES, requestSignal);
		return { ok: true, buffer, contentDisposition };
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		if (requestSignal?.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: err instanceof Error ? err.message : "Failed to fetch binary" };
	}
}

/**
 * Check a URL's hostname against the SSRF blocklist. Returns a `BinaryFetchResult`
 * error when the host is private/loopback/link-local/metadata, otherwise `null`.
 */
function checkBinarySsrfGuard(url: string): BinaryFetchResult | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (isLocalOrMetadataHost(parsed.hostname)) {
		return { ok: false, error: `Refused to fetch non-public address: ${parsed.hostname}` };
	}
	return null;
}

/**
 * Convert binary content to markdown using markit.
 */
export async function convertWithMarkit(
	buffer: Uint8Array,
	extension: string,
	timeout: number = 20,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean; error?: string }> {
	const conversionSignal = ptree.combineSignals(signal, timeout * 1000);
	return convertBufferWithMarkit(buffer, extension, conversionSignal);
}
