import { createHash } from "node:crypto";

const SAFE_ENGINE_ERROR =
	/^(?:AgentProfile|AvailableModelRoute|ProviderAccount|Provider quota|No usable AvailableModelRoute|The local OMP account|Failed to open auth database|Persistent credential block store|OAuth credential no longer exists|Engine mode|Engine session profile|selectedRouteRef|SQLite|SQLITE_|database (?:is|could not|cannot)|Cannot read private member|Receiver must be an instance|[^\s]+ is not a function|ENOENT|EACCES|EPERM|required_yield_not_submitted$|Unknown Engine failure$|[A-Za-z][A-Za-z0-9 ]* \(diagnostic [0-9a-f]{12}\)$|Retry budget exhausted after \d+ retries?: Thinking loop detected:|Thinking loop detected:)/i;

export function safeEngineErrorDetail(error: unknown): string {
	const name = error instanceof Error ? error.name || "Error" : "Error";
	const message = error instanceof Error ? error.message : String(error);
	const sanitized = sanitizeEngineErrorDetail(message).slice(0, 2_048);
	if (SAFE_ENGINE_ERROR.test(sanitized)) return sanitized;
	const fingerprint = createHash("sha256").update(`${name}\0${message}`).digest("hex").slice(0, 12);
	return `${name} (diagnostic ${fingerprint})`;
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
