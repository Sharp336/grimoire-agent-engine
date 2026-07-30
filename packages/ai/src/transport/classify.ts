import { Code, ConnectError } from "@connectrpc/connect";
import { connectCodeToHttpStatus } from "./connect-frame";
import { H2UnavailableBeforeDispatchError } from "./h2-request";

const TRANSIENT_SYSTEM_CODES: Record<string, true> = {
	ECONNABORTED: true,
	ECONNREFUSED: true,
	ECONNRESET: true,
	EHOSTUNREACH: true,
	ENETDOWN: true,
	ENETUNREACH: true,
	ENOTFOUND: true,
	EPIPE: true,
	ERR_HTTP2_ERROR: true,
	ERR_HTTP2_GOAWAY_SESSION: true,
	ERR_HTTP2_INVALID_SESSION: true,
	ERR_HTTP2_STREAM_CANCEL: true,
	ERR_HTTP2_STREAM_ERROR: true,
	ETIMEDOUT: true,
};

export function normalizeConnectAuthError(
	error: unknown,
	createCredentialError: (message: string, status: 401 | 403) => Error,
	createHttpError: (message: string, status: number) => Error,
): Error {
	if (error instanceof ConnectError) {
		if (error.code === Code.Unauthenticated) return createCredentialError(error.message, 401);
		if (error.code === Code.PermissionDenied) return createCredentialError(error.message, 403);
		// Non-auth Connect codes carry no HTTP status, so the outer classifier
		// cannot derive transient semantics from them — an Unavailable "try again"
		// would never be retried. Map every standard code to a status-bearing
		// error so 503/500/429 keep their meaning.
		return createHttpError(error.message, connectCodeToHttpStatus(error.code));
	}
	return error instanceof Error ? error : new Error(String(error));
}

/** Classifies final attempt identity only; fallback uses H2UnavailableBeforeDispatchError directly. */
export function isTransientTransportError(error: unknown): boolean {
	if (error instanceof H2UnavailableBeforeDispatchError) return true;
	if (error instanceof DOMException && error.name === "AbortError") return false;
	if (error && typeof error === "object" && "status" in error) return false;
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && TRANSIENT_SYSTEM_CODES[code]) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /h2 is not supported|stream closed with error code NGHTTP2_[A-Z_]+/i.test(message);
}
