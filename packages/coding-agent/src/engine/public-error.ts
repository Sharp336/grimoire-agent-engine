import { createHash } from "node:crypto";
import {
	PROVIDER_RETRY_DEFERRED_CODE,
	PROVIDER_RETRY_EXHAUSTED_CODE,
	PROVIDER_RETRY_PERMANENT_CODE,
} from "../session/provider-retry-budget";

const SAFE_ENGINE_ERROR =
	/^(?:AgentProfile|AvailableModelRoute|ProviderAccount|Provider quota|No usable AvailableModelRoute|The local OMP account|Failed to open auth database|Persistent credential block store|OAuth credential no longer exists|Engine mode|Engine session profile|selectedRouteRef|SQLite|SQLITE_|database (?:is|could not|cannot)|Cannot read private member|Receiver must be an instance|[^\s]+ is not a function|ENOENT|EACCES|EPERM|required_yield_not_submitted$|Unknown Engine failure$|[A-Za-z][A-Za-z0-9 ]* \(diagnostic [0-9a-f]{12}\)$|Retry budget exhausted after \d+ retries?: Thinking loop detected:|Thinking loop detected:)/i;

export function safeEngineErrorDetail(error: unknown): string {
	const name = error instanceof Error ? error.name || "Error" : "Error";
	const message = error instanceof Error ? error.message : String(error);
	const sanitized = sanitizeEngineErrorDetail(message).slice(0, 2_048);
	if (
		/^Hosted Core MCP binding failed(?:: (?:HTTP \d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN))? \(diagnostic [0-9a-f]{12}\)$/.test(
			message,
		)
	)
		return message;
	if (SAFE_ENGINE_ERROR.test(sanitized)) return sanitized;
	const fingerprint = createHash("sha256").update(`${name}\0${message}`).digest("hex").slice(0, 12);
	let publicName = name;
	const [code, reason = ""] = message.split(": ", 2);
	switch (code) {
		case PROVIDER_RETRY_DEFERRED_CODE:
			publicName = /^HTTP 429\b/.test(reason)
				? "Provider rate limit reached"
				: /^HTTP 5\d{2}\b/.test(reason)
					? "Provider temporarily unavailable"
					: "Provider request failed";
			break;
		case PROVIDER_RETRY_EXHAUSTED_CODE:
			publicName = "Provider retry limit reached";
			break;
		case PROVIDER_RETRY_PERMANENT_CODE:
			publicName = "Provider rejected the request";
			break;
	}
	return `${publicName} (diagnostic ${fingerprint})`;
}

/** MCP responses can contain credentials or arbitrary server text. Keep only
 * the connection failure category and a fingerprint, never the response body. */
export function safeHostedMcpFailure(message: string): string {
	const category = message.match(/\b(?:HTTP \d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/)?.[0];
	const fingerprint = createHash("sha256").update(`Error\0${message}`).digest("hex").slice(0, 12);
	return `Hosted Core MCP binding failed${category ? `: ${category}` : ""} (diagnostic ${fingerprint})`;
}

function sanitizeEngineErrorDetail(message: string): string {
	return message
		.replace(/[A-Za-z]:[\\/][^'"\r\n]*[\\/]agent\.db/gi, "[local auth database]")
		.replace(/\b(Authorization\s*:\s*Bearer|Bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
		.replace(
			/("?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|credential)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]*)/gi,
			'$1"[redacted]"',
		)
		.replace(/([?&](?:access_token|refresh_token|api[_-]?key|key|token|secret)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(/\b(?:sk|ghp|gho|ghu|ghs|glpat)-?[A-Za-z0-9_-]{12,}\b/g, "[redacted credential]")
		.replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b/g, "[redacted token]")
		.replace(/https?:\/\/[^\s)]+/gi, raw => {
			try {
				return new URL(raw).origin;
			} catch {
				return "[redacted URL]";
			}
		})
		.trim();
}
