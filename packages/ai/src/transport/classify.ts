import { Code, ConnectError } from "@connectrpc/connect";
import { H2UnavailableBeforeDispatchError } from "./h2-request";

export function normalizeConnectAuthError(
	error: unknown,
	createCredentialError: (message: string, status: 401 | 403) => Error,
): Error {
	if (error instanceof ConnectError) {
		if (error.code === Code.Unauthenticated) return createCredentialError(error.message, 401);
		if (error.code === Code.PermissionDenied) return createCredentialError(error.message, 403);
	}
	return error instanceof Error ? error : new Error(String(error));
}

/** Only the named, observed pre-dispatch H2-unavailable outcome is transport-retryable. */
export function isTransientTransportError(error: unknown): boolean {
	return error instanceof H2UnavailableBeforeDispatchError;
}
