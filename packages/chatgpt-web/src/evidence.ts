export const CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface ChatGptWebLocalEvidence {
	readonly schemaVersion: typeof CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION;
	readonly commit: string;
	readonly os: string;
	readonly arch: string;
	readonly bunVersion: string;
	readonly browserVersion: string;
	readonly scenarioId: string;
	readonly passed: boolean;
	readonly invariants: Readonly<Record<string, boolean>>;
}

const FORBIDDEN_KEY = /(?:account|cookie|credential|profile|path|raw|response|secret|token)/iu;
const FORBIDDEN_VALUE =
	/(?:authorization\s*[:=]|bearer\s+|cookie\s*[:=]|(?:^|[\\/])(?:users|home|tmp|appdata)(?:[\\/]|$)|(?:^|\s)[a-z0-9_-]*(?:token|cookie|secret|credential)[a-z0-9_-]*(?:$|\s))/iu;

function assertSafeString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || FORBIDDEN_VALUE.test(value)) {
		throw new Error(`ChatGPT Web evidence field is unsafe: ${field}`);
	}
}

export function assertSafeChatGptWebEvidence(value: unknown): asserts value is ChatGptWebLocalEvidence {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("ChatGPT Web evidence must be an object");
	const record = value as Record<string, unknown>;
	const expectedKeys: Record<string, true> = {
		schemaVersion: true,
		commit: true,
		os: true,
		arch: true,
		bunVersion: true,
		browserVersion: true,
		scenarioId: true,
		passed: true,
		invariants: true,
	};
	for (const key of Object.keys(record)) {
		if (!expectedKeys[key] || FORBIDDEN_KEY.test(key))
			throw new Error(`ChatGPT Web evidence field is not allowlisted: ${key}`);
	}
	if (record.schemaVersion !== CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION)
		throw new Error("Unsupported ChatGPT Web evidence schema");
	for (const field of ["commit", "os", "arch", "bunVersion", "browserVersion", "scenarioId"])
		assertSafeString(record[field], field);
	if (typeof record.passed !== "boolean") throw new Error("ChatGPT Web evidence pass/fail is invalid");
	if (record.invariants === null || typeof record.invariants !== "object" || Array.isArray(record.invariants)) {
		throw new Error("ChatGPT Web evidence invariants are invalid");
	}
	for (const [key, result] of Object.entries(record.invariants as Record<string, unknown>)) {
		if (!/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/u.test(key) || typeof result !== "boolean") {
			throw new Error(`ChatGPT Web evidence invariant is invalid: ${key}`);
		}
	}
}

export function createChatGptWebLocalEvidence(
	value: Omit<ChatGptWebLocalEvidence, "schemaVersion">,
): ChatGptWebLocalEvidence {
	const evidence = { schemaVersion: CHATGPT_WEB_EVIDENCE_SCHEMA_VERSION, ...value } satisfies ChatGptWebLocalEvidence;
	assertSafeChatGptWebEvidence(evidence);
	return Object.freeze({ ...evidence, invariants: Object.freeze({ ...evidence.invariants }) });
}
