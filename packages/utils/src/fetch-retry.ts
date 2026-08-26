import { scheduler } from "node:timers/promises";

// "reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// JSON field: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// "try again in 250ms" / "try again in 12s" / "try again in 12sec" /
// "try again in 5 min" / "try again in ~158 min." / "try again in 2h" /
// "try again in 90 minutes" / "try again in 1 hour"
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// "Your limit will reset in 13 minutes" / "reset in 13 minutes" / "will reset in 2h"
const WILL_RESET_IN_PATTERN = /(?:will\s+)?reset in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// Zhipu GLM Coding Plan 429s (docs.bigmodel.cn/cn/api/api-code,
// docs.z.ai/api-reference/api-code, codes 1308–1321) state the reset as an
// absolute wall-clock stamp, not a duration.
const ZHIPU_RESET_AT_DATETIME = String.raw`\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?`;
// Unattested in any body so far; honored if Zhipu starts stamping one.
const ZHIPU_RESET_AT_ZONE = String.raw`(?:\s*(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?))?`;
const ZHIPU_CN_RESET_AT_PATTERN = new RegExp(
	String.raw`您的限额将在[^\S\n]*(${ZHIPU_RESET_AT_DATETIME}${ZHIPU_RESET_AT_ZONE})[^\S\n]*重置`,
	"i",
);
// Only a body pairing a Zhipu code with its own documented message (regexes
// below) earns the UTC+8 read.
const ZHIPU_JSON_ERROR_ENVELOPE =
	/\{\s*(?:"error"\s*:\s*\{\s*)?"code"\s*:\s*"(?<code>1308|1310|131[6-9]|132[01])"\s*,\s*"message"\s*:\s*"(?<message>[^"]*)"/;
const ZHIPU_TYPE_CODE_PATTERN = /\btype=(?<code>1308|1310|131[6-9]|132[01])\b/;
const ZHIPU_CODE_MESSAGES: Readonly<Record<string, RegExp>> = {
	"1308": /已达到[^。]{0,16}的使用上限|usage limit reached for (?!the past)/i,
	"1310": /每周\/每月使用上限|weekly\/monthly limit exhausted/i,
	"1316":
		/已达到\s*5\s*小时使用上限[，。][^。]{0,40}主账号余额不足|usage limit reached for the past 5 hours\.[^"]{0,80}insufficient balance/i,
	"1317":
		/已达到\s*7\s*天使用上限[，。][^。]{0,40}主账号余额不足|usage limit reached for the past 7 days\.[^"]{0,80}insufficient balance/i,
	"1318":
		/已达到\s*5\s*小时使用上限，且已达子账号月消费上限|usage limit reached for the past 5 hours\.[^"]{0,80}monthly spend limit/i,
	"1319":
		/已达到\s*7\s*天使用上限，且已达子账号月消费上限|usage limit reached for the past 7 days\.[^"]{0,80}monthly spend limit/i,
	"1320":
		/已达到\s*5\s*小时使用上限，且已达企业级月消费上限|usage limit reached for the past 5 hours\.[^"]{0,80}monthly spend limit/i,
	"1321":
		/已达到\s*7\s*天使用上限，且已达企业级月消费上限|usage limit reached for the past 7 days\.[^"]{0,80}monthly spend limit/i,
};
const ZHIPU_EN_RESET_AT_PATTERN = new RegExp(
	String.raw`\b(?:will\s+reset|resets)\s+at\s+(${ZHIPU_RESET_AT_DATETIME}${ZHIPU_RESET_AT_ZONE})`,
	"i",
);
const ZHIPU_RESET_AT_TOKEN =
	/^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2}) (?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?<zone>\s*(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?))?$/i;
// Bare stamps are server wall clock; both platforms anchor UTC+8 (Beijing/Singapore).
const ZHIPU_RESET_AT_ASSUMED_ZONE = "+08:00";
const ZHIPU_RESET_AT_ZONE_SHIFT_MS = 8 * 3_600_000;
// Grace past the stated boundary: reset jobs land seconds late and clocks skew ~1s;
// waking early just buys another 429, and account windows run minutes+ — 3s is free.
const RESET_AT_BUFFER_MS = 3_000;
// Plausibility window for a past stamp in a fresh body: real staleness is
// seconds, and 1min also absorbs client skew. A bare stamp staler than that
// can't be a live UTC+8 boundary — the server likely stamped UTC (reread below).
const ZHIPU_RESET_AT_STALE_MS = 60_000;
// Horizon per code = its documented window; a stated reset further out is
// garbage, not a wait target. 1308's `${number} ${unit}` interpolates any
// unit → the widest window the docs name, the month (≤31d, shared with
// 1310's weekly/monthly). Also bounds the implied sleep.
const ZHIPU_RESET_AT_MAX_DELTA_MS: Readonly<Record<string, number>> = {
	"1308": 31 * 24 * 60 * 60 * 1000,
	"1310": 31 * 24 * 60 * 60 * 1000,
	"1316": 5 * 60 * 60 * 1000,
	"1317": 7 * 24 * 60 * 60 * 1000,
	"1318": 5 * 60 * 60 * 1000,
	"1319": 7 * 24 * 60 * 60 * 1000,
	"1320": 5 * 60 * 60 * 1000,
	"1321": 7 * 24 * 60 * 60 * 1000,
};
// Fallback for a code not yet mapped above; widest, since the horizon only rejects garbage.
const ZHIPU_RESET_AT_MAX_DELTA_MS_DEFAULT = 31 * 24 * 60 * 60 * 1000;

/**
 * Server-suggested retry delay extraction. Merges the patterns historically used
 * by the OpenAI Codex and Google Gemini retry helpers.
 *
 * Header sources (checked in order):
 *  - `retry-after-ms` (milliseconds)
 *  - `Retry-After` (numeric seconds, or HTTP date)
 *  - `x-ratelimit-reset-ms` (delta ms, or Unix epoch ms/s for large values)
 *  - `x-ratelimit-reset` (Unix epoch seconds)
 *  - `x-ratelimit-reset-after` (seconds)
 *
 * Body patterns:
 *  - `您的限额将在 2026-08-17 11:17:40 重置` / `Your limit will reset at …`
 *    (GLM Coding Plan 429, codes 1308–1321) — absolute reset moments; bare
 *    stamps are server UTC+8, explicit zone markers honored, +3s grace
 *  - `Your quota will reset after 18h31m10s` / `10m15s` / `39s`
 *  - `Please retry in 250ms` / `Please retry in 12s`
 *  - `"retryDelay": "34.074824224s"` (JSON error detail field)
 *  - `try again in 250ms` / `try again in 12s` / `try again in 5 min` / `try again in ~158 min`
 *
 * Returns `undefined` if no signal is found.
 */
export function extractRetryHint(source: Response | Headers | null | undefined, body?: string): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	if (headers) {
		const retryAfterMs = headers.get("retry-after-ms");
		if (retryAfterMs) {
			const ms = Number(retryAfterMs);
			if (Number.isFinite(ms) && ms >= 0) return ms;
		}
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
			const parsedDate = Date.parse(retryAfter);
			if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
		}
		const rateLimitResetMs = headers.get("x-ratelimit-reset-ms");
		if (rateLimitResetMs) {
			const value = Number(rateLimitResetMs);
			if (Number.isFinite(value) && value > 0) {
				// > 1e12 → epoch ms; > 1e9 → epoch s; otherwise a delta in ms.
				const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
				if (targetMs === undefined) return value;
				const delta = targetMs - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delta = resetSeconds * 1000 - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const seconds = Number(rateLimitResetAfter);
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		}
	}

	if (!body) return undefined;
	// Absolute reset moments are account windows → they outrank every relative
	// hint below. Only the Zhipu family is registered today.
	const zhipuResetWaitMs = extractZhipuResetWaitMs(body);
	if (zhipuResetWaitMs !== undefined) return zhipuResetWaitMs;

	const quotaMatch = QUOTA_RESET_PATTERN.exec(body);
	if (quotaMatch) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]!);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			if (totalMs > 0) return totalMs;
		}
	}
	// Account-reset hints ("will reset in …") take precedence over short
	// retry hints ("please retry in 5s"): a body carrying both must honour the
	// longer account window, not the shorter generic one. QUOTA_RESET_PATTERN
	// ("reset after …") above already runs first and stays first.
	for (const pattern of [WILL_RESET_IN_PATTERN, PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
		const match = pattern.exec(body);
		if (match?.[1]) {
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]!);
				if (unitMs !== undefined) return value * unitMs;
			}
		}
	}
	return undefined;
}

function unitToMs(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 60 * 60_000;
		default:
			return undefined;
	}
}

/**
 * Zhipu stamp family: the wait implied by an absolute reset moment in the
 * body. The reset-wording bracket keeps unrelated embedded dates out.
 */

function extractZhipuResetWaitMs(body: string): number | undefined {
	const stamp = parseZhipuResetStamp(body);
	if (!stamp) return undefined;
	const maxDeltaMs = ZHIPU_RESET_AT_MAX_DELTA_MS[stamp.code] ?? ZHIPU_RESET_AT_MAX_DELTA_MS_DEFAULT;
	const deltaMs = stamp.resetAtMs - Date.now();
	// Future within the code's horizon → the wait.
	if (deltaMs > 0 && deltaMs <= maxDeltaMs) return deltaMs + RESET_AT_BUFFER_MS;
	// Bare + stale past the window → the UTC+8 assumption is likely wrong for
	// this server; reread the same wall clock as UTC — Zhipu support's
	// fallback advice. Zoned stamps have nothing to correct.
	if (!stamp.explicitZone && deltaMs <= -ZHIPU_RESET_AT_STALE_MS) {
		const utcDeltaMs = deltaMs + ZHIPU_RESET_AT_ZONE_SHIFT_MS;
		if (utcDeltaMs > 0 && utcDeltaMs <= maxDeltaMs) return utcDeltaMs + RESET_AT_BUFFER_MS;
	}
	return undefined;
}
function parseZhipuResetStamp(body: string): { resetAtMs: number; code: string; explicitZone: boolean } | undefined {
	// Code, wording, and stamp must come from one message — a code elsewhere
	// in the body must not vouch for them.
	const envelope = ZHIPU_JSON_ERROR_ENVELOPE.exec(body);
	const code = envelope?.groups?.code ?? ZHIPU_TYPE_CODE_PATTERN.exec(body)?.groups?.code;
	if (code === undefined) return undefined;
	const text = envelope?.groups?.message ?? body;
	if (!ZHIPU_CODE_MESSAGES[code]?.test(text)) return undefined;
	for (const pattern of [ZHIPU_CN_RESET_AT_PATTERN, ZHIPU_EN_RESET_AT_PATTERN]) {
		const token = ZHIPU_RESET_AT_TOKEN.exec(pattern.exec(text)?.[1] ?? "")?.groups;
		if (!token) continue;
		// Date.parse rolls an impossible day ("2026-02-30" → Mar 2); a server
		// never states a rolled date → mismatch discards the stamp.
		const day = Number(token.day);
		if (new Date(Date.UTC(Number(token.year), Number(token.month) - 1, day)).getUTCDate() !== day) continue;
		const pad2 = (value: string) => value.padStart(2, "0");
		const iso =
			`${token.year}-${pad2(token.month!)}-${pad2(token.day!)}` +
			`T${token.hour!.padStart(2, "0")}:${token.minute}:${token.second ?? "00"}` +
			zoneMarkerToIsoSuffix(token.zone);
		const resetAtMs = Date.parse(iso);
		if (!Number.isNaN(resetAtMs)) return { resetAtMs, code, explicitZone: token.zone !== undefined };
	}
	return undefined;
}

function zoneMarkerToIsoSuffix(zone: string | undefined): string {
	if (zone === undefined) return ZHIPU_RESET_AT_ASSUMED_ZONE;
	const marker = zone.trim().toUpperCase();
	if (marker === "Z" || marker === "UTC" || marker === "GMT") return "Z";
	const digits = marker.slice(1).replace(":", "");
	return `${marker[0]!}${digits.slice(0, 2)}:${digits.slice(2) || "00"}`;
}

export interface FetchWithRetryOptions extends RequestInit {
	/** Total fetch attempts (initial + retries). Default `5`. */
	maxAttempts?: number;
	/**
	 * Per-delay cap. Server-provided `Retry-After` hints exceeding this return
	 * the current response immediately — caller deals with the `!response.ok`.
	 * Default `60_000`.
	 */
	maxDelayMs?: number;
	/**
	 * Fallback delay schedule when no server hint is present. Number, array
	 * (indexed by attempt, clamped to last), or function. Default exponential
	 * `500ms * 2 ** attempt` capped at `maxDelayMs`.
	 */
	defaultDelayMs?: number | readonly number[] | ((attempt: number) => number);
	/**
	 * Optional per-attempt overlay merged into the base `RequestInit` each try.
	 * Headers from the overlay shallow-merge over the base. Useful for auth
	 * token refresh or user-agent rotation.
	 */
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	/**
	 * Optional `fetch` implementation override. Defaults to `globalThis.fetch`.
	 * Useful for routing requests through a proxy, instrumented transport, or
	 * mock during tests.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/**
	 * Optional retry gate for HTTP responses whose status is retryable. Receives a
	 * cloned body string so callers can fail fast on deterministic provider
	 * failures that happen to use a 5xx status.
	 */
	shouldRetryResponse?: (response: Response, bodyText: string, attempt: number) => boolean | Promise<boolean>;
	/**
	 * Bun extension forwarded verbatim to the underlying `fetch` call. `false`
	 * disables Bun's native ~300s pre-response timeout (callers that own a
	 * configurable first-event/idle watchdog or an external `AbortSignal`
	 * supply this so the runtime ceiling cannot pre-empt them); a positive
	 * number sets a custom ceiling in ms. Bare browser/Node fetch ignores it.
	 */
	timeout?: number | false;
}

const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Fetch with bounded retries and sensible defaults. Retries on any
 * `isRetryableStatus` (5xx, 408, 429) and on transient network errors. Server
 * `Retry-After`/quota hints are honoured up to `maxDelayMs`; a hint that exceeds
 * the cap returns the current response so the caller can fail fast. Aborts on
 * `init.signal` propagate as `"Request was aborted"`.
 *
 * The caller is responsible for inspecting `!response.ok` once the call returns.
 */
export async function fetchWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const {
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		maxDelayMs = DEFAULT_MAX_DELAY_MS,
		defaultDelayMs,
		prepareInit,
		shouldRetryResponse,
		fetch: fetchImpl = fetch,
		timeout = false,
		...baseInit
	} = options;
	const signal = baseInit.signal as AbortSignal | undefined;

	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted");
		const requestUrl = typeof url === "function" ? url(attempt) : url;
		// `timeout` is destructured out of `baseInit`, so forward it to the underlying
		// fetch on the no-`prepareInit` path too. Without this, callers that pass
		// `timeout: false` (every streaming provider, to disable Bun's native ~300s
		// fetch ceiling in favor of their own first-event/idle watchdog) had it
		// silently dropped, so long-running streams were killed at ~300s (issue #602).
		// Only forward when the caller actually set `timeout`, so callers that never
		// set it keep Bun's default ceiling.
		const init = prepareInit
			? mergeInit(baseInit, await prepareInit(attempt), timeout)
			: "timeout" in options
				? ({ ...baseInit, timeout } as unknown as RequestInit)
				: baseInit;

		let response: Response;
		try {
			response = await fetchImpl(requestUrl, init);
		} catch (error) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const wrapped = wrapNetworkError(error);
			if (attempt + 1 >= maxAttempts) throw wrapped;
			await waitForRetry(resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), signal);
			continue;
		}

		if (!isRetryableStatus(response.status)) return response;
		if (attempt + 1 >= maxAttempts) return response;

		const retryBody = await response.clone().text();
		if (shouldRetryResponse && !(await shouldRetryResponse(response, retryBody, attempt))) return response;

		const hint = extractRetryHint(response, retryBody);
		if (hint !== undefined && hint > maxDelayMs) return response;

		const delayMs = Math.min(hint ?? resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), maxDelayMs);
		await waitForRetry(delayMs, signal);
	}
}

function mergeInit(base: RequestInit, overlay: RequestInit, timeout: number | false): RequestInit {
	const merged = { ...base, ...overlay, timeout } as unknown as RequestInit;
	if (base.headers || overlay.headers) {
		const baseHeaders = new Headers(base.headers ?? undefined);
		const overlayHeaders = new Headers(overlay.headers ?? undefined);
		overlayHeaders.forEach((value, key) => {
			baseHeaders.set(key, value);
		});
		merged.headers = baseHeaders;
	}
	return merged;
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await scheduler.wait(delayMs, { signal });
	} catch (error) {
		if (signal?.aborted) throw new Error("Request was aborted");
		throw error;
	}
}

function wrapNetworkError(error: unknown): Error {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.message === "Request was aborted") {
			return new Error("Request was aborted");
		}
		if (error.message === "fetch failed" && error.cause instanceof Error) {
			return new Error(`Network error: ${error.cause.message}`);
		}
		return error;
	}
	return new Error(String(error));
}

function resolveDefaultDelay(
	option: FetchWithRetryOptions["defaultDelayMs"],
	attempt: number,
	maxDelayMs: number,
): number {
	if (option === undefined) return Math.min(500 * 2 ** attempt, maxDelayMs);
	if (typeof option === "number") return Math.min(option, maxDelayMs);
	if (typeof option === "function") return Math.min(option(attempt), maxDelayMs);
	return Math.min(option[Math.min(attempt, option.length - 1)] ?? 0, maxDelayMs);
}

/**
 * Inspect an arbitrary error value (or its `cause` chain, up to depth 2) for an
 * HTTP status code. Reads `status`, `statusCode`, and `response.status` fields,
 * coerces string values, and falls back to scanning the error message for
 * common patterns like `Error: 401`, `error (429)`, or `HTTP 503`.
 */
export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	const rawStatus = info.status ?? info.statusCode ?? info.response?.status;

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) status = parsed;
	}
	if (status !== undefined && status >= 100 && status <= 599) return status;

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	if (info.cause) return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	return undefined;
}

const STATUS_MESSAGE_PATTERNS = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
] as const;

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

/**
 * `true` if the given HTTP status code is one we treat as transient: 408
 * (Request Timeout), 429 (Too Many Requests), or any 5xx (server error).
 */
export function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * `true` if the message describes an unexpected socket closure — Bun and some
 * proxies surface these for any HTTP/2 stream reset.
 */
export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return /\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message);
}

const TRANSIENT_MESSAGE_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|network error|stream stall|other side closed|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;

const VALIDATION_MESSAGE_PATTERN =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/**
 * Identify errors that should be retried: aborts/timeouts in the error name or
 * message, retryable HTTP statuses (see `isRetryableStatus`), unexpected socket
 * closes, and the standard transient phrases. 4xx statuses other than 408/429
 * and validation-shaped messages short-circuit to `false`.
 */
export function isRetryableError(error: unknown): boolean {
	const info = error as { message?: string; name?: string } | null;
	const message = info?.message ?? "";
	const name = info?.name ?? "";
	if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) return true;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		if (isRetryableStatus(status)) return true;
		if (status >= 400 && status < 500) return false;
	}

	if (VALIDATION_MESSAGE_PATTERN.test(message)) return false;
	return isUnexpectedSocketCloseMessage(message) || TRANSIENT_MESSAGE_PATTERN.test(message);
}
