const REDACTED = "[REDACTED]";
const MAX_REDACTION_DEPTH = 8;

export interface RecordingLimits {
	readonly bodyContentTypes: ReadonlySet<string>;
	readonly maxEntries: number;
	readonly maxBodyBytes: number;
	readonly maxTotalBytes: number;
	readonly maxBodyWaitMs: number;
}

export interface NetworkRecorderOptions extends RecordingLimits {
	readonly origins: ReadonlySet<string>;
}

export const DEFAULT_RECORDING_LIMITS: RecordingLimits = {
	bodyContentTypes: new Set(["application/json", "application/x-www-form-urlencoded"]),
	maxEntries: 500,
	maxBodyBytes: 64 * 1024,
	maxTotalBytes: 2 * 1024 * 1024,
	maxBodyWaitMs: 1_000,
};

export interface RecordedRequest {
	readonly requestId: string;
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly postData?: string;
	/** CDP monotonic timestamp (seconds); used for elapsed timing. */
	readonly timestamp: number;
	/** CDP wall-clock time (epoch seconds); used for `startedDateTime`. */
	readonly wallTime?: number;
}

export interface RecordedResponse {
	readonly requestId: string;
	readonly url: string;
	readonly method?: string;
	readonly status: number;
	readonly statusText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly contentType?: string;
	readonly timestamp: number;
}

export interface RecordingSummary {
	readonly har: Record<string, unknown>;
	readonly entryCount: number;
	readonly capturedBodyCount: number;
	readonly omittedBodyCount: number;
	readonly totalBytes: number;
	readonly truncated: boolean;
}

type BodyOmissionReason = "content-type" | "size" | "unavailable" | "timeout" | "correlation";
type Header = { name: string; value: string };
type SafeContent = { mimeType: string; size: number; text?: string };
type Entry = {
	requestId: string;
	requestReceived: boolean;
	requestUrl: string;
	requestMethod: string;
	requestHeaders: Header[];
	requestPostData?: { mimeType: string; text: string };
	requestTimestamp: number;
	startedWallTime: number;
	responseUrl: string;
	responseStatus: number;
	responseStatusText: string;
	responseHeaders: Header[];
	responseMimeType: string;
	responseTimestamp: number;
	responseReceived: boolean;
	responseContent?: SafeContent;
	bodyState: "pending" | "captured" | "omitted";
	bodyOmission?: BodyOmissionReason;
	requestBodyOmission?: BodyOmissionReason;
};

const SENSITIVE_KEY =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|id[_-]?token|code|state|nonce|code[_-]?verifier|code[_-]?challenge|assertion|api[_-]?key|apikey|x-api-key|key|client[_-]?secret|secret|sig|signature|session|auth|csrf|password|account(?:id)?|user(?:id)|email|org(?:id)?|customer(?:id)?|client[_-]?id|credential|bearer)$/i;
const SENSITIVE_HEADER =
	/(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password|signature|bearer|credential|x-goog-api-key|x-api-key|x-amzn-trace-id|x-ms-request-id|x-user-email|x-user-id|x-account-id|x-customer-id|x-org-id|cf-connecting-ip|x-forwarded-for)/i;
const JWT_SHAPED = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENSITIVE_TOKEN =
	/^(?:authorization|cookie|token|secret|password|passwd|pwd|passphrase|session|csrf|xsrf|credential|credentials|bearer|signature|assertion|nonce|apikey|jwt|email|auth|otp|totp|mfa)$/;
const CREDENTIAL_VALUE = /^(?:bearer|basic|digest|negotiate|token|apikey)\s+[A-Za-z0-9+/_=.~-]{8,}$/i;
// High-signal provider credential shapes (bounded lengths) that leak under benign key names or
// header/body values and are missed by the JWT/email/scheme checks. Case-sensitive: the prefixes are literal.
const CREDENTIAL_PATTERN =
	/gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprse]-[0-9A-Za-z-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/;
const RELATIVE_URL_BASE = "http://redacted.invalid";
const SAFE_PATH_SEGMENTS = new Set([
	"api",
	"v1",
	"v2",
	"items",
	"item",
	"cart",
	"oauth",
	"authorize",
	"token",
	"reset",
	"verify",
	"recovery",
	"users",
	"user",
	"accounts",
	"account",
]);
const TOKEN_PATH_PREFIXES: Record<string, true> = { reset: true, verify: true, recovery: true };
// Plural PII collection parents whose immediate child is a per-subject identifier (numeric or short ID).
const PII_ID_PARENTS: Record<string, true> = { users: true, accounts: true, customers: true, orgs: true };

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Recording origin could not be parsed as an absolute URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Recording origin must use the http or https scheme");
	}
	if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error("Recording origin must be a bare http(s) origin without credentials, path, query, or fragment");
	}
	return parsed.origin.toLowerCase();
}

export function normalizeRecordingOrigins(origins: Iterable<string>): ReadonlySet<string> {
	const normalized = new Set<string>();
	for (const origin of origins) normalized.add(normalizeOrigin(origin));
	return normalized;
}

function isInScope(value: string, origins: ReadonlySet<string>): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && origins.has(parsed.origin.toLowerCase());
}

function sensitiveKey(key: string): boolean {
	const tokens = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s._-]+/)
		.filter(Boolean)
		.map(token => token.toLowerCase());
	if (tokens.length === 0) return false;
	if (tokens.some(token => SENSITIVE_TOKEN.test(token))) return true;
	return SENSITIVE_KEY.test(tokens.join("")) || SENSITIVE_KEY.test(tokens.join("-"));
}

function sensitiveValue(value: string): boolean {
	return (
		JWT_SHAPED.test(value) ||
		EMAIL_SHAPED.test(value) ||
		CREDENTIAL_VALUE.test(value) ||
		CREDENTIAL_PATTERN.test(value)
	);
}

function redactValue(value: string, key?: string): string {
	return (key && sensitiveKey(key)) || sensitiveValue(value) ? REDACTED : value;
}

function redactAny(value: unknown, depth = 0, key?: string): unknown {
	if (depth > MAX_REDACTION_DEPTH) return REDACTED;
	if (typeof value === "string") return redactValue(value, key);
	if (Array.isArray(value)) return value.map(item => redactAny(item, depth + 1));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			result[childKey] = sensitiveKey(childKey) ? REDACTED : redactAny(childValue, depth + 1, childKey);
		}
		return result;
	}
	return value;
}

function redactUrl(raw: string): string {
	let parsed: URL;
	let relative = false;
	try {
		parsed = new URL(raw);
	} catch {
		try {
			parsed = new URL(raw, RELATIVE_URL_BASE);
			relative = true;
		} catch {
			return REDACTED;
		}
	}
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	const segments = parsed.pathname.split("/");
	// Matrix/path parameters (`;key=value`, e.g. jsessionid) can carry secrets; drop them like the query.
	for (let index = 0; index < segments.length; index++) {
		const semicolon = segments[index].indexOf(";");
		if (semicolon !== -1) segments[index] = segments[index].slice(0, semicolon);
	}
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (!segment) continue;
		let decoded: string;
		let previous: string;
		try {
			decoded = decodeURIComponent(segment);
			previous = segments[index - 1] ? decodeURIComponent(segments[index - 1]).toLowerCase() : "";
		} catch {
			segments[index] = REDACTED;
			continue;
		}
		const opaque = decoded.length > 16 && /^[A-Za-z0-9_-]+$/.test(decoded);
		if (
			sensitiveKey(decoded) ||
			sensitiveKey(previous) ||
			sensitiveValue(decoded) ||
			TOKEN_PATH_PREFIXES[previous] === true ||
			// A short/numeric per-subject ID directly under a plural PII collection parent (users/accounts/customers/orgs).
			(PII_ID_PARENTS[previous] === true &&
				(/^\d+$/.test(decoded) ||
					(decoded.length <= 24 && /\d/.test(decoded) && /^[A-Za-z0-9_.-]+$/.test(decoded)))) ||
			(opaque && !SAFE_PATH_SEGMENTS.has(decoded.toLowerCase()))
		) {
			segments[index] = REDACTED;
		}
	}
	parsed.pathname = segments.join("/");
	return relative ? parsed.pathname : parsed.toString();
}

const URL_VALUE_HEADERS: Record<string, true> = { referer: true, location: true, "content-location": true };

function normalizeHeaders(headers: Readonly<Record<string, string>>): Header[] {
	const result: Header[] = [];
	for (const [name, rawValue] of Object.entries(headers)) {
		const lowerName = name.toLowerCase();
		let value: string;
		if (SENSITIVE_HEADER.test(lowerName)) value = REDACTED;
		else if (URL_VALUE_HEADERS[lowerName] === true) value = redactUrl(rawValue);
		// Link: `<url>; rel=...` (repeatable) — redact each angle-bracketed target.
		else if (lowerName === "link")
			value = rawValue.replace(/<([^>]*)>/g, (_match, url: string) => `<${redactUrl(url)}>`);
		// Refresh: `<seconds>; url=<target>` — redact only the target, keep the delay.
		else if (lowerName === "refresh") {
			value = rawValue.replace(
				/(\burl\s*=\s*)(["']?)(.*?)\2\s*$/i,
				(_match, prefix: string, quote: string, target: string) => `${prefix}${quote}${redactUrl(target)}${quote}`,
			);
		} else value = redactValue(rawValue);
		result.push({ name: lowerName, value });
	}
	return result;
}

function contentType(headers: Readonly<Record<string, string>>, explicit?: string): string {
	const value = explicit ?? Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
	return value.split(";", 1)[0].trim().toLowerCase();
}

function sanitizeBody(raw: string, mimeType: string): string {
	if (mimeType === "application/x-www-form-urlencoded") {
		const values: Record<string, unknown> = {};
		for (const [key, value] of new URLSearchParams(raw))
			values[key] = sensitiveKey(key) ? REDACTED : redactValue(value, key);
		return JSON.stringify(values);
	}
	try {
		return JSON.stringify(redactAny(JSON.parse(raw)));
	} catch {
		return sensitiveValue(raw) ? REDACTED : raw;
	}
}

function makeHarEntry(entry: Entry): Record<string, unknown> {
	const request: Record<string, unknown> = {
		method: entry.requestMethod,
		url: redactUrl(entry.requestUrl),
		headers: entry.requestHeaders,
	};
	if (entry.requestPostData)
		request.postData = { mimeType: entry.requestPostData.mimeType, text: entry.requestPostData.text };
	const elapsed = Math.max(0, (entry.responseTimestamp - entry.requestTimestamp) * 1000);
	return {
		startedDateTime: new Date(entry.startedWallTime * 1000).toISOString(),
		time: elapsed,
		request,
		response: {
			status: entry.responseStatus,
			statusText: entry.responseStatusText,
			headers: entry.responseHeaders,
			content: entry.responseContent ?? { mimeType: entry.responseMimeType, size: 0 },
		},
		timings: { send: 0, wait: elapsed, receive: 0 },
	};
}

function makeHar(entries: readonly Entry[]): Record<string, unknown> {
	return { log: { version: "1.2", creator: { name: "oh-my-pi", version: "1" }, entries: entries.map(makeHarEntry) } };
}

function mergeHeaderList(base: Header[], overlay: Header[]): Header[] {
	const byName = new Map<string, string>();
	for (const header of base) byName.set(header.name, header.value);
	for (const header of overlay) byName.set(header.name, header.value);
	return [...byName].map(([name, value]) => ({ name, value }));
}

export class NetworkRecorder {
	#entries = new Map<string, Entry>();
	#pendingBodies = new Map<string, string>();
	#pendingBodyBytes = 0;
	#pendingOmissions = new Map<string, BodyOmissionReason>();
	#omittedBodyCount = 0;
	#truncated = false;
	#disposed = false;
	#finished: RecordingSummary | undefined;
	readonly #options: NetworkRecorderOptions;

	constructor(options: NetworkRecorderOptions) {
		const minimumBytes = byteLength(JSON.stringify(makeHar([])));
		if (options.maxTotalBytes < minimumBytes)
			throw new Error("maxTotalBytes is smaller than the minimal HAR envelope");
		this.#options = { ...options, origins: normalizeRecordingOrigins(options.origins) };
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Network recorder has been disposed");
		if (this.#finished) throw new Error("Network recorder has finished");
	}

	recordRequest(request: RecordedRequest): void {
		this.#assertActive();
		if (!isInScope(request.url, this.#options.origins)) return;
		if (this.#entries.has(request.requestId)) return;
		if (this.#entries.size >= this.#options.maxEntries) {
			this.#truncated = true;
			return;
		}
		const mimeType = contentType(request.headers);
		const entry: Entry = {
			requestId: request.requestId,
			requestReceived: true,
			requestUrl: request.url,
			requestMethod: request.method,
			requestHeaders: normalizeHeaders(request.headers),
			requestTimestamp: request.timestamp,
			startedWallTime: request.wallTime ?? Date.now() / 1000,
			responseUrl: request.url,
			responseStatus: 0,
			responseStatusText: "",
			responseHeaders: [],
			responseMimeType: mimeType,
			responseTimestamp: request.timestamp,
			responseReceived: false,
			bodyState: "pending",
		};
		if (request.postData !== undefined) {
			if (!this.#options.bodyContentTypes.has(mimeType)) this.#omitRequestBody(entry, "content-type");
			else if (byteLength(request.postData) > this.#options.maxBodyBytes) this.#omitRequestBody(entry, "size");
			else entry.requestPostData = { mimeType, text: sanitizeBody(request.postData, mimeType) };
		}
		this.#entries.set(request.requestId, entry);
		const pendingOmission = this.#pendingOmissions.get(request.requestId);
		if (pendingOmission !== undefined) {
			this.#pendingOmissions.delete(request.requestId);
			this.#omit(entry, pendingOmission, true);
		}
	}

	recordResponse(response: RecordedResponse): void {
		this.#assertActive();
		if (!isInScope(response.url, this.#options.origins)) return;
		let entry = this.#entries.get(response.requestId);
		if (!entry) {
			if (this.#entries.size >= this.#options.maxEntries) {
				this.#truncated = true;
				return;
			}
			entry = {
				requestId: response.requestId,
				requestReceived: false,
				requestUrl: response.url,
				requestMethod: response.method ?? "UNKNOWN",
				requestHeaders: [],
				requestTimestamp: response.timestamp,
				startedWallTime: Date.now() / 1000,
				responseUrl: response.url,
				responseStatus: response.status,
				responseStatusText: response.statusText,
				responseHeaders: normalizeHeaders(response.headers),
				responseMimeType: contentType(response.headers, response.contentType),
				responseTimestamp: response.timestamp,
				responseReceived: true,
				bodyState: "pending",
			};
			this.#entries.set(response.requestId, entry);
			const pendingOmission = this.#pendingOmissions.get(response.requestId);
			if (pendingOmission !== undefined) {
				this.#pendingOmissions.delete(response.requestId);
				this.#omit(entry, pendingOmission, true);
			} else {
				this.#omit(entry, "correlation");
			}
		} else {
			entry.responseUrl = response.url;
			entry.responseStatus = response.status;
			entry.responseStatusText = response.statusText;
			entry.responseHeaders = normalizeHeaders(response.headers);
			entry.responseMimeType = contentType(response.headers, response.contentType);
			entry.responseTimestamp = response.timestamp;
			entry.responseReceived = true;
			if (response.method) entry.requestMethod = response.method;
		}
		const pendingBody = this.#pendingBodies.get(response.requestId);
		if (pendingBody !== undefined) {
			this.#pendingBodies.delete(response.requestId);
			this.#pendingBodyBytes -= byteLength(pendingBody);
			this.#attachBody(entry, pendingBody);
		}
	}

	recordRequestExtraHeaders(requestId: string, headers: Readonly<Record<string, string>>): boolean {
		this.#assertActive();
		const entry = this.#entries.get(requestId);
		if (!entry?.requestReceived) return false;
		entry.requestHeaders = mergeHeaderList(entry.requestHeaders, normalizeHeaders(headers));
		return true;
	}

	recordResponseExtraHeaders(requestId: string, headers: Readonly<Record<string, string>>): boolean {
		this.#assertActive();
		const entry = this.#entries.get(requestId);
		if (!entry?.responseReceived) return false;
		entry.responseHeaders = mergeHeaderList(entry.responseHeaders, normalizeHeaders(headers));
		return true;
	}

	recordResponseBody(requestId: string, body: string): void {
		this.#assertActive();
		const entry = this.#entries.get(requestId);
		if (!entry?.responseReceived) {
			this.#storePendingBody(requestId, body);
			return;
		}
		this.#attachBody(entry, body);
	}
	recordBodyOmitted(requestId: string, reason: BodyOmissionReason): void {
		this.#assertActive();
		const entry = this.#entries.get(requestId);
		if (entry) {
			this.#omit(entry, reason);
			return;
		}
		if (!this.#pendingOmissions.has(requestId) && !this.#pendingBodies.has(requestId)) {
			this.#pendingOmissions.set(requestId, reason);
			this.#omittedBodyCount++;
		}
	}

	#storePendingBody(requestId: string, body: string): void {
		if (this.#pendingOmissions.has(requestId) || this.#pendingBodies.has(requestId)) return;
		const bodyBytes = byteLength(body);
		const minimumBytes = byteLength(JSON.stringify(makeHar([])));
		const availableBytes = this.#options.maxTotalBytes - minimumBytes;
		if (
			bodyBytes > this.#options.maxBodyBytes ||
			bodyBytes > availableBytes ||
			this.#pendingBodies.size >= this.#options.maxEntries ||
			this.#pendingBodyBytes + bodyBytes > availableBytes
		) {
			this.#pendingOmissions.set(
				requestId,
				this.#pendingBodies.size >= this.#options.maxEntries ? "correlation" : "size",
			);
			this.#omittedBodyCount++;
			return;
		}
		this.#pendingBodies.set(requestId, body);
		this.#pendingBodyBytes += bodyBytes;
	}

	#omit(entry: Entry, reason: BodyOmissionReason, alreadyCounted = false): void {
		if (entry.bodyState === "captured" || entry.bodyState === "omitted") return;
		entry.bodyState = "omitted";
		entry.bodyOmission = reason;
		if (!alreadyCounted) this.#omittedBodyCount++;
	}
	#omitRequestBody(entry: Entry, reason: BodyOmissionReason): void {
		if (entry.requestBodyOmission) return;
		entry.requestBodyOmission = reason;
		this.#omittedBodyCount++;
	}

	#attachBody(entry: Entry, body: string): void {
		if (entry.bodyState === "omitted" || entry.bodyState === "captured") return;
		if (!this.#options.bodyContentTypes.has(entry.responseMimeType)) {
			this.#omit(entry, "content-type");
			return;
		}
		if (byteLength(body) > this.#options.maxBodyBytes) {
			this.#truncated = true;
			this.#omit(entry, "size");
			return;
		}
		entry.responseContent = {
			mimeType: entry.responseMimeType,
			size: byteLength(body),
			text: sanitizeBody(body, entry.responseMimeType),
		};
		entry.bodyState = "captured";
	}
	finish(): RecordingSummary {
		if (this.#finished) return this.#finished;
		if (this.#disposed) throw new Error("Network recorder has been disposed");
		for (const requestId of this.#pendingBodies.keys()) if (!this.#entries.has(requestId)) this.#omittedBodyCount++;
		this.#pendingBodies.clear();
		this.#pendingBodyBytes = 0;
		for (const entry of this.#entries.values()) if (entry.bodyState === "pending") this.#omit(entry, "unavailable");
		const allEntries = [...this.#entries.values()];
		let selected = allEntries;
		let har = makeHar(selected);
		let serialized = JSON.stringify(redactAny(har)) as string;
		while (byteLength(serialized) > this.#options.maxTotalBytes && selected.length > 0) {
			this.#truncated = true;
			selected = selected.slice(0, -1);
			har = makeHar(selected);
			serialized = JSON.stringify(redactAny(har)) as string;
		}
		const droppedBodyCount = allEntries.slice(selected.length).filter(entry => entry.bodyState === "captured").length;
		this.#omittedBodyCount += droppedBodyCount;
		const capturedBodyCount = selected.filter(entry => entry.bodyState === "captured").length;
		this.#finished = {
			har: JSON.parse(serialized) as Record<string, unknown>,
			entryCount: selected.length,
			capturedBodyCount,
			omittedBodyCount: this.#omittedBodyCount,
			totalBytes: byteLength(serialized),
			truncated: this.#truncated || selected.length !== allEntries.length,
		};
		this.#entries.clear();
		this.#pendingBodies.clear();
		this.#pendingBodyBytes = 0;
		this.#pendingOmissions.clear();
		return this.#finished;
	}

	dispose(): void {
		this.#disposed = true;
		this.#entries.clear();
		this.#pendingBodies.clear();
		this.#pendingBodyBytes = 0;
		this.#pendingOmissions.clear();
	}
}
