import { scheduler } from "node:timers/promises";

// Google Gemini (CloudCode proxy) 429 body: "Your quota will reset after 18h31m10s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// Google Gemini 429 body: "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// Google Gemini JSON error detail: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// Codex 429 body "try again in 250ms" / "try again in 12s"; ChatGPT OAuth
// usage-limit body "You have hit your ChatGPT usage limit (pro plan). Try
// again in ~158 min." (units: min/minutes/h/hours)
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// Devin 403 account-scoped cap body: "Your limit will reset in 13 minutes"
const WILL_RESET_IN_PATTERN = /(?:will\s+)?reset in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// Zhipu GLM Coding Plan quota errors (HTTP 429; Zhipu's error-code reference
// documents the whole 1308–1321 series with the shared trailing clause) name
// the reset moment as an absolute wall-clock stamp. CN platform
// (docs.bigmodel.cn): "您的限额将在 2026-08-17 11:17:40 重置" (1308: "已达到
// 5 小时的使用上限。您的限额将在 ${next_flush_time} 重置"). International
// Z.AI returns the JSON body {"code":"1308","message":"Usage limit reached
// for 5 hour. Your limit will reset at 2026-02-06 05:34:34"}. Everything in
// this family — the wordings, the assumed zone, the reread fallback, the
// horizon — is Zhipu attestation; nothing here is generic.
const ZHIPU_RESET_AT_DATETIME_SOURCE = String.raw`\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?`;
// Optional trailing zone marker. No attested body carries one today, but if
// Zhipu ever starts stamping one it wins over the assumed zone below.
const ZHIPU_RESET_AT_ZONE_SOURCE = String.raw`(?:\s*(?:Z|UTC|GMT|[+-]\d{2}:\d{2}|[+-]\d{4}|[+-]\d{2}))?`;
const ZHIPU_RESET_AT_DATETIME_TOKEN =
	/^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2}) (?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?<zone>Z|UTC|GMT|[+-]\d{2}:\d{2}|[+-]\d{4}|[+-]\d{2})?$/;
const ZHIPU_RESET_AT_DATETIME_SCANNER = new RegExp(ZHIPU_RESET_AT_DATETIME_SOURCE + ZHIPU_RESET_AT_ZONE_SOURCE);
const ZHIPU_CN_RESET_AT_PATTERN = new RegExp(
	String.raw`您的限额将在[^\S\n]*${ZHIPU_RESET_AT_DATETIME_SOURCE}${ZHIPU_RESET_AT_ZONE_SOURCE}[^\S\n]*重置`,
);
const ZHIPU_EN_RESET_AT_PATTERN = new RegExp(
	String.raw`\b(?:will\s+reset|resets)\s+at\s+${ZHIPU_RESET_AT_DATETIME_SOURCE}${ZHIPU_RESET_AT_ZONE_SOURCE}`,
	"i",
);
// The stamps documented today are bare wall-clock strings with no zone
// marker; neither error-code reference states one. Zhipu support (ticket)
// confirmed the stamp is server time in UTC+8, and advised treating
// implausibly stale stamps as UTC — see the fallback in
// extractZhipuResetWaitMs. Observed resets on the CN side match UTC+8, and
// the international service is observed in Singapore time (also UTC+8) — so
// bare stamps read as +08:00 unless they carry a zone marker of their own.
const ZHIPU_RESET_AT_ZONE_SUFFIX = "+08:00";
// Plausibility window for a past stamp in a freshly returned body: real
// staleness is seconds, and one minute also absorbs client clock skew. A
// bare stamp stale past it can't be a real boundary, so the server likely
// returned UTC despite the confirmed UTC+8 (Zhipu support's fallback advice:
// reread the stamp as UTC). A stamp past within it is a plausible
// just-reset boundary: retry once it is a full window past (see
// extractZhipuResetWaitMs).
const ZHIPU_RESET_AT_STALE_MS = 60_000;
// Grace over the stated boundary — generic: any provider naming an absolute
// reset moment has reset jobs that land seconds late and clocks that skew
// up to ~1s even on NTP hosts. Waking early just burns a retry attempt on
// another 429 (the stamp then parses as past, falling back to exponential
// backoff), and account-window waits run minutes or more — a 3s cushion is
// free.
const RESET_AT_BUFFER_MS = 3_000;
// A stated reset further out than this is garbage, not a wait target: the
// largest window Zhipu documents is the weekly quota (7-day codes
// 1310/1317/1319/1321), so nothing past a week is a real boundary. This
// also bounds the sleep below.
const ZHIPU_RESET_AT_MAX_DELTA_MS = 7 * 24 * 60 * 60 * 1000;

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
 *  - `您的限额将在 2026-08-17 11:17:40 重置` (GLM Coding Plan 429, codes
 *    1308–1321) and `Your limit will reset at 2026-02-06 05:34:34` (Z.AI
 *    international 1308 JSON body) — absolute reset moments: +3s grace,
 *    explicit zone markers honored, bare stamps parsed as the server's
 *    UTC+8 with a stale-stamp UTC reread. The whole family is Zhipu
 *    attestation (see extractZhipuResetWaitMs).
 *  - `Your quota will reset after 18h31m10s` / `10m15s` / `39s` (Google Gemini)
 *  - `Please retry in 250ms` / `Please retry in 12s` (Google Gemini)
 *  - `"retryDelay": "34.074824224s"` (Google Gemini JSON error detail)
 *  - `try again in 250ms` / `try again in ~158 min` (Codex / ChatGPT OAuth)
 *  - `Your limit will reset in 13 minutes` (Devin 403 account cap)
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

	// Absolute reset moments are account windows like "reset after 18h31m10s"
	// above, so they outrank the generic "retry in" hints below. Only the
	// Zhipu GLM Coding Plan family is registered today; a future provider
	// naming its own stamp gets its own family beside it.
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
 * Zhipu GLM Coding Plan stamp family (see the ZHIPU_RESET_AT_* patterns):
 * the wait implied by an absolute reset moment named in the error body, or
 * `undefined` when no registered wording brackets a usable datetime. The
 * datetime must be bracketed by reset wording so unrelated embedded dates
 * never become wait targets.
 */
function extractZhipuResetWaitMs(body: string): number | undefined {
	const stamp = parseZhipuResetStamp(body);
	if (!stamp) return undefined;
	const deltaMs = stamp.resetAtMs - Date.now();
	// A future stamp within the horizon is the wait target.
	if (deltaMs > 0 && deltaMs <= ZHIPU_RESET_AT_MAX_DELTA_MS) return deltaMs + RESET_AT_BUFFER_MS;
	// Just-past within the plausibility window (a plausible just-reset
	// boundary): retry once the boundary is a full window past, plus grace —
	// by then the boundary either took, or the fresh body's stamp is stale
	// enough to reread as UTC below.
	if (deltaMs <= 0 && deltaMs > -ZHIPU_RESET_AT_STALE_MS) {
		return deltaMs + ZHIPU_RESET_AT_STALE_MS + RESET_AT_BUFFER_MS;
	}
	// Stale past the plausibility window. Bare stamps: Zhipu support's
	// advice (ticket) — the confirmed +08:00 may be wrong for this server,
	// so reread the same wall clock as UTC (8h later). An explicit zone has
	// nothing to correct, as does a reread that is still past or beyond the
	// horizon: return nothing.
	if (!stamp.explicitZone && deltaMs <= -ZHIPU_RESET_AT_STALE_MS) {
		const utcDeltaMs = deltaMs + 8 * 3_600_000;
		if (utcDeltaMs > 0 && utcDeltaMs <= ZHIPU_RESET_AT_MAX_DELTA_MS) return utcDeltaMs + RESET_AT_BUFFER_MS;
	}
	return undefined;
}

function parseZhipuResetStamp(body: string): { resetAtMs: number; explicitZone: boolean } | undefined {
	for (const pattern of [ZHIPU_CN_RESET_AT_PATTERN, ZHIPU_EN_RESET_AT_PATTERN]) {
		const span = pattern.exec(body);
		if (!span) continue;
		const datetime = ZHIPU_RESET_AT_DATETIME_SCANNER.exec(span[0]);
		if (!datetime) continue;
		const token = ZHIPU_RESET_AT_DATETIME_TOKEN.exec(datetime[0])?.groups;
		if (!token) continue;
		const pad2 = (value: string | number) => String(value).padStart(2, "0");
		const zoneSuffix = zoneMarkerToIsoSuffix(token.zone, ZHIPU_RESET_AT_ZONE_SUFFIX);
		const iso = `${token.year}-${pad2(token.month!)}-${pad2(token.day!)}T${pad2(token.hour!)}:${token.minute}:${token.second ?? "00"}${zoneSuffix}`;
		const resetAtMs = Date.parse(iso);
		if (!Number.isNaN(resetAtMs)) return { resetAtMs, explicitZone: token.zone !== undefined };
	}
	return undefined;
}

// Zone marker → ISO 8601 offset suffix. No marker → the caller's assumed
// zone; Z / UTC / GMT → Z; ±HH, ±HHMM, ±HH:MM → ±HH:MM.
function zoneMarkerToIsoSuffix(zone: string | undefined, assumedSuffix: string): string {
	if (zone === undefined) return assumedSuffix;
	if (zone === "Z" || zone === "UTC" || zone === "GMT") return "Z";
	const digits = zone.slice(1).replace(":", "");
	return `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || "00"}`;
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
