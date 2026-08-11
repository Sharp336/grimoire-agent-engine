import { createHash } from "node:crypto";
import type {
	ApplyOnlySecretTable,
	PrimeConfigOperation,
	PrimeConfigParserResult,
	PrimeCredentialClassification,
	PrimeImportDomain,
	PrimeImportLoss,
	PrimeImportSourceDiscovery,
	PrimeJsonValue,
	PrimeNormalizedCredentialOperation,
	PrimeNormalizedHeaderValue,
	PrimeNormalizedModel,
	PrimeNormalizedModelOperation,
	PrimeNormalizedModelOverride,
	PrimeNormalizedSettingsOperation,
	PrimeNormalizedThinking,
	PrimeSourceFile,
	PrimeThinkingEffort,
} from "./types";
import { ApplyOnlySecretTable as SecretTable } from "./types";

const PRIME_PROVIDER_MAX_RETRY_DELAY_DEFAULT_MS = 60_000;
const PRIME_JSON_MAX_STRUCTURAL_DEPTH = 256;
const PRIME_JSON_MAX_NODES = 10_000;

const SETTING_PATHS: Readonly<Record<string, string>> = {
	defaultThinkingLevel: "defaultThinkingLevel",
	steeringMode: "steeringMode",
	followUpMode: "followUpMode",
	hideThinkingBlock: "hideThinkingBlock",
	shellPath: "shellPath",
	enabledModels: "enabledModels",
	treeFilterMode: "treeFilterMode",
	"compaction.enabled": "compaction.enabled",
	"compaction.reserveTokens": "compaction.reserveTokens",
	"compaction.keepRecentTokens": "compaction.keepRecentTokens",
	"retry.enabled": "retry.enabled",
	"retry.maxRetries": "retry.maxRetries",
	"retry.baseDelayMs": "retry.baseDelayMs",
	"retry.maxDelayMs": "retry.maxDelayMs",
	enableSkillCommands: "skills.enableSkillCommands",
};

const MODEL_FIELDS = new Set([
	"id",
	"name",
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"supportsTools",
	"cost",
	"premiumMultiplier",
	"contextWindow",
	"maxTokens",
	"omitMaxOutputTokens",
	"headers",
	"compat",
]);

const PROVIDER_FIELDS = new Set([
	"name",
	"baseUrl",
	"apiKey",
	"api",
	"headers",
	"compat",
	"authHeader",
	"auth",
	"models",
	"modelOverrides",
]);

const COMPAT_FIELDS = new Set([
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"maxTokensField",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"thinkingFormat",
	"cacheControlFormat",
	"openRouterRouting",
	"vercelGatewayRouting",
	"supportsStrictMode",
	"supportsLongCacheRetention",
	"supportsLongPromptCacheRetention",
	"supportsEagerToolInputStreaming",
]);
const UNSUPPORTED_COMPAT_FIELDS = new Set([
	"requiresReasoningContentOnAssistantMessages",
	"zaiToolStream",
	"sendSessionAffinityHeaders",
	"sendSessionIdHeader",
]);
const SUPPORTED_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
]);
const EFFORTS: readonly PrimeThinkingEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is PrimeJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	const pendingValues: unknown[] = [value];
	const pendingDepths: number[] = [0];
	let nodes = 1;
	while (pendingValues.length > 0) {
		const current = pendingValues.pop();
		const depth = pendingDepths.pop();
		if (current === undefined || depth === undefined) return false;
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return false;
			continue;
		}
		if (depth >= PRIME_JSON_MAX_STRUCTURAL_DEPTH) return false;
		if (Array.isArray(current)) {
			for (let index = current.length - 1; index >= 0; index--) {
				if (!Object.hasOwn(current, index)) continue;
				if (nodes >= PRIME_JSON_MAX_NODES) return false;
				nodes++;
				pendingValues.push(current[index]);
				pendingDepths.push(depth + 1);
			}
		} else if (isRecord(current)) {
			for (const key in current) {
				if (!Object.hasOwn(current, key)) continue;
				if (nodes >= PRIME_JSON_MAX_NODES) return false;
				nodes++;
				pendingValues.push(current[key]);
				pendingDepths.push(depth + 1);
			}
		} else {
			return false;
		}
	}
	return true;
}

function loss(
	code: PrimeImportLoss["code"],
	domain: PrimeImportDomain,
	sourceRef: string,
	field?: string,
): PrimeImportLoss {
	return field === undefined ? { code, domain, sourceRef } : { code, domain, sourceRef, path: field };
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function stripPrimeJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => (match[0] === '"' ? match : ""))
		.replace(
			/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
			(match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""),
		);
}

function jsonObject(
	file: PrimeSourceFile,
	comments: boolean,
	losses: PrimeImportLoss[],
): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = Buffer.from(file.contentBase64, "base64").toString("utf8");
	} catch {
		losses.push(
			loss(file.domain === "models" ? "models-malformed" : "config-malformed", file.domain, file.sourceRef),
		);
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(comments ? stripPrimeJsonComments(text) : text);
		if (!isRecord(parsed)) throw new SyntaxError("object required");
		return parsed;
	} catch {
		const code =
			file.domain === "models"
				? "models-malformed"
				: file.domain === "credentials"
					? "credentials-malformed"
					: "config-malformed";
		losses.push(loss(code, file.domain, file.sourceRef));
		return undefined;
	}
}
type SecretIdentity = Readonly<{
	sourceRef: string;
	kind: "credential" | "model-header";
	modelKind: "definition" | "override" | null;
	provider: string;
	modelIndex: number | null;
	modelId: string | null;
	headerName: string | null;
	headerIndex: number | null;
}>;

function opaqueCredentialId(identity: SecretIdentity): string {
	return `credential-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function classifyReference(value: unknown): PrimeCredentialClassification {
	if (typeof value !== "string" || value.length === 0) return "unknown";
	if (value.startsWith("!")) return "command_ref";
	if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return "env_or_literal_ref";
	return "literal_api_key";
}
function isPrototypeMetaKey(value: string): boolean {
	return value === "__proto__" || value === "prototype" || value === "constructor";
}

function invalidProvider(provider: string, includeModelDelimiters: boolean): boolean {
	return (
		provider.length === 0 ||
		provider.trim().length === 0 ||
		isPrototypeMetaKey(provider) ||
		/[\u0000-\u001f\u007f-\u009f]/u.test(provider) ||
		(includeModelDelimiters && (provider.includes(":definition:") || provider.includes(":override:")))
	);
}

// Keep provider validation before classification so invalid source keys cannot
// allocate a credential operation or put a value in the secret table.

function addCredential(
	provider: string,
	sourceRef: string,
	value: unknown,
	index: number,
	secretTable: SecretTable,
	credentials: PrimeNormalizedCredentialOperation[],
	losses: PrimeImportLoss[],
	forcedClassification?: PrimeCredentialClassification,
): PrimeNormalizedCredentialOperation | undefined {
	if (invalidProvider(provider, false)) {
		losses.push(loss("credentials-unknown", "credentials", sourceRef, provider));
		return undefined;
	}
	const classification = forcedClassification ?? classifyReference(value);
	if (classification === "unknown") {
		losses.push(loss("credentials-unknown", "credentials", sourceRef, provider));
		return undefined;
	}
	const operationId =
		classification === "literal_api_key"
			? opaqueCredentialId({
					sourceRef,
					kind: "credential",
					provider,
					modelKind: null,
					modelIndex: null,
					modelId: null,
					headerName: null,
					headerIndex: index,
				})
			: undefined;
	if (operationId && typeof value === "string") secretTable.add(operationId, value);
	const operation: PrimeNormalizedCredentialOperation = {
		kind: "credentials",
		provider,
		classification,
		metadata: { provider, classification, sourceRef, ...(operationId ? { secretOperationId: operationId } : {}) },
		sourceRefs: [sourceRef],
		...(operationId ? { secretOperationId: operationId } : {}),
	};
	credentials.push(operation);
	if (classification === "command_ref")
		losses.push(loss("credentials-command-ref", "credentials", sourceRef, provider));
	if (classification === "env_or_literal_ref")
		losses.push(loss("credentials-env-ref", "credentials", sourceRef, provider));
	return operation;
}

function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
	const migrated = { ...raw };
	if (migrated.steeringMode === undefined && (migrated.queueMode === "all" || migrated.queueMode === "one-at-a-time"))
		migrated.steeringMode = migrated.queueMode;
	if (migrated.transport === undefined && typeof migrated.websockets === "boolean")
		migrated.transport = migrated.websockets ? "websocket" : "sse";
	if (isRecord(migrated.skills)) {
		const skills = migrated.skills;
		if (migrated.enableSkillCommands === undefined && typeof skills.enableSkillCommands === "boolean")
			migrated.enableSkillCommands = skills.enableSkillCommands;
		if (Array.isArray(skills.customDirectories) && skills.customDirectories.length > 0)
			migrated.skills = skills.customDirectories;
		else delete migrated.skills;
	}
	if (isRecord(migrated.retry)) {
		const retry = { ...migrated.retry };
		if (retry.maxDelayMs !== undefined) {
			const provider = isRecord(retry.provider) ? { ...retry.provider } : {};
			if (provider.maxRetryDelayMs === undefined) provider.maxRetryDelayMs = retry.maxDelayMs;
			delete retry.maxDelayMs;
			retry.provider = provider;
		}
		migrated.retry = retry;
	}
	return migrated;
}

function normalizeApi(value: unknown, sourceRef: string, path: string, losses: PrimeImportLoss[]): string | undefined {
	if (typeof value !== "string") {
		if (value !== undefined) losses.push(loss("models-invalid-value", "models", sourceRef, path));
		return undefined;
	}
	if (!SUPPORTED_APIS.has(value)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, path));
		return undefined;
	}
	return value;
}

function settingValue(rawKey: string, value: unknown): { path: string; value: PrimeJsonValue } | undefined {
	if (!Object.hasOwn(SETTING_PATHS, rawKey)) return undefined;
	const path = SETTING_PATHS[rawKey];
	if (!isJsonValue(value)) return undefined;
	const booleanPaths = new Set([
		"hideThinkingBlock",
		"compaction.enabled",
		"retry.enabled",
		"skills.enableSkillCommands",
	]);
	const numberPaths = new Set([
		"compaction.reserveTokens",
		"compaction.keepRecentTokens",
		"retry.maxRetries",
		"retry.baseDelayMs",
		"retry.maxDelayMs",
	]);
	if (booleanPaths.has(path) && typeof value !== "boolean") return undefined;
	if (numberPaths.has(path) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return undefined;
	if (path === "enabledModels" && (!Array.isArray(value) || !value.every(item => typeof item === "string")))
		return undefined;
	if (
		path === "defaultThinkingLevel" &&
		(typeof value !== "string" || !([...EFFORTS, "auto", "off"] as readonly string[]).includes(value))
	)
		return undefined;
	if (path === "steeringMode" && value !== "all" && value !== "one-at-a-time") return undefined;
	if (path === "followUpMode" && value !== "all" && value !== "one-at-a-time") return undefined;
	if (path === "shellPath" && typeof value !== "string") return undefined;
	if (
		path === "treeFilterMode" &&
		!["default", "no-tools", "user-only", "labeled-only", "all"].includes(value as string)
	)
		return undefined;
	return { path, value };
}

interface CollectedSettings {
	values: Record<string, PrimeJsonValue>;
	replacesRetryProvider: boolean;
}

function collectSettings(
	file: PrimeSourceFile,
	settings: PrimeNormalizedSettingsOperation[],
	losses: PrimeImportLoss[],
): CollectedSettings | undefined {
	const parsed = jsonObject(file, false, losses);
	if (!parsed) return undefined;
	const migrated = migrateSettings(parsed);
	const replacesRetryProvider = isRecord(migrated.retry) && isRecord(migrated.retry.provider);
	if (parsed.apiKeys !== undefined && !isRecord(parsed.apiKeys))
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "apiKeys"));
	if (parsed.queueMode !== undefined && parsed.queueMode !== "all" && parsed.queueMode !== "one-at-a-time")
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "queueMode"));
	if (parsed.websockets !== undefined && typeof parsed.websockets !== "boolean")
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "websockets"));
	if (
		parsed.transport !== undefined &&
		parsed.transport !== "auto" &&
		parsed.transport !== "websocket" &&
		parsed.transport !== "sse"
	)
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "transport"));
	if (isRecord(parsed.skills)) {
		for (const [key, value] of Object.entries(parsed.skills)) {
			if (key === "enableSkillCommands") {
				if (typeof value !== "boolean")
					losses.push(loss("config-invalid-value", "settings", file.sourceRef, "skills.enableSkillCommands"));
			} else if (key === "customDirectories") {
				if (!Array.isArray(value) || !value.every(item => typeof item === "string"))
					losses.push(loss("config-invalid-value", "settings", file.sourceRef, "skills.customDirectories"));
			} else {
				losses.push(loss("config-unknown-field", "settings", file.sourceRef, `skills.${key}`));
			}
		}
	} else if (
		parsed.skills !== undefined &&
		(!Array.isArray(parsed.skills) || !parsed.skills.every(item => typeof item === "string"))
	) {
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "skills"));
	}
	if (
		parsed.telemetry !== undefined &&
		typeof parsed.telemetry !== "boolean" &&
		(!isRecord(parsed.telemetry) || Object.values(parsed.telemetry).some(value => typeof value !== "boolean"))
	)
		losses.push(loss("config-invalid-value", "settings", file.sourceRef, "telemetry"));
	if (isRecord(migrated.retry) && isRecord(migrated.retry.provider)) {
		const retry = { ...migrated.retry };
		const provider = { ...migrated.retry.provider };
		if (provider.maxRetryDelayMs !== undefined) {
			if (
				typeof provider.maxRetryDelayMs === "number" &&
				Number.isFinite(provider.maxRetryDelayMs) &&
				provider.maxRetryDelayMs >= 0
			)
				retry.maxDelayMs = provider.maxRetryDelayMs;
			else losses.push(loss("config-invalid-value", "settings", file.sourceRef, "retry.provider.maxRetryDelayMs"));
		}
		for (const key of Object.keys(provider)) {
			if (key !== "maxRetryDelayMs")
				losses.push(loss("config-unsupported-field", "settings", file.sourceRef, `retry.provider.${key}`));
		}
		delete retry.provider;
		migrated.retry = retry;
	}
	const values = Object.create(null) as Record<string, PrimeJsonValue>;
	for (const [key, value] of Object.entries(migrated)) {
		if (key === "defaultProvider" || key === "defaultModel") {
			if (typeof value === "string" && value.length > 0) values[key] = value;
			else losses.push(loss("config-invalid-value", "settings", file.sourceRef, key));
			continue;
		}
		if (
			key === "apiKeys" ||
			key === "queueMode" ||
			key === "websockets" ||
			key === "skills" ||
			key === "transport" ||
			key === "telemetry"
		)
			continue;
		const direct = settingValue(key, value);
		if (direct) {
			values[direct.path] = direct.value;
			continue;
		}
		if (isRecord(value)) {
			for (const [nestedKey, nestedValue] of Object.entries(value)) {
				const nestedPath = `${key}.${nestedKey}`;
				const nested = settingValue(nestedPath, nestedValue);
				if (nested) values[nested.path] = nested.value;
				else
					losses.push(
						loss(
							Object.hasOwn(SETTING_PATHS, nestedPath) ? "config-invalid-value" : "config-unknown-field",
							"settings",
							file.sourceRef,
							nestedPath,
						),
					);
			}
			continue;
		}
		losses.push(
			loss(
				Object.hasOwn(SETTING_PATHS, key) ? "config-invalid-value" : "config-unknown-field",
				"settings",
				file.sourceRef,
				key,
			),
		);
	}
	if (
		parsed.telemetry !== undefined &&
		(typeof parsed.telemetry === "boolean" ||
			(isRecord(parsed.telemetry) && Object.values(parsed.telemetry).every(value => typeof value === "boolean")))
	)
		losses.push(loss("config-unsupported-field", "settings", file.sourceRef, "telemetry"));
	if (isRecord(parsed.skills) && Array.isArray(parsed.skills.customDirectories))
		losses.push(loss("config-unsupported-field", "settings", file.sourceRef, "skills.customDirectories"));
	else if (Array.isArray(parsed.skills))
		losses.push(loss("config-unsupported-field", "settings", file.sourceRef, "skills"));
	if (
		(typeof parsed.transport === "string" &&
			(parsed.transport === "auto" || parsed.transport === "websocket" || parsed.transport === "sse")) ||
		(parsed.transport === undefined && typeof parsed.websockets === "boolean")
	)
		losses.push(
			loss(
				"config-unsupported-field",
				"settings",
				file.sourceRef,
				parsed.transport === undefined ? "websockets" : "transport",
			),
		);
	const scope = file.sourceRef.startsWith("project/") ? "project" : "global";
	const operation: PrimeNormalizedSettingsOperation = {
		kind: "settings",
		scope,
		values,
		sourceRefs: [file.sourceRef],
	};
	settings.push(operation);
	return { values, replacesRetryProvider };
}

function normalizedThinking(
	value: unknown,
	sourceRef: string,
	losses: PrimeImportLoss[],
): PrimeNormalizedThinking | undefined {
	if (!isRecord(value)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, "thinkingLevelMap"));
		return undefined;
	}
	const effortMap: Partial<Record<PrimeThinkingEffort, string>> = {};
	const efforts: PrimeThinkingEffort[] = [];
	const supportedKeys = new Set<string>([...EFFORTS, "off"]);
	for (const key of Object.keys(value)) {
		if (!supportedKeys.has(key))
			losses.push(loss("models-unsupported-compat", "models", sourceRef, `thinkingLevelMap.${key}`));
	}
	for (const effort of EFFORTS) {
		const mapped = value[effort];
		const alwaysSupported = effort === "minimal" || effort === "low" || effort === "medium" || effort === "high";
		if (mapped === null) continue;
		if (mapped === undefined && !alwaysSupported) continue;
		if (mapped !== undefined && typeof mapped !== "string") {
			losses.push(loss("models-invalid-value", "models", sourceRef, `thinkingLevelMap.${effort}`));
			continue;
		}
		efforts.push(effort);
		if (typeof mapped === "string") effortMap[effort] = mapped;
	}
	if (Object.hasOwn(value, "off")) {
		if (value.off !== null && typeof value.off !== "string")
			losses.push(loss("models-invalid-value", "models", sourceRef, "thinkingLevelMap.off"));
		else losses.push(loss("models-unsupported-compat", "models", sourceRef, "thinkingLevelMap.off"));
	}
	if (efforts.length === 0) {
		losses.push(loss("models-invalid-value", "models", sourceRef, "thinkingLevelMap"));
		return undefined;
	}
	return { mode: "effort", efforts, effortMap };
}

function normalizeCompat(
	value: unknown,
	sourceRef: string,
	losses: PrimeImportLoss[],
): Readonly<Record<string, PrimeJsonValue>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, "compat"));
		return undefined;
	}
	const compat = Object.create(null) as Record<string, PrimeJsonValue>;
	const booleans = new Set([
		"supportsStore",
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"requiresToolResultName",
		"requiresAssistantAfterToolResult",
		"requiresThinkingAsText",
		"supportsStrictMode",
		"supportsEagerToolInputStreaming",
		"supportsLongPromptCacheRetention",
	]);
	const enums: Readonly<Record<string, readonly string[]>> = {
		maxTokensField: ["max_completion_tokens", "max_tokens"],
		thinkingFormat: ["openai", "openrouter", "zai", "qwen", "qwen-chat-template"],
		cacheControlFormat: ["anthropic"],
	};
	for (const [key, raw] of Object.entries(value)) {
		if (UNSUPPORTED_COMPAT_FIELDS.has(key)) {
			losses.push(loss("models-unsupported-compat", "models", sourceRef, `compat.${key}`));
			continue;
		}
		if (!COMPAT_FIELDS.has(key)) {
			losses.push(
				loss(
					key.toLowerCase().includes("routing") ? "models-unsupported-routing" : "models-unsupported-compat",
					"models",
					sourceRef,
					`compat.${key}`,
				),
			);
			continue;
		}
		if (booleans.has(key)) {
			if (typeof raw !== "boolean") losses.push(loss("models-invalid-value", "models", sourceRef, `compat.${key}`));
			else compat[key] = raw;
			continue;
		}
		if (key === "supportsLongCacheRetention") {
			if (typeof raw !== "boolean") losses.push(loss("models-invalid-value", "models", sourceRef, `compat.${key}`));
			else compat.supportsLongPromptCacheRetention = raw;
			continue;
		}
		if (Object.hasOwn(enums, key)) {
			const allowed = enums[key];
			if (typeof raw !== "string") losses.push(loss("models-invalid-value", "models", sourceRef, `compat.${key}`));
			else if (!allowed.includes(raw))
				losses.push(loss("models-unsupported-compat", "models", sourceRef, `compat.${key}`));
			else compat[key] = raw;
			continue;
		}
		if (key === "openRouterRouting" || key === "vercelGatewayRouting") {
			if (!isRecord(raw)) {
				losses.push(loss("models-invalid-value", "models", sourceRef, `compat.${key}`));
				continue;
			}
			const routing = Object.create(null) as Record<string, PrimeJsonValue>;
			for (const [routingKey, routingValue] of Object.entries(raw)) {
				if (routingKey !== "only" && routingKey !== "order") {
					losses.push(loss("models-unsupported-routing", "models", sourceRef, `compat.${key}.${routingKey}`));
				} else if (!Array.isArray(routingValue) || !routingValue.every(item => typeof item === "string")) {
					losses.push(loss("models-invalid-value", "models", sourceRef, `compat.${key}.${routingKey}`));
				} else routing[routingKey] = routingValue;
			}
			if (Object.keys(routing).length > 0) compat[key] = routing;
			continue;
		}
		losses.push(loss("models-unsupported-compat", "models", sourceRef, `compat.${key}`));
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function normalizeHeaders(
	value: unknown,
	sourceRef: string,
	losses: PrimeImportLoss[],
	secretTable: SecretTable,
	provider: string,
	modelKind: "definition" | "override" | null,
	modelIndex: number | null,
	modelId: string | null,
): Readonly<Record<string, PrimeNormalizedHeaderValue>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, "headers"));
		return undefined;
	}
	const headers = Object.create(null) as Record<string, PrimeNormalizedHeaderValue>;
	let index = 0;
	for (const [key, raw] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
		if (typeof raw !== "string") {
			losses.push(loss("models-invalid-value", "models", sourceRef, `headers.${key}`));
			continue;
		}
		const classification = classifyReference(raw);
		if (classification === "command_ref") {
			losses.push(loss("credentials-command-ref", "credentials", sourceRef, `headers.${key}`));
			continue;
		}
		if (classification === "env_or_literal_ref") {
			losses.push(loss("credentials-env-ref", "credentials", sourceRef, `headers.${key}`));
			continue;
		}
		if (classification === "unknown") {
			losses.push(loss("credentials-unknown", "credentials", sourceRef, `headers.${key}`));
			continue;
		}
		const headerIndex = index++;
		const operationId = opaqueCredentialId({
			sourceRef,
			kind: "model-header",
			provider,
			modelKind,
			modelIndex,
			modelId,
			headerName: key,
			headerIndex,
		});
		secretTable.add(operationId, raw);
		headers[key] = { classification, secretOperationId: operationId };
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}
function normalizeCost(
	value: unknown,
	sourceRef: string,
	path: string,
	losses: PrimeImportLoss[],
): PrimeNormalizedModel["cost"] | undefined {
	if (!isRecord(value)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, path));
		return undefined;
	}
	const keys = Object.keys(value).sort();
	if (
		keys.join(",") !== "cacheRead,cacheWrite,input,output" ||
		keys.some(key => typeof value[key] !== "number" || !Number.isFinite(value[key]))
	) {
		losses.push(loss("models-invalid-value", "models", sourceRef, path));
		return undefined;
	}
	return {
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
	};
}

function normalizeModel(
	provider: string,
	providerConfig: Record<string, unknown>,
	modelValue: unknown,
	sourceRef: string,
	modelIndex: number,
	secretTable: SecretTable,
	losses: PrimeImportLoss[],
): PrimeNormalizedModel | undefined {
	if (!isRecord(modelValue)) {
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models`));
		return undefined;
	}
	for (const key of Object.keys(modelValue))
		if (!MODEL_FIELDS.has(key))
			losses.push(
				loss(
					key === "routing" ? "models-unsupported-routing" : "models-unknown-field",
					"models",
					sourceRef,
					`${provider}.models.${key}`,
				),
			);
	if (typeof modelValue.id !== "string" || modelValue.id.length === 0) {
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.id`));
		return undefined;
	}
	const cost =
		modelValue.cost !== undefined
			? normalizeCost(modelValue.cost, sourceRef, `${provider}.models.${modelValue.id}.cost`, losses)
			: undefined;
	const headers = normalizeHeaders(
		modelValue.headers,
		sourceRef,
		losses,
		secretTable,
		provider,
		"definition",
		modelIndex,
		modelValue.id,
	);
	const modelCompat = normalizeCompat(modelValue.compat, sourceRef, losses);
	const api = normalizeApi(
		modelValue.api ?? providerConfig.api,
		sourceRef,
		`${provider}.models.${modelValue.id}.api`,
		losses,
	);
	const baseUrl = modelValue.baseUrl ?? providerConfig.baseUrl;
	if (baseUrl !== undefined && (typeof baseUrl !== "string" || baseUrl.length === 0))
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.baseUrl`));
	const thinking =
		modelValue.thinkingLevelMap !== undefined
			? normalizedThinking(modelValue.thinkingLevelMap, sourceRef, losses)
			: undefined;
	const model: PrimeNormalizedModel = {
		id: modelValue.id,
		...(typeof modelValue.name === "string" && modelValue.name.length > 0 ? { name: modelValue.name } : {}),
		...(api ? { api } : {}),
		...(typeof baseUrl === "string" && baseUrl.length > 0 ? { baseUrl } : {}),
		...(typeof modelValue.reasoning === "boolean" ? { reasoning: modelValue.reasoning } : {}),
		...(thinking ? { thinking } : {}),
		...(Array.isArray(modelValue.input) && modelValue.input.every(item => item === "text" || item === "image")
			? { input: modelValue.input }
			: {}),
		...(typeof modelValue.supportsTools === "boolean" ? { supportsTools: modelValue.supportsTools } : {}),
		...(cost ? { cost } : {}),
		...(typeof modelValue.premiumMultiplier === "number" && Number.isFinite(modelValue.premiumMultiplier)
			? { premiumMultiplier: modelValue.premiumMultiplier }
			: {}),
		...(typeof modelValue.contextWindow === "number" && modelValue.contextWindow > 0
			? { contextWindow: modelValue.contextWindow }
			: {}),
		...(typeof modelValue.maxTokens === "number" && modelValue.maxTokens > 0
			? { maxTokens: modelValue.maxTokens }
			: {}),
		...(typeof modelValue.omitMaxOutputTokens === "boolean"
			? { omitMaxOutputTokens: modelValue.omitMaxOutputTokens }
			: {}),
		...(headers ? { headers } : {}),
		...(modelCompat ? { compat: modelCompat } : {}),
	};
	if (
		modelValue.input !== undefined &&
		!(Array.isArray(modelValue.input) && modelValue.input.every(item => item === "text" || item === "image"))
	)
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.input`));
	if (
		modelValue.contextWindow !== undefined &&
		!(typeof modelValue.contextWindow === "number" && modelValue.contextWindow > 0)
	)
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.contextWindow`),
		);
	if (modelValue.maxTokens !== undefined && !(typeof modelValue.maxTokens === "number" && modelValue.maxTokens > 0))
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.maxTokens`));
	if (modelValue.name !== undefined && (typeof modelValue.name !== "string" || modelValue.name.length === 0))
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.name`));
	if (modelValue.reasoning !== undefined && typeof modelValue.reasoning !== "boolean")
		losses.push(loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.reasoning`));
	if (modelValue.supportsTools !== undefined && typeof modelValue.supportsTools !== "boolean")
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.supportsTools`),
		);
	if (
		modelValue.premiumMultiplier !== undefined &&
		(typeof modelValue.premiumMultiplier !== "number" || !Number.isFinite(modelValue.premiumMultiplier))
	)
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.premiumMultiplier`),
		);
	if (modelValue.omitMaxOutputTokens !== undefined && typeof modelValue.omitMaxOutputTokens !== "boolean")
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `${provider}.models.${modelValue.id}.omitMaxOutputTokens`),
		);
	return model;
}

const OVERRIDE_FIELDS = new Set([
	"name",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"headers",
	"compat",
]);

function normalizeOverride(
	provider: string,
	overrideId: string,
	value: unknown,
	sourceRef: string,
	modelIndex: number,
	secretTable: SecretTable,
	losses: PrimeImportLoss[],
): PrimeNormalizedModelOverride | undefined {
	if (!isRecord(value)) {
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `providers.${provider}.modelOverrides.${overrideId}`),
		);
		return undefined;
	}
	for (const key of Object.keys(value))
		if (!OVERRIDE_FIELDS.has(key))
			losses.push(
				loss(
					"models-unknown-field",
					"models",
					sourceRef,
					`providers.${provider}.modelOverrides.${overrideId}.${key}`,
				),
			);
	if (value.name !== undefined && (typeof value.name !== "string" || value.name.length === 0))
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `providers.${provider}.modelOverrides.${overrideId}.name`),
		);
	if (value.reasoning !== undefined && typeof value.reasoning !== "boolean")
		losses.push(
			loss(
				"models-invalid-value",
				"models",
				sourceRef,
				`providers.${provider}.modelOverrides.${overrideId}.reasoning`,
			),
		);
	if (value.contextWindow !== undefined && (typeof value.contextWindow !== "number" || value.contextWindow <= 0))
		losses.push(
			loss(
				"models-invalid-value",
				"models",
				sourceRef,
				`providers.${provider}.modelOverrides.${overrideId}.contextWindow`,
			),
		);
	if (value.maxTokens !== undefined && (typeof value.maxTokens !== "number" || value.maxTokens <= 0))
		losses.push(
			loss(
				"models-invalid-value",
				"models",
				sourceRef,
				`providers.${provider}.modelOverrides.${overrideId}.maxTokens`,
			),
		);
	const headers = normalizeHeaders(
		value.headers,
		sourceRef,
		losses,
		secretTable,
		provider,
		"override",
		modelIndex,
		overrideId,
	);
	const thinking =
		value.thinkingLevelMap !== undefined ? normalizedThinking(value.thinkingLevelMap, sourceRef, losses) : undefined;
	const modelCompat = normalizeCompat(value.compat, sourceRef, losses);
	let cost: PrimeNormalizedModelOverride["cost"] | undefined;
	if (value.cost !== undefined) {
		if (!isRecord(value.cost))
			losses.push(
				loss(
					"models-invalid-value",
					"models",
					sourceRef,
					`providers.${provider}.modelOverrides.${overrideId}.cost`,
				),
			);
		else {
			const partial = Object.create(null) as Record<string, number>;
			for (const [key, raw] of Object.entries(value.cost)) {
				if (!["input", "output", "cacheRead", "cacheWrite"].includes(key))
					losses.push(
						loss(
							"models-unknown-field",
							"models",
							sourceRef,
							`providers.${provider}.modelOverrides.${overrideId}.cost.${key}`,
						),
					);
				else if (typeof raw !== "number" || !Number.isFinite(raw))
					losses.push(
						loss(
							"models-invalid-value",
							"models",
							sourceRef,
							`providers.${provider}.modelOverrides.${overrideId}.cost.${key}`,
						),
					);
				else partial[key] = raw;
			}
			if (Object.keys(partial).length > 0) cost = partial;
		}
	}
	if (
		value.input !== undefined &&
		(!Array.isArray(value.input) || !value.input.every(item => item === "text" || item === "image"))
	)
		losses.push(
			loss("models-invalid-value", "models", sourceRef, `providers.${provider}.modelOverrides.${overrideId}.input`),
		);
	return {
		id: overrideId,
		...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
		...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
		...(thinking ? { thinking } : {}),
		...(Array.isArray(value.input) && value.input.every(item => item === "text" || item === "image")
			? { input: value.input }
			: {}),
		...(cost ? { cost } : {}),
		...(typeof value.contextWindow === "number" && value.contextWindow > 0
			? { contextWindow: value.contextWindow }
			: {}),
		...(typeof value.maxTokens === "number" && value.maxTokens > 0 ? { maxTokens: value.maxTokens } : {}),
		...(headers ? { headers } : {}),
		...(modelCompat ? { compat: modelCompat } : {}),
	};
}

function collectModels(
	file: PrimeSourceFile,
	models: PrimeNormalizedModelOperation[],
	credentials: PrimeNormalizedCredentialOperation[],
	secretTable: SecretTable,
	losses: PrimeImportLoss[],
	credentialProviders: Set<string>,
): void {
	const parsed = jsonObject(file, true, losses);
	if (!parsed) return;
	for (const key of Object.keys(parsed))
		if (key !== "providers") losses.push(loss("models-unknown-field", "models", file.sourceRef, key));
	if (!isRecord(parsed.providers)) {
		losses.push(loss("models-invalid-value", "models", file.sourceRef, "providers"));
		return;
	}
	for (const [provider, rawConfig] of Object.entries(parsed.providers).sort(([left], [right]) =>
		compareStrings(left, right),
	)) {
		if (invalidProvider(provider, true)) {
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}`));
			continue;
		}
		if (!isRecord(rawConfig)) {
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}`));
			continue;
		}
		for (const key of Object.keys(rawConfig))
			if (!PROVIDER_FIELDS.has(key))
				losses.push(loss("models-unknown-field", "models", file.sourceRef, `providers.${provider}.${key}`));
		if (rawConfig.name !== undefined)
			losses.push(loss("models-unsupported-compat", "models", file.sourceRef, `providers.${provider}.name`));
		if (rawConfig.baseUrl !== undefined && (typeof rawConfig.baseUrl !== "string" || rawConfig.baseUrl.length === 0))
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}.baseUrl`));
		if (rawConfig.authHeader !== undefined && typeof rawConfig.authHeader !== "boolean")
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}.authHeader`));
		if (
			rawConfig.auth !== undefined &&
			rawConfig.auth !== "apiKey" &&
			rawConfig.auth !== "none" &&
			rawConfig.auth !== "oauth"
		)
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}.auth`));
		const providerApiKey = rawConfig.apiKey === undefined ? undefined : classifyReference(rawConfig.apiKey);
		let selectedCredential = credentials.find(item => item.provider === provider);
		if (!selectedCredential && providerApiKey) {
			selectedCredential = addCredential(
				provider,
				file.sourceRef,
				rawConfig.apiKey,
				credentials.length,
				secretTable,
				credentials,
				losses,
			);
			if (selectedCredential) credentialProviders.add(provider);
		}
		if (!selectedCredential && rawConfig.auth === "oauth") {
			selectedCredential = addCredential(
				provider,
				file.sourceRef,
				rawConfig.auth,
				credentials.length,
				secretTable,
				credentials,
				losses,
				"oauth_relogin",
			);
			if (selectedCredential) credentialProviders.add(provider);
		}
		if (!selectedCredential && rawConfig.auth === "none") {
			selectedCredential = addCredential(
				provider,
				file.sourceRef,
				rawConfig.auth,
				credentials.length,
				secretTable,
				credentials,
				losses,
				"ambient_dependency",
			);
			if (selectedCredential) credentialProviders.add(provider);
		}
		const providerApiKeyInfo = selectedCredential
			? {
					classification: selectedCredential.classification,
					...(selectedCredential.secretOperationId
						? { secretOperationId: selectedCredential.secretOperationId }
						: {}),
				}
			: undefined;
		const providerApi = normalizeApi(rawConfig.api, file.sourceRef, `providers.${provider}.api`, losses);
		const normalizedProviderConfig: Record<string, unknown> = {
			...(providerApi ? { api: providerApi } : {}),
			...(typeof rawConfig.baseUrl === "string" && rawConfig.baseUrl.length > 0
				? { baseUrl: rawConfig.baseUrl }
				: {}),
		};
		const providerHeaders = normalizeHeaders(
			rawConfig.headers,
			file.sourceRef,
			losses,
			secretTable,
			provider,
			null,
			null,
			null,
		);
		const providerCompat = normalizeCompat(rawConfig.compat, file.sourceRef, losses);
		if (providerCompat) normalizedProviderConfig.compat = providerCompat;
		const rawModels = rawConfig.models;
		if (rawModels !== undefined && !Array.isArray(rawModels))
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}.models`));
		if (Array.isArray(rawModels)) {
			for (const [modelIndex, rawModel] of rawModels.entries()) {
				const model = normalizeModel(
					provider,
					normalizedProviderConfig,
					rawModel,
					file.sourceRef,
					modelIndex,
					secretTable,
					losses,
				);
				if (!model) continue;
				const modelOperation: PrimeNormalizedModelOperation = {
					kind: "models",
					modelKind: "definition",
					provider,
					model,
					sourceRefs: [file.sourceRef],
					...(providerApiKeyInfo ? { providerApiKey: providerApiKeyInfo } : {}),
					providerConfig: {
						...(typeof rawConfig.baseUrl === "string" && rawConfig.baseUrl.length > 0
							? { baseUrl: rawConfig.baseUrl }
							: {}),
						...(providerApi ? { api: providerApi } : {}),
						...(providerHeaders ? { headers: providerHeaders } : {}),
						...(providerCompat ? { compat: providerCompat } : {}),
						...(typeof rawConfig.authHeader === "boolean" ? { authHeader: rawConfig.authHeader } : {}),
						...(rawConfig.auth === "apiKey" || rawConfig.auth === "none" || rawConfig.auth === "oauth"
							? { auth: rawConfig.auth }
							: {}),
					},
				};
				models.push(modelOperation);
			}
		}
		const rawOverrides = rawConfig.modelOverrides;
		if (rawOverrides !== undefined && !isRecord(rawOverrides))
			losses.push(loss("models-invalid-value", "models", file.sourceRef, `providers.${provider}.modelOverrides`));
		if (isRecord(rawOverrides)) {
			for (const [overrideIndex, [overrideId, rawOverride]] of Object.entries(rawOverrides)
				.sort(([left], [right]) => compareStrings(left, right))
				.entries()) {
				if (overrideId.length === 0 || isPrototypeMetaKey(overrideId)) {
					losses.push(
						loss(
							"models-invalid-value",
							"models",
							file.sourceRef,
							`providers.${provider}.modelOverrides.${overrideId}`,
						),
					);
					continue;
				}
				const override = normalizeOverride(
					provider,
					overrideId,
					rawOverride,
					file.sourceRef,
					overrideIndex,
					secretTable,
					losses,
				);
				if (!override) continue;
				models.push({
					kind: "models",
					modelKind: "override",
					provider,
					model: override,
					sourceRefs: [file.sourceRef],
					...(providerApiKeyInfo ? { providerApiKey: providerApiKeyInfo } : {}),
					providerConfig: {
						...(typeof rawConfig.baseUrl === "string" && rawConfig.baseUrl.length > 0
							? { baseUrl: rawConfig.baseUrl }
							: {}),
						...(providerApi ? { api: providerApi } : {}),
						...(providerHeaders ? { headers: providerHeaders } : {}),
						...(providerCompat ? { compat: providerCompat } : {}),
						...(typeof rawConfig.authHeader === "boolean" ? { authHeader: rawConfig.authHeader } : {}),
						...(rawConfig.auth === "apiKey" || rawConfig.auth === "none" || rawConfig.auth === "oauth"
							? { auth: rawConfig.auth }
							: {}),
					},
				});
			}
		}
	}
}

function collectLegacyCredentials(
	file: PrimeSourceFile,
	credentials: PrimeNormalizedCredentialOperation[],
	secretTable: SecretTable,
	losses: PrimeImportLoss[],
	seenProviders: ReadonlySet<string>,
): void {
	const parsed = jsonObject(file, false, losses);
	if (!parsed) return;
	for (const [provider, value] of Object.entries(parsed).sort(([left], [right]) => compareStrings(left, right))) {
		if (seenProviders.has(provider)) continue;
		if (file.sourceRef.endsWith("oauth.json")) {
			if (!isRecord(value)) {
				losses.push(loss("credentials-unknown", "credentials", file.sourceRef, provider));
				continue;
			}
			addCredential(
				provider,
				file.sourceRef,
				value,
				credentials.length,
				secretTable,
				credentials,
				losses,
				"oauth_relogin",
			);
			continue;
		}
		if (!isRecord(value)) {
			losses.push(loss("credentials-unknown", "credentials", file.sourceRef, provider));
			continue;
		}
		if (value.type === "oauth")
			addCredential(
				provider,
				file.sourceRef,
				value,
				credentials.length,
				secretTable,
				credentials,
				losses,
				"oauth_relogin",
			);
		else if (value.type === "api_key")
			addCredential(provider, file.sourceRef, value.key, credentials.length, secretTable, credentials, losses);
		else if (value.type === "ambient")
			addCredential(
				provider,
				file.sourceRef,
				value,
				credentials.length,
				secretTable,
				credentials,
				losses,
				"ambient_dependency",
			);
		else losses.push(loss("credentials-unknown", "credentials", file.sourceRef, provider));
	}
}

function collectSettingsCredentials(
	file: PrimeSourceFile,
	credentials: PrimeNormalizedCredentialOperation[],
	secretTable: SecretTable,
	losses: PrimeImportLoss[],
	seenProviders: Set<string>,
): void {
	const parsed = jsonObject(file, false, losses);
	const apiKeys = parsed?.apiKeys;
	if (!isRecord(apiKeys)) return;
	for (const [provider, value] of Object.entries(apiKeys).sort(([left], [right]) => compareStrings(left, right))) {
		if (seenProviders.has(provider)) continue;
		const credential = addCredential(
			provider,
			file.sourceRef,
			value,
			credentials.length,
			secretTable,
			credentials,
			losses,
		);
		if (credential) seenProviders.add(provider);
	}
}

export function parsePrimeConfig(discovery: PrimeImportSourceDiscovery): PrimeConfigParserResult {
	const settings: PrimeNormalizedSettingsOperation[] = [];
	const models: PrimeNormalizedModelOperation[] = [];
	const credentials: PrimeNormalizedCredentialOperation[] = [];
	const losses: PrimeImportLoss[] = [...discovery.losses];
	const secretTable: ApplyOnlySecretTable = new SecretTable();
	const filesByRef = new Map(discovery.inventory.files.map(file => [file.sourceRef, file]));
	const globalSettings = filesByRef.get("global/settings.json");
	const projectSettings = filesByRef.get("project/settings.json");
	const globalCollected = globalSettings ? collectSettings(globalSettings, settings, losses) : undefined;
	const projectCollected = projectSettings ? collectSettings(projectSettings, settings, losses) : undefined;
	if (
		projectCollected?.replacesRetryProvider &&
		globalCollected?.values["retry.maxDelayMs"] !== undefined &&
		projectCollected.values["retry.maxDelayMs"] === undefined
	)
		projectCollected.values["retry.maxDelayMs"] = PRIME_PROVIDER_MAX_RETRY_DELAY_DEFAULT_MS;
	const defaultProviderScope = settings.findLast(operation => operation.values.defaultProvider !== undefined)?.scope;
	const defaultModelScope = settings.findLast(operation => operation.values.defaultModel !== undefined)?.scope;
	const defaultThinkingScope = settings.findLast(
		operation => operation.values.defaultThinkingLevel !== undefined,
	)?.scope;
	const defaultProvider = settings.reduce<PrimeJsonValue | undefined>(
		(value, operation) => operation.values.defaultProvider ?? value,
		undefined,
	);
	const defaultModel = settings.reduce<PrimeJsonValue | undefined>(
		(value, operation) => operation.values.defaultModel ?? value,
		undefined,
	);
	const defaultThinkingLevel = settings.reduce<PrimeJsonValue | undefined>(
		(value, operation) => operation.values.defaultThinkingLevel ?? value,
		undefined,
	);
	for (let index = 0; index < settings.length; index++) {
		const values = { ...settings[index].values };
		delete values.defaultProvider;
		delete values.defaultModel;
		if (defaultThinkingLevel === "off" || values.defaultThinkingLevel === "off") delete values.defaultThinkingLevel;
		settings[index] = { ...settings[index], values };
	}
	const effectiveSettings = Object.create(null) as Record<string, PrimeJsonValue>;
	for (const operation of settings) Object.assign(effectiveSettings, operation.values);
	const completeDefault =
		typeof defaultProvider === "string" &&
		defaultProvider.length > 0 &&
		typeof defaultModel === "string" &&
		defaultModel.length > 0;
	if (completeDefault) {
		const role = `${defaultProvider}/${defaultModel}${defaultThinkingLevel === "off" ? ":off" : ""}`;
		effectiveSettings.modelRoles = { default: role };
		const roleScope =
			defaultProviderScope === "project" ||
			defaultModelScope === "project" ||
			(defaultThinkingLevel === "off" && defaultThinkingScope === "project")
				? "project"
				: "global";
		const targetIndex = settings.findLastIndex(operation => operation.scope === roleScope);
		if (targetIndex >= 0) {
			const target = settings[targetIndex];
			settings[targetIndex] = { ...target, values: { ...target.values, modelRoles: { default: role } } };
		}
	} else if (defaultProvider !== undefined || defaultModel !== undefined || defaultThinkingLevel === "off") {
		const sourceRef = projectSettings?.sourceRef ?? globalSettings?.sourceRef ?? "global/settings.json";
		losses.push(loss("config-unsupported-field", "settings", sourceRef, "modelRoles.default"));
	}
	const authFiles = ["global/auth.json", "global/oauth.json"]
		.map(sourceRef => filesByRef.get(sourceRef))
		.filter((file): file is PrimeSourceFile => file !== undefined);
	const credentialProviders = new Set<string>();
	for (const file of authFiles) {
		const before = credentials.length;
		collectLegacyCredentials(file, credentials, secretTable, losses, credentialProviders);
		for (const item of credentials.slice(before)) credentialProviders.add(item.provider);
	}
	if (projectSettings)
		collectSettingsCredentials(projectSettings, credentials, secretTable, losses, credentialProviders);
	if (globalSettings)
		collectSettingsCredentials(globalSettings, credentials, secretTable, losses, credentialProviders);
	const modelsFile = filesByRef.get("global/models.json");
	if (modelsFile) collectModels(modelsFile, models, credentials, secretTable, losses, credentialProviders);
	const operations: PrimeConfigOperation[] = [...settings, ...models, ...credentials];
	const sortedLosses = losses.sort((left, right) => {
		const source = compareStrings(left.sourceRef, right.sourceRef);
		if (source !== 0) return source;
		const path = compareStrings(left.path ?? "", right.path ?? "");
		if (path !== 0) return path;
		return compareStrings(left.code, right.code);
	});
	return { settings, effectiveSettings, models, credentials, operations, losses: sortedLosses, secretTable };
}
