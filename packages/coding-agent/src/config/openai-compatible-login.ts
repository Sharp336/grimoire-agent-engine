import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { withFileLock } from "./file-lock";
import { ModelsConfigFile } from "./models-config";
import type { ModelsConfig } from "./models-config-schema";
import { MODELS_CONFIG_API_IDS } from "./models-config-schema-bundle";

export const OPENAI_COMPATIBLE_LOGIN_ID = "openai-compatible";

export interface OpenAICompatibleEndpoint {
	providerName: string;
	baseUrl: string;
	apiKey: string;
}

export type OpenAICompatibleProbeResult = { ok: true; models: string[] } | { ok: false; error: string };

function formatResponseBody(body: string): string {
	const trimmed = body.trim();
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
	return url.toString().replace(/\/$/, "");
}

/** Rejects names that would replace a bundled provider rather than add a custom one. */
export function validateOpenAICompatibleProviderName(value: string): string {
	const providerName = value.trim();
	if (!providerName) throw new Error("Provider name is required.");
	if (PROVIDER_REGISTRY.some(provider => provider.id === providerName)) {
		throw new Error(`Provider name "${providerName}" is built in. Choose a different name.`);
	}
	return providerName;
}

/** Validates an API identifier through the same schema used for models.yml. */
export function validateOpenAICompatibleApi(value: string | undefined): string {
	const api = value?.trim() || "openai-completions";
	if (!MODELS_CONFIG_API_IDS.includes(api as (typeof MODELS_CONFIG_API_IDS)[number])) {
		throw new Error(`API "${api}" is not accepted by models.yml.`);
	}
	return api;
}

/** Probes the standard OpenAI `GET /models` endpoint and returns usable model ids. */
export async function probeOpenAICompatibleEndpoint(
	endpoint: Pick<OpenAICompatibleEndpoint, "baseUrl" | "apiKey">,
	fetchImpl: typeof fetch = fetch,
): Promise<OpenAICompatibleProbeResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${endpoint.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${endpoint.apiKey}` },
		});
	} catch (error) {
		return {
			ok: false,
			error: `Could not reach ${endpoint.baseUrl}/models: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const body = await response.text();
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
		content = await fs.promises.readFile(filePath, "utf-8");
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

async function writeModelsConfigAtomically(
	filePath: string,
	config: ModelsConfig,
	providerName: string,
	apiKey: string,
): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const apiKeyMarker = `__OMP_OPENAI_COMPAT_API_KEY_${randomUUID()}__`;
	const serialized = YAML.stringify(
		{
			...config,
			providers: {
				...config.providers,
				[providerName]: {
					...config.providers?.[providerName],
					apiKey: apiKeyMarker,
				},
			},
		},
		null,
		2,
	);
	const content = serialized.replace(apiKeyMarker, JSON.stringify(apiKey));
	try {
		await fs.promises.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await fs.promises.rename(tempPath, filePath);
	} catch (error) {
		await fs.promises.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Upserts a custom OpenAI-compatible provider with its API key in models.yml.
 * Runtime discovery keeps the provider's model catalog current.
 */
export async function writeOpenAICompatibleProvider(
	endpoint: OpenAICompatibleEndpoint & { api?: string },
	modelsPath: string = ModelsConfigFile.path(),
): Promise<void> {
	const providerName = validateOpenAICompatibleProviderName(endpoint.providerName);
	const baseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
	const apiKey = endpoint.apiKey.trim();
	if (!apiKey) throw new Error("API key is required.");
	const api = validateOpenAICompatibleApi(endpoint.api);
	await fs.promises.mkdir(path.dirname(modelsPath), { recursive: true, mode: 0o700 });
	await withFileLock(modelsPath, async () => {
		const current = await readModelsConfigForWrite(modelsPath);
		const providers = isRecord(current.providers) ? current.providers : {};
		const existing = isRecord(providers[providerName]) ? providers[providerName] : {};
		const { auth: _auth, models: _models, ...preservedProviderFields } = existing;
		const candidate: Record<string, unknown> = {
			...current,
			providers: {
				...providers,
				[providerName]: {
					...preservedProviderFields,
					baseUrl,
					apiKey,
					api,
					authHeader: true,
					discovery: { type: "openai-models-list" },
				},
			},
		};
		const validated = ModelsConfigFile.schema(candidate);
		if (validated instanceof Error) {
			throw new Error(`Cannot update ${modelsPath}: the resulting models.yml is invalid: ${validated.message}`);
		}
		await writeModelsConfigAtomically(modelsPath, validated as ModelsConfig, providerName, apiKey);
	});
}
