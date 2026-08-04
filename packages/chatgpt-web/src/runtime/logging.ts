import type { ChatGptWebErrorClass } from "../provider/types";

export const CHATGPT_WEB_LOG_STAGES = Object.freeze([
	"startup",
	"ready",
	"login",
	"lease",
	"navigation",
	"submission",
	"response",
	"tool",
	"health",
	"shutdown",
] as const);

export type ChatGptWebLogStage = (typeof CHATGPT_WEB_LOG_STAGES)[number];

export interface ChatGptWebDiagnostic {
	readonly stage: ChatGptWebLogStage;
	readonly durationMs?: number;
	readonly count?: number;
	readonly exitCode?: number;
	readonly errorClass?: ChatGptWebErrorClass;
	/** Digest of a public, verified browser executable. */
	readonly executableHash?: string;
	/** Digest of the non-secret, package-owned model route. */
	readonly modelRouteHash?: string;
	/** Digest of a public protocol/schema version. */
	readonly protocolHash?: string;
}

export type StructuredLogSink = (diagnostic: ChatGptWebDiagnostic) => void;

export interface StructuredLogger {
	/** Returns false without calling the sink when the input is not exactly allowlisted. */
	log(input: unknown): boolean;
	/** Applies the identical allowlist used by log(), for CLI and health responses. */
	diagnostic(input: unknown): ChatGptWebDiagnostic | null;
}

const MAX_DURATION_MS = 86_400_000;
const MAX_COUNT = 1_000_000;
const MAX_EXIT_CODE = 0xffff_ffff;
const HASH_LENGTH = 64;

const ALLOWED_FIELDS: Record<string, true> = {
	stage: true,
	durationMs: true,
	count: true,
	exitCode: true,
	errorClass: true,
	executableHash: true,
	modelRouteHash: true,
	protocolHash: true,
};
const ALLOWED_FIELD_COUNT = 8;
const HASH_FIELDS = ["executableHash", "modelRouteHash", "protocolHash"] as const;
const STAGES: Record<ChatGptWebLogStage, true> = {
	startup: true,
	ready: true,
	login: true,
	lease: true,
	navigation: true,
	submission: true,
	response: true,
	tool: true,
	health: true,
	shutdown: true,
};
const ERROR_CLASSES: Record<ChatGptWebErrorClass, true> = {
	aborted: true,
	browser_unavailable: true,
	login_required: true,
	profile_conflict: true,
	selector_drift: true,
	tool_protocol: true,
	runtime_draining: true,
	malformed_browser_output: true,
	unsupported_context: true,
	internal: true,
};

type PlainRecord = Record<string, unknown>;
type MutableDiagnostic = {
	-readonly [Key in keyof ChatGptWebDiagnostic]: ChatGptWebDiagnostic[Key];
};

function isPlainRecord(input: unknown): input is PlainRecord {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function readDataProperty(record: PlainRecord, key: string): { present: false } | { present: true; value: unknown } {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(record, key);
	} catch {
		return { present: false };
	}
	if (!descriptor?.enumerable || !("value" in descriptor)) return { present: false };
	return { present: true, value: descriptor.value };
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isSha256(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== HASH_LENGTH) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
	}
	return true;
}

export function isChatGptWebErrorClass(value: unknown): value is ChatGptWebErrorClass {
	return typeof value === "string" && Object.hasOwn(ERROR_CLASSES, value);
}

/**
 * Builds a diagnostic without retaining rejected field values. Unknown keys are
 * rejected before their descriptors are read, and accessors are never invoked.
 */
export function createStructuredDiagnostic(input: unknown): ChatGptWebDiagnostic | null {
	if (!isPlainRecord(input)) return null;

	let keys: (string | symbol)[];
	try {
		keys = Reflect.ownKeys(input);
	} catch {
		return null;
	}
	if (keys.length === 0 || keys.length > ALLOWED_FIELD_COUNT) return null;
	for (const key of keys) {
		if (typeof key !== "string" || !Object.hasOwn(ALLOWED_FIELDS, key)) return null;
	}

	const stageProperty = readDataProperty(input, "stage");
	if (!stageProperty.present || typeof stageProperty.value !== "string" || !Object.hasOwn(STAGES, stageProperty.value))
		return null;

	const diagnostic: MutableDiagnostic = { stage: stageProperty.value as ChatGptWebLogStage };

	if (keys.includes("durationMs")) {
		const durationProperty = readDataProperty(input, "durationMs");
		if (!durationProperty.present || !isBoundedInteger(durationProperty.value, MAX_DURATION_MS)) return null;
		diagnostic.durationMs = durationProperty.value;
	}

	if (keys.includes("count")) {
		const countProperty = readDataProperty(input, "count");
		if (!countProperty.present || !isBoundedInteger(countProperty.value, MAX_COUNT)) return null;
		diagnostic.count = countProperty.value;
	}

	if (keys.includes("exitCode")) {
		const exitCodeProperty = readDataProperty(input, "exitCode");
		if (!exitCodeProperty.present || !isBoundedInteger(exitCodeProperty.value, MAX_EXIT_CODE)) return null;
		diagnostic.exitCode = exitCodeProperty.value;
	}

	if (keys.includes("errorClass")) {
		const errorClassProperty = readDataProperty(input, "errorClass");
		if (!errorClassProperty.present || !isChatGptWebErrorClass(errorClassProperty.value)) return null;
		diagnostic.errorClass = errorClassProperty.value;
	}

	for (const field of HASH_FIELDS) {
		if (!keys.includes(field)) continue;
		const property = readDataProperty(input, field);
		if (!property.present || !isSha256(property.value)) return null;
		diagnostic[field] = property.value;
	}

	return Object.freeze(diagnostic);
}

export function createStructuredLogger(sink: StructuredLogSink): StructuredLogger {
	return Object.freeze({
		log(input: unknown): boolean {
			const diagnostic = createStructuredDiagnostic(input);
			if (!diagnostic) return false;
			try {
				sink(diagnostic);
				return true;
			} catch {
				return false;
			}
		},
		diagnostic(input: unknown): ChatGptWebDiagnostic | null {
			return createStructuredDiagnostic(input);
		},
	});
}
