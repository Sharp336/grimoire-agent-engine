import { abortableSleep } from "@oh-my-pi/pi-utils";

type ErrorLike = {
	message?: string;
	name?: string;
	code?: unknown;
	errno?: string | number;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
	error?: { code?: unknown } | null;
};

export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return /\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message);
}

const TRANSIENT_MESSAGE_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server[_ ]?error|internal[_ ]?error|connection.?error|unable to connect|fetch failed|stream stall|socket hang up|other side closed|upstream.?connect|reset before headers|client network socket disconnected before secure tls connection was established/i;

const CERTIFICATE_MESSAGE_PATTERN =
	/unknown certificate verification error|certificate verification|unable to verify(?: the first)? certificate|unable to get local issuer certificate|self[ -]?signed certificate|self signed cert(?:ificate)? in cert(?:ificate)? chain|hostname\/ip does not match certificate|altname invalid|tlsv1 alert|ssl routines|certificate has expired|cert has expired/i;

const TRANSIENT_ERROR_CODE_PATTERN =
	/^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|UND_ERR_TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|CERT[_A-Z]+)$/i;

const VALIDATION_MESSAGE_PATTERN =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/**
 * Identify errors that should be retried (timeouts, 5xx, 408, 429, transient network failures).
 */
export function isRetryableError(error: unknown): boolean {
	const details = collectErrorSignals(error);
	const combined = details.join("\n");
	const message = combined.toLowerCase();

	if (/timeout|timed out|deadline exceeded|waiting for the first event/i.test(combined)) return true;
	if (/\baborted\b/i.test(combined)) return false;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		if (status >= 500) return true;
		if (status === 408 || status === 429) return true;
		if (status >= 400 && status < 500) return false;
	}

	if (TRANSIENT_ERROR_CODE_PATTERN.test(combined)) return true;
	if (CERTIFICATE_MESSAGE_PATTERN.test(message)) return true;
	if (VALIDATION_MESSAGE_PATTERN.test(message)) return false;

	return isUnexpectedSocketCloseMessage(message) || TRANSIENT_MESSAGE_PATTERN.test(message);
}

export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as ErrorLike;
	const rawStatus =
		info.status ??
		info.statusCode ??
		(info.response && typeof info.response === "object" ? info.response.status : undefined);

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) {
			status = parsed;
		}
	}

	if (status !== undefined && status >= 100 && status <= 599) {
		return status;
	}

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}

	if (info.cause) {
		return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	}

	return undefined;
}

function collectErrorSignals(error: unknown, depth = 0): string[] {
	if (depth > 2 || error === null || error === undefined) return [];
	if (typeof error === "string") return [error];
	if (typeof error !== "object") return [];

	const info = error as ErrorLike;
	const values = [info.message, info.name, normalizeSignalValue(info.code), normalizeSignalValue(info.errno)].filter(
		(value): value is string => !!value,
	);
	return info.cause ? [...values, ...collectErrorSignals(info.cause, depth + 1)] : values;
}

function normalizeSignalValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function extractStatusFromMessage(message: string): number | undefined {
	const patterns = [
		/error\s*\((\d{3})\)/i,
		/status\s*[:=]?\s*(\d{3})/i,
		/\bhttp\s*(\d{3})\b/i,
		/\b(\d{3})\s*(?:status|error)\b/i,
	];

	for (const pattern of patterns) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) {
			return value;
		}
	}

	return undefined;
}

/**
 * GitHub Copilot intermittently rejects preview models (gpt-5.3-codex,
 * gpt-5.4, gpt-5.4-mini, ...) with HTTP 400 `model_not_supported`, even
 * though the model is listed as enabled on the user's account via `/models`.
 *
 * Root cause: Copilot's request-routing backend is rolled out per OAuth
 * client. Our OAuth client id is shared with opencode; VS Code uses its own
 * client and sees full availability, so the same account may succeed in VS
 * Code and flap between 200/400 here. See opencode#13313 and copilot-cli#2597.
 *
 * Retrying the identical request 2-3 times almost always lands on a backend
 * that has the model, so we wrap the initial request with a short retry loop.
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	return extractErrorCode(error) === "model_not_supported";
}

export function isCopilotRetryableError(error: unknown): boolean {
	if (isCopilotTransientModelError(error)) return true;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		return status >= 500 || status === 408 || status === 429;
	}

	const message = error instanceof Error ? error.message : String(error);
	return (
		isUnexpectedSocketCloseMessage(message) ||
		/request was aborted|aborted|fetch failed|network error|timed?\s*out|timeout|other side closed/i.test(message)
	);
}

function extractErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const info = error as ErrorLike;
	if (typeof info.code === "string") return info.code;
	const nested = info.error;
	if (nested && typeof nested === "object" && typeof nested.code === "string") {
		return nested.code;
	}
	return undefined;
}

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;

/**
 * Wrap an initial Copilot request so transient `model_not_supported` 400s are
 * retried a small number of times. No-op for non-Copilot providers.
 *
 * The callback **MUST** create a fresh in-flight request each invocation — a
 * once-consumed AsyncIterable cannot be re-iterated.
 */
export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	let lastError: unknown;
	for (let attempt = 0; attempt < COPILOT_MODEL_RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!isCopilotRetryableError(error)) throw error;
			if (attempt === COPILOT_MODEL_RETRY_MAX_ATTEMPTS - 1) break;
			await abortableSleep(COPILOT_MODEL_RETRY_BASE_DELAY_MS * (attempt + 1), options.signal);
		}
	}
	throw lastError;
}
