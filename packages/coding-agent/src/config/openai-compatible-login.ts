import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FetchImpl, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import { isEnoent, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { withTimeoutSignal } from "../utils/fetch-timeout";
import { withFileLock } from "./file-lock";
import { normalizeOpenAIModelsListBaseUrl } from "./model-discovery";
import { ModelsConfigFile, validateModelsConfig } from "./models-config";
import type { ModelsConfig } from "./models-config-schema";
import { MODELS_CONFIG_API_IDS } from "./models-config-schema-bundle";
import { OPENAI_COMPATIBLE_LITERAL_API_KEY_FIELD } from "./openai-compatible-api-key";

export const OPENAI_COMPATIBLE_LOGIN_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_API_IDS = ["openai-completions", "openai-responses"] as const;
const OPENAI_COMPATIBLE_PROBE_TIMEOUT_MS = 10_000;

export interface OpenAICompatibleEndpoint {
	providerName: string;
	baseUrl: string;
	apiKey: string;
}

export type OpenAICompatibleProbeResult = { ok: true; models: string[] } | { ok: false; error: string };

function formatResponseBody(body: string): string {
	const trimmed = sanitizeText(body).trim();
	if (!trimmed) return "(empty response body)";
	return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 2_000)}…`;
}

/** Validates and canonicalizes a user-entered OpenAI-compatible API base URL. */
export function normalizeOpenAICompatibleBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Base URL must be a well-formed absolute http(s) URL.");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw new Error("Base URL must be a well-formed absolute http(s) URL.");
	}
	if (url.search || url.hash) {
		throw new Error("Base URL must not include a query string or fragment.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return normalizeOpenAIModelsListBaseUrl(url.toString());
}

/** Rejects names that would replace a bundled provider rather than add a custom one. */
export function validateOpenAICompatibleProviderName(value: string): string {
	const providerName = value.trim();
	if (!providerName) throw new Error("Provider name is required.");
	if (/[\\/]/.test(providerName)) {
		throw new Error("Provider name must not contain forward or back slashes.");
	}
	if (PROVIDER_REGISTRY.some(provider => provider.id.toLowerCase() === providerName.toLowerCase())) {
		throw new Error(`Provider name "${providerName}" is built in. Choose a different name.`);
	}
	return providerName;
}

/** Validates an API identifier through the same schema used for models.yml. */
export function validateOpenAICompatibleApi(value: string | undefined): string {
	const api = value?.trim() || "openai-completions";
	const isCompatible = OPENAI_COMPATIBLE_API_IDS.includes(api as (typeof OPENAI_COMPATIBLE_API_IDS)[number]);
	const isSchemaValid = MODELS_CONFIG_API_IDS.includes(api as (typeof MODELS_CONFIG_API_IDS)[number]);
	if (!isCompatible || !isSchemaValid) {
		throw new Error(`API "${api}" is not supported by OpenAI-compatible endpoints.`);
	}
	return api;
}

/** Probes the standard OpenAI `GET /models` endpoint and returns usable model ids. */
export async function probeOpenAICompatibleEndpoint(
	endpoint: Pick<OpenAICompatibleEndpoint, "baseUrl" | "apiKey">,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<OpenAICompatibleProbeResult> {
	const baseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
	let response: Response;
	let body: string;
	try {
		response = await fetchImpl(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${endpoint.apiKey}` },
			signal: withTimeoutSignal(OPENAI_COMPATIBLE_PROBE_TIMEOUT_MS, signal),
		});
		body = await response.text();
	} catch (error) {
		return {
			ok: false,
			error: `Could not reach ${baseUrl}/models: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!response.ok) {
		return { ok: false, error: `GET /models failed (${response.status}): ${formatResponseBody(body)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, error: `GET /models returned non-JSON: ${formatResponseBody(body)}` };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
		return { ok: false, error: "GET /models returned JSON without a data array." };
	}
	const models = [
		...new Set(
			parsed.data.flatMap(item => (isRecord(item) && typeof item.id === "string" && item.id ? [item.id] : [])),
		),
	];
	if (models.length === 0) {
		return { ok: false, error: "GET /models returned an empty data array or no usable model ids." };
	}
	return { ok: true, models };
}

async function readModelsConfigForWrite(filePath: string): Promise<Record<string, unknown>> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
	if (!content.trim()) return {};
	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(
			`Cannot update ${filePath}: it contains invalid YAML (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Cannot update ${filePath}: the root must be a YAML mapping.`);
	}
	return parsed;
}

async function resolveModelsConfigWritePath(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const stat = await fs.lstat(filePath).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stat?.isSymbolicLink()) return filePath;
	return path.resolve(path.dirname(filePath), await fs.readlink(filePath));
}

async function writeModelsConfigAtomically(
	filePath: string,
	config: ModelsConfig,
	providerName: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<void> {
	const resolvedPath = await resolveModelsConfigWritePath(filePath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
	const tempPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
	const apiKeyMarker = `__OMP_OPENAI_COMPAT_API_KEY_${randomUUID()}__`;
	const serialized = YAML.stringify(
		{
			...config,
			providers: {
				...config.providers,
				[providerName]: {
					...config.providers?.[providerName],
					[OPENAI_COMPATIBLE_LITERAL_API_KEY_FIELD]: apiKeyMarker,
				},
			},
		},
		null,
		2,
	);
	const content = serialized.replace(apiKeyMarker, JSON.stringify(apiKey));
	try {
		signal?.throwIfAborted();
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		signal?.throwIfAborted();
		await fs.rename(tempPath, resolvedPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Upserts a custom OpenAI-compatible provider with its API key in models.yml.
 * Runtime discovery keeps the provider's model catalog current.
 */
export async function writeOpenAICompatibleProvider(
	endpoint: OpenAICompatibleEndpoint & { api?: string },
	modelsPath?: string,
	signal?: AbortSignal,
): Promise<string> {
	const providerName = validateOpenAICompatibleProviderName(endpoint.providerName);
	const baseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
	const apiKey = endpoint.apiKey.trim();
	if (!apiKey) throw new Error("API key is required.");
	const api = validateOpenAICompatibleApi(endpoint.api);
	const configFile = ModelsConfigFile.relocate(modelsPath);
	configFile.invalidate();
	const existingConfig = configFile.tryLoad();
	if (existingConfig.status === "error") {
		throw new Error(
			`Cannot update ${configFile.path()}: the existing models.yml is invalid: ${existingConfig.error.message}`,
		);
	}
	const resolvedModelsPath = configFile.path();
	await fs.mkdir(path.dirname(resolvedModelsPath), { recursive: true, mode: 0o700 });
	return await withFileLock(resolvedModelsPath, async () => {
		signal?.throwIfAborted();
		const current = await readModelsConfigForWrite(resolvedModelsPath);
		const providers = isRecord(current.providers) ? current.providers : {};
		const storedProviderName = Object.keys(providers).find(name => name.toLowerCase() === providerName.toLowerCase());
		const savedProviderName = storedProviderName ?? providerName;
		const existing = isRecord(providers[savedProviderName]) ? providers[savedProviderName] : {};
		const {
			auth: _auth,
			transport: _transport,
			apiKey: _apiKey,
			[OPENAI_COMPATIBLE_LITERAL_API_KEY_FIELD]: _openAICompatibleApiKey,
			...preservedProviderFields
		} = existing;
		const candidate: Record<string, unknown> = {
			...current,
			providers: {
				...providers,
				[savedProviderName]: {
					...preservedProviderFields,
					baseUrl,
					[OPENAI_COMPATIBLE_LITERAL_API_KEY_FIELD]: apiKey,
					api,
					authHeader: true,
					discovery: { type: "openai-models-list" },
				},
			},
		};
		const validated = ModelsConfigFile.schema(candidate);
		if (validated instanceof Error) {
			throw new Error(
				`Cannot update ${resolvedModelsPath}: the resulting models.yml is invalid: ${validated.message}`,
			);
		}
		try {
			validateModelsConfig(validated as ModelsConfig);
		} catch (error) {
			throw new Error(
				`Cannot update ${resolvedModelsPath}: the resulting models.yml is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		await writeModelsConfigAtomically(
			resolvedModelsPath,
			validated as ModelsConfig,
			savedProviderName,
			apiKey,
			signal,
		);
		return savedProviderName;
	});
}
