/**
 * Runtime model discovery for Amazon Bedrock Converse Stream.
 *
 * When AWS credentials (or a Bedrock API key) are available, lists inference
 * profiles and text foundation models from the control plane in the ambient
 * region and maps them onto `bedrock-converse-stream` specs. Successful
 * discovery is authoritative so GovCloud accounts see their real `us-gov.*`
 * system profiles instead of a commercial-only (or over-synthesized) static
 * catalog.
 */

import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels } from "../models";
import type { FetchImpl, ModelSpec } from "../types";
import { isRecord } from "../utils";
import type { ModelManagerConfig } from "./descriptor-types";

const DEFAULT_RUNTIME_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** Geo prefixes used by Bedrock system inference profiles (including GovCloud). */
const BEDROCK_GEO_PREFIXES = ["us-gov.", "global.", "us.", "eu.", "au.", "jp.", "apac."] as const;

export interface AmazonBedrockModelManagerConfig extends ModelManagerConfig {}

export function amazonBedrockModelManagerOptions(
	config: AmazonBedrockModelManagerConfig = {},
): ModelManagerOptions<"bedrock-converse-stream"> {
	return {
		providerId: "amazon-bedrock",
		// A successful control-plane list is the account/region-visible set;
		// keep the large commercial static catalog only when discovery does not run.
		dynamicModelsAuthoritative: true,
		...(config.authenticated && config.fetch && config.baseUrl
			? {
					fetchDynamicModels: () =>
						fetchAmazonBedrockDiscoveredModels({
							controlPlaneBaseUrl: config.baseUrl as string,
							runtimeBaseUrl: bedrockRuntimeBaseUrlFromControlPlane(config.baseUrl as string),
							fetch: config.fetch as FetchImpl,
						}),
				}
			: {}),
	};
}

/**
 * Derive Converse Stream base URL from a control-plane discovery base URL.
 * Exported for tests.
 */
export function bedrockRuntimeBaseUrlFromControlPlane(controlPlaneBaseUrl: string): string {
	try {
		const url = new URL(controlPlaneBaseUrl);
		url.hostname = url.hostname.replace(/^bedrock(\.|-fips\.)/, "bedrock-runtime$1");
		return url.origin;
	} catch {
		return controlPlaneBaseUrl
			.replace("://bedrock.", "://bedrock-runtime.")
			.replace("://bedrock-fips.", "://bedrock-runtime-fips.");
	}
}

/**
 * Strip a Bedrock geo/global inference-profile prefix to recover the foundation model id.
 * Exported for tests.
 */
export function stripBedrockGeoPrefix(modelId: string): string {
	for (const prefix of BEDROCK_GEO_PREFIXES) {
		if (modelId.startsWith(prefix)) return modelId.slice(prefix.length);
	}
	return modelId;
}

/**
 * Extract a selectable model id from an inference-profile summary.
 * Application profiles use the full ARN (already accepted by the model resolver);
 * system profiles use the short inference profile id (`us-gov.anthropic.…`).
 * Exported for tests.
 */
export function resolveBedrockDiscoveredModelId(summary: {
	inferenceProfileId?: string;
	inferenceProfileArn?: string;
	type?: string;
}): string | undefined {
	const type = (summary.type ?? "").toUpperCase();
	const profileId = typeof summary.inferenceProfileId === "string" ? summary.inferenceProfileId.trim() : "";
	const arn = typeof summary.inferenceProfileArn === "string" ? summary.inferenceProfileArn.trim() : "";
	if (type === "APPLICATION" && arn) return arn;
	if (profileId) return profileId;
	if (arn) {
		const slash = arn.lastIndexOf("/");
		return slash === -1 ? arn : arn.slice(slash + 1);
	}
	return undefined;
}

interface DiscoveryFetchOptions {
	controlPlaneBaseUrl: string;
	runtimeBaseUrl: string;
	fetch: FetchImpl;
}

/**
 * List inference profiles + on-demand text foundation models and map them to
 * Converse Stream specs. Returns `null` on transport/API failure so the model
 * manager keeps the bundled catalog rather than caching an empty authoritative set.
 */
export async function fetchAmazonBedrockDiscoveredModels(
	options: DiscoveryFetchOptions,
): Promise<ModelSpec<"bedrock-converse-stream">[] | null> {
	const referenceIndex = buildBedrockReferenceIndex();
	const collected = new Map<string, ModelSpec<"bedrock-converse-stream">>();

	const profiles = await listAllInferenceProfiles(options);
	if (profiles === null) return null;
	for (const summary of profiles) {
		const id = resolveBedrockDiscoveredModelId(summary);
		if (!id || collected.has(id)) continue;
		const name =
			typeof summary.inferenceProfileName === "string" && summary.inferenceProfileName.trim()
				? summary.inferenceProfileName.trim()
				: id;
		collected.set(id, toDiscoveredBedrockModel(id, name, options.runtimeBaseUrl, referenceIndex));
	}

	const foundations = await listAllFoundationModels(options);
	// Foundation list is best-effort: profiles alone are enough for a successful discovery.
	if (foundations) {
		for (const summary of foundations) {
			const id = typeof summary.modelId === "string" ? summary.modelId.trim() : "";
			if (!id || collected.has(id)) continue;
			if (!isConverseCapableFoundationModel(summary)) continue;
			const name = typeof summary.modelName === "string" && summary.modelName.trim() ? summary.modelName.trim() : id;
			collected.set(id, toDiscoveredBedrockModel(id, name, options.runtimeBaseUrl, referenceIndex));
		}
	}

	return Array.from(collected.values());
}

function toDiscoveredBedrockModel(
	id: string,
	name: string,
	runtimeBaseUrl: string,
	references: Map<string, ModelSpec<"bedrock-converse-stream">>,
): ModelSpec<"bedrock-converse-stream"> {
	const reference = findBedrockReference(id, references);
	const defaults: ModelSpec<"bedrock-converse-stream"> = {
		id,
		name,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: runtimeBaseUrl || DEFAULT_RUNTIME_BASE_URL,
		reasoning: reference?.reasoning ?? false,
		input: reference?.input ?? ["text"],
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: reference?.contextWindow ?? 200_000,
		maxTokens: reference?.maxTokens ?? 64_000,
		...(reference?.thinking ? { thinking: reference.thinking } : {}),
		...(reference?.compat ? { compat: reference.compat } : {}),
	};
	if (!reference) return defaults;
	return {
		...reference,
		id,
		name: name || reference.name,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: runtimeBaseUrl || reference.baseUrl || DEFAULT_RUNTIME_BASE_URL,
	};
}

function buildBedrockReferenceIndex(): Map<string, ModelSpec<"bedrock-converse-stream">> {
	const map = new Map<string, ModelSpec<"bedrock-converse-stream">>();
	for (const model of getBundledModels("amazon-bedrock")) {
		const spec = model as unknown as ModelSpec<"bedrock-converse-stream">;
		map.set(spec.id, spec);
		const bare = stripBedrockGeoPrefix(spec.id);
		if (!map.has(bare)) map.set(bare, spec);
	}
	return map;
}

function findBedrockReference(
	id: string,
	references: Map<string, ModelSpec<"bedrock-converse-stream">>,
): ModelSpec<"bedrock-converse-stream"> | undefined {
	const direct = references.get(id);
	if (direct) return direct;
	const bare = stripBedrockGeoPrefix(extractProfileLeafId(id));
	return references.get(bare) ?? references.get(extractProfileLeafId(id));
}

function extractProfileLeafId(id: string): string {
	if (!id.startsWith("arn:")) return id;
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

function isConverseCapableFoundationModel(summary: Record<string, unknown>): boolean {
	const streaming = summary.responseStreamingSupported;
	if (streaming === false) return false;
	const outputs = summary.outputModalities;
	if (Array.isArray(outputs) && outputs.length > 0 && !outputs.some(m => String(m).toUpperCase() === "TEXT")) {
		return false;
	}
	const inferenceTypes = summary.inferenceTypesSupported;
	if (Array.isArray(inferenceTypes) && inferenceTypes.length > 0) {
		const allowed = inferenceTypes.some(t => {
			const upper = String(t).toUpperCase();
			return upper === "ON_DEMAND" || upper === "INFERENCE_PROFILE";
		});
		if (!allowed) return false;
	}
	return true;
}

async function listAllInferenceProfiles(
	options: DiscoveryFetchOptions,
): Promise<Array<Record<string, unknown>> | null> {
	const out: Array<Record<string, unknown>> = [];
	let nextToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(
			"/inference-profiles",
			options.controlPlaneBaseUrl.endsWith("/") ? options.controlPlaneBaseUrl : `${options.controlPlaneBaseUrl}/`,
		);
		url.searchParams.set("maxResults", String(PAGE_SIZE));
		if (nextToken) url.searchParams.set("nextToken", nextToken);
		const payload = await getJson(options.fetch, url);
		if (payload === null) return null;
		const rows = payload.inferenceProfileSummaries;
		if (Array.isArray(rows)) {
			for (const row of rows) {
				if (isRecord(row)) out.push(row);
			}
		}
		const token = typeof payload.nextToken === "string" ? payload.nextToken : "";
		if (!token) break;
		nextToken = token;
	}
	return out;
}

async function listAllFoundationModels(options: DiscoveryFetchOptions): Promise<Array<Record<string, unknown>> | null> {
	const url = new URL(
		"/foundation-models",
		options.controlPlaneBaseUrl.endsWith("/") ? options.controlPlaneBaseUrl : `${options.controlPlaneBaseUrl}/`,
	);
	const payload = await getJson(options.fetch, url);
	if (payload === null) return null;
	const rows = payload.modelSummaries;
	if (!Array.isArray(rows)) return [];
	const out: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		if (isRecord(row)) out.push(row);
	}
	return out;
}

async function getJson(fetchImpl: FetchImpl, url: URL): Promise<Record<string, unknown> | null> {
	let response: Response;
	try {
		response = await fetchImpl(url.toString(), {
			method: "GET",
			headers: { accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	try {
		const payload: unknown = await response.json();
		return isRecord(payload) ? payload : null;
	} catch {
		return null;
	}
}
