/**
 * Runtime model discovery for Amazon Bedrock Converse Stream.
 *
 * When AWS credentials (or a Bedrock API key) are available, lists inference
 * profiles and on-demand text foundation models from the control plane across
 * the ambient partition's Bedrock regions and maps them onto
 * `bedrock-converse-stream` specs. Successful discovery is authoritative so
 * each account/region set surfaces what the control plane actually exposes
 * (GovCloud east+west, commercial multi-region) instead of a static catalog.
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

/**
 * Regions to sweep for discovery given the ambient AWS region.
 * Kept in catalog so discovery unit tests do not need pi-ai.
 * Must stay aligned with `bedrockDiscoveryRegions` in pi-ai control-plane.
 */
export function bedrockDiscoveryRegions(ambientRegion: string): string[] {
	if (ambientRegion.startsWith("us-gov-")) {
		return uniqueRegions([ambientRegion, "us-gov-east-1", "us-gov-west-1"]);
	}
	if (ambientRegion.startsWith("cn-")) {
		return uniqueRegions([ambientRegion, "cn-north-1", "cn-northwest-1"]);
	}
	return uniqueRegions([
		ambientRegion,
		"us-east-1",
		"us-east-2",
		"us-west-1",
		"us-west-2",
		"ca-central-1",
		"eu-central-1",
		"eu-west-1",
		"eu-west-2",
		"eu-west-3",
		"eu-north-1",
		"eu-south-1",
		"ap-northeast-1",
		"ap-northeast-2",
		"ap-northeast-3",
		"ap-south-1",
		"ap-southeast-1",
		"ap-southeast-2",
		"sa-east-1",
	]);
}

function uniqueRegions(regions: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const region of regions) {
		const trimmed = region.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

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
							ambientControlPlaneBaseUrl: config.baseUrl as string,
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

/** Control-plane base URL for a concrete region. */
export function bedrockControlPlaneBaseUrl(region: string): string {
	return `https://bedrock.${region}.amazonaws.com`;
}

/** Runtime base URL for a concrete region. */
export function bedrockRuntimeBaseUrl(region: string): string {
	return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Parse ambient region from a control-plane base URL prepared by
 * `prepareModelDiscovery`. Exported for tests.
 */
export function regionFromControlPlaneBaseUrl(controlPlaneBaseUrl: string): string {
	try {
		const host = new URL(controlPlaneBaseUrl).hostname;
		const match = /^bedrock(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i.exec(host);
		if (match?.[1]) return match[1];
	} catch {
		// fall through
	}
	return "us-east-1";
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
	/** Ambient control-plane base URL from prepareModelDiscovery (sets preferred region). */
	ambientControlPlaneBaseUrl: string;
	fetch: FetchImpl;
}

/**
 * List inference profiles + on-demand text foundation models across the
 * ambient partition's Bedrock regions and map them to Converse Stream specs.
 * Returns `null` only when every region fails so the model manager keeps the
 * bundled catalog rather than caching an empty authoritative set.
 */
export async function fetchAmazonBedrockDiscoveredModels(
	options: DiscoveryFetchOptions,
): Promise<ModelSpec<"bedrock-converse-stream">[] | null> {
	const ambientRegion = regionFromControlPlaneBaseUrl(options.ambientControlPlaneBaseUrl);
	const regions = bedrockDiscoveryRegions(ambientRegion);
	const referenceIndex = buildBedrockReferenceIndex();
	const collected = new Map<string, ModelSpec<"bedrock-converse-stream">>();
	let anyRegionSucceeded = false;

	const regionResults = await Promise.all(
		regions.map(region => discoverRegion(region, options.fetch, referenceIndex)),
	);

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i];
		const result = regionResults[i];
		if (!result) continue;
		anyRegionSucceeded = true;
		const preferAmbient = region === ambientRegion;
		for (const model of result) {
			const existing = collected.get(model.id);
			if (!existing) {
				collected.set(model.id, model);
				continue;
			}
			// Prefer ambient-region endpoint when the same id is listed in multiple regions.
			if (preferAmbient) collected.set(model.id, model);
		}
	}

	if (!anyRegionSucceeded) return null;
	return Array.from(collected.values());
}

async function discoverRegion(
	region: string,
	fetchImpl: FetchImpl,
	referenceIndex: Map<string, ModelSpec<"bedrock-converse-stream">>,
): Promise<ModelSpec<"bedrock-converse-stream">[] | null> {
	const controlPlaneBaseUrl = bedrockControlPlaneBaseUrl(region);
	const runtimeBaseUrl = bedrockRuntimeBaseUrl(region);
	const profiles = await listAllInferenceProfiles({ controlPlaneBaseUrl, fetch: fetchImpl });
	// A region with no ListInferenceProfiles access is skipped, not fatal.
	if (profiles === null) return null;

	const out: ModelSpec<"bedrock-converse-stream">[] = [];
	const seen = new Set<string>();

	for (const summary of profiles) {
		const id = resolveBedrockDiscoveredModelId(summary);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name =
			typeof summary.inferenceProfileName === "string" && summary.inferenceProfileName.trim()
				? summary.inferenceProfileName.trim()
				: id;
		out.push(toDiscoveredBedrockModel(id, name, runtimeBaseUrl, referenceIndex));
	}

	const foundations = await listAllFoundationModels({ controlPlaneBaseUrl, fetch: fetchImpl });
	// Foundation list is best-effort per region.
	if (foundations) {
		for (const summary of foundations) {
			const id = typeof summary.modelId === "string" ? summary.modelId.trim() : "";
			if (!id || seen.has(id)) continue;
			// Bare foundation ids that only support INFERENCE_PROFILE cannot be
			// invoked on-demand (common on GovCloud). Prefer the geo profile id.
			if (!isOnDemandConverseFoundationModel(summary)) continue;
			seen.add(id);
			const name = typeof summary.modelName === "string" && summary.modelName.trim() ? summary.modelName.trim() : id;
			out.push(toDiscoveredBedrockModel(id, name, runtimeBaseUrl, referenceIndex));
		}
	}

	return out;
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

/**
 * Bare foundation-model ids are only useful when on-demand Converse works.
 * Profile-only models must be selected via their inference-profile id.
 * Exported for tests.
 */
export function isOnDemandConverseFoundationModel(summary: Record<string, unknown>): boolean {
	const streaming = summary.responseStreamingSupported;
	if (streaming === false) return false;
	const outputs = summary.outputModalities;
	if (Array.isArray(outputs) && outputs.length > 0 && !outputs.some(m => String(m).toUpperCase() === "TEXT")) {
		return false;
	}
	const inferenceTypes = summary.inferenceTypesSupported;
	if (Array.isArray(inferenceTypes) && inferenceTypes.length > 0) {
		return inferenceTypes.some(t => String(t).toUpperCase() === "ON_DEMAND");
	}
	// Missing inferenceTypes: keep (legacy rows); invoke may still fail.
	return true;
}

async function listAllInferenceProfiles(options: {
	controlPlaneBaseUrl: string;
	fetch: FetchImpl;
}): Promise<Array<Record<string, unknown>> | null> {
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

async function listAllFoundationModels(options: {
	controlPlaneBaseUrl: string;
	fetch: FetchImpl;
}): Promise<Array<Record<string, unknown>> | null> {
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
