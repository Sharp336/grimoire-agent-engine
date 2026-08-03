import * as path from "node:path";

export const CHATGPT_WEB_API = "chatgpt-web" as const;
export const CHATGPT_WEB_BASE_URL = "chatgpt-web://local" as const;
export const CHATGPT_WEB_EXTENSION_SOURCE_ID = "@oh-my-pi/pi-chatgpt-web/extension" as const;

export interface KeylessProviderRequest {
	api: typeof CHATGPT_WEB_API;
	baseUrl: typeof CHATGPT_WEB_BASE_URL;
}

/** Host-issued wrapper whose capability is meaningful only by object identity. */
export interface KeylessProviderRegistration {
	readonly keylessCapability: object;
}

interface CapabilityRecord extends KeylessProviderRequest {
	sourceId: string;
	generation: number;
}

const capabilities = new WeakMap<object, CapabilityRecord>();
const liveGenerationBySource = new Map<string, number>();
const lastGenerationBySource = new Map<string, number>();
const acceptedGenerationBySource = new Map<string, number>();

function normalizeSourceId(sourceId: string): string {
	if (sourceId === CHATGPT_WEB_EXTENSION_SOURCE_ID) return sourceId;
	const normalized = path.normalize(path.resolve(sourceId));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const allowedChatGptWebExtensionSource = CHATGPT_WEB_EXTENSION_SOURCE_ID;

function isExactChatGptWebRequest(request: KeylessProviderRequest): boolean {
	return (
		request !== null &&
		typeof request === "object" &&
		request.api === CHATGPT_WEB_API &&
		request.baseUrl === CHATGPT_WEB_BASE_URL &&
		Object.keys(request).length === 2
	);
}

/**
 * Mint a source-scoped keyless capability for the package-owned ChatGPT Web extension.
 * Every issuance advances the source generation, immediately invalidating older handles.
 */
export function issueKeylessProviderRegistration(
	sourceId: string,
	request: KeylessProviderRequest,
): KeylessProviderRegistration | undefined {
	const normalizedSourceId = normalizeSourceId(sourceId);
	if (normalizedSourceId !== allowedChatGptWebExtensionSource || !isExactChatGptWebRequest(request)) {
		return undefined;
	}

	const generation = (lastGenerationBySource.get(normalizedSourceId) ?? 0) + 1;
	lastGenerationBySource.set(normalizedSourceId, generation);
	liveGenerationBySource.set(normalizedSourceId, generation);
	const keylessCapability = Object.freeze({});
	capabilities.set(keylessCapability, {
		sourceId: normalizedSourceId,
		api: request.api,
		baseUrl: request.baseUrl,
		generation,
	});
	return Object.freeze({ keylessCapability });
}

/** Validate capability identity and all source/route/generation bindings. */
export function validateKeylessProviderCapability(
	keylessCapability: object | undefined,
	sourceId: string | undefined,
	api: string | undefined,
	baseUrl: string | undefined,
): boolean {
	if (!keylessCapability || !sourceId) return false;
	const record = capabilities.get(keylessCapability);
	if (!record) return false;
	const normalizedSourceId = normalizeSourceId(sourceId);
	const valid =
		record.sourceId === normalizedSourceId &&
		record.api === api &&
		record.baseUrl === baseUrl &&
		liveGenerationBySource.get(normalizedSourceId) === record.generation;
	if (valid) acceptedGenerationBySource.set(normalizedSourceId, record.generation);
	return valid;
}

/**
 * Revoke the generation accepted by the registry while preserving a newer
 * capability issued during the current extension reload.
 */
export function revokeRegisteredKeylessProviderRegistrations(sourceId: string): void {
	const normalizedSourceId = normalizeSourceId(sourceId);
	const acceptedGeneration = acceptedGenerationBySource.get(normalizedSourceId);
	acceptedGenerationBySource.delete(normalizedSourceId);
	if (liveGenerationBySource.get(normalizedSourceId) === acceptedGeneration) {
		liveGenerationBySource.delete(normalizedSourceId);
	}
}

/** Revoke every capability generation issued to one extension source. */
export function revokeKeylessProviderRegistrations(sourceId: string): void {
	const normalizedSourceId = normalizeSourceId(sourceId);
	liveGenerationBySource.delete(normalizedSourceId);
	acceptedGenerationBySource.delete(normalizedSourceId);
}
