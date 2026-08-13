/**
 * Runtime model discovery for Amazon Bedrock Converse Stream.
 *
 * When AWS credentials (or a Bedrock API key) are available, lists inference
 * profiles and on-demand text foundation models from the control plane across
 * the ambient partition's Bedrock regions and maps them onto
 * `bedrock-converse-stream` specs. Successful non-empty discovery is
 * authoritative; failures return `null` so the static catalog is retained.
 *
 * Unknown / unsupported models fail closed: only rows that pass the shared
 * Bedrock eligibility policy and resolve to a bundled reference are emitted,
 * so discovery never invents limits or promotes catalog-rejected SKUs.
 */

import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels } from "../models";
import type { FetchImpl, Model, ModelSpec } from "../types";
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
		// Authoritative only when fetchDynamicModels returns a non-null list.
		// fetchAmazonBedrockDiscoveredModels returns null on incomplete/failed
		// discovery so the static catalog is never wiped.
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
 * Shared Bedrock catalog denylist — mirrors models.dev filterModel for amazon-bedrock.
 * Exported for tests.
 */
export function isBedrockCatalogEligibleModelId(modelId: string): boolean {
	const bare = stripBedrockGeoPrefix(extractProfileLeafId(modelId));
	if (bare.startsWith("ai21.jamba")) return false;
	if (bare.startsWith("amazon.titan-text-express") || bare.startsWith("mistral.mistral-7b-instruct-v0")) return false;
	// Embeddings and non-chat SKUs are never Converse coding models.
	if (bare.includes("embed") || bare.includes("titan-embed")) return false;
	return true;
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

/**
 * Resolve underlying foundation model id(s) from an inference-profile summary.
 * Application profiles require `models[].modelArn` for metadata inheritance.
 * Exported for tests.
 */
export function foundationIdsFromInferenceProfileSummary(summary: Record<string, unknown>): string[] {
	const out: string[] = [];
	const models = summary.models;
	if (Array.isArray(models)) {
		for (const entry of models) {
			if (!isRecord(entry)) continue;
			const arn = typeof entry.modelArn === "string" ? entry.modelArn.trim() : "";
			if (!arn) continue;
			const id = foundationIdFromModelArn(arn);
			if (id) out.push(id);
		}
	}
	// System geo profiles encode the foundation id after the geo prefix.
	const profileId = typeof summary.inferenceProfileId === "string" ? summary.inferenceProfileId.trim() : "";
	if (profileId && !profileId.startsWith("arn:")) {
		const bare = stripBedrockGeoPrefix(profileId);
		if (bare && bare !== profileId) out.push(bare);
	}
	return out;
}

/** Parse `…foundation-model/<id>` (or trailing leaf) from a model ARN. Exported for tests. */
export function foundationIdFromModelArn(modelArn: string): string | undefined {
	const marker = "foundation-model/";
	const idx = modelArn.indexOf(marker);
	if (idx !== -1) {
		const id = modelArn.slice(idx + marker.length).trim();
		return id || undefined;
	}
	const slash = modelArn.lastIndexOf("/");
	if (slash === -1) return undefined;
	const leaf = modelArn.slice(slash + 1).trim();
	return leaf || undefined;
}

interface DiscoveryFetchOptions {
	/** Ambient control-plane base URL from prepareModelDiscovery (sets preferred region). */
	ambientControlPlaneBaseUrl: string;
	fetch: FetchImpl;
}

interface RegionDiscoveryOutcome {
	/** null = region control-plane list failed entirely. */
	models: ModelSpec<"bedrock-converse-stream">[] | null;
	/** false when ListFoundationModels failed for this region after profiles succeeded. */
	foundationsOk: boolean;
	/** true when ListInferenceProfiles returned a non-null result (even if empty). */
	profilesOk: boolean;
	profileCount: number;
}

/**
 * List inference profiles + on-demand text foundation models across the
 * ambient partition's Bedrock regions and map them to Converse Stream specs.
 *
 * Returns `null` when discovery cannot establish a usable complete set:
 * - every region fails, or
 * - no eligible models after policy filtering, or
 * - profiles empty everywhere and foundation listing failed (would otherwise
 *   authoritatively wipe the static catalog).
 */
export async function fetchAmazonBedrockDiscoveredModels(
	options: DiscoveryFetchOptions,
): Promise<ModelSpec<"bedrock-converse-stream">[] | null> {
	const ambientRegion = regionFromControlPlaneBaseUrl(options.ambientControlPlaneBaseUrl);
	const regions = bedrockDiscoveryRegions(ambientRegion);
	const referenceIndex = buildBedrockReferenceIndex();
	const collected = new Map<string, ModelSpec<"bedrock-converse-stream">>();

	const regionResults = await Promise.all(
		regions.map(region => discoverRegion(region, options.fetch, referenceIndex)),
	);

	let anyRegionSucceeded = false;
	let totalProfiles = 0;
	let anyFoundationsOk = false;
	let anyProfilesOk = false;

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i];
		const outcome = regionResults[i];
		if (!outcome.models) continue;
		anyRegionSucceeded = true;
		if (outcome.profilesOk) {
			anyProfilesOk = true;
			totalProfiles += outcome.profileCount;
		}
		if (outcome.foundationsOk) anyFoundationsOk = true;
		const preferAmbient = region === ambientRegion;
		for (const model of outcome.models) {
			const existing = collected.get(model.id);
			if (!existing) {
				collected.set(model.id, model);
				continue;
			}
			if (preferAmbient) collected.set(model.id, model);
		}
	}

	if (!anyRegionSucceeded) return null;
	// Profiles empty + foundations failed ⇒ incomplete set; do not authoritatively wipe.
	if (totalProfiles === 0 && !anyFoundationsOk) return null;
	// Profiles listed empty and foundations ok but yielded nothing after policy.
	if (collected.size === 0) {
		// Empty but complete (account truly has no eligible models) is still
		// dangerous to treat as authoritative during partial API outages.
		// Only accept empty when profiles succeeded with zero rows and foundations succeeded.
		if (anyProfilesOk && anyFoundationsOk && totalProfiles === 0) return null;
		return null;
	}
	return Array.from(collected.values());
}

async function discoverRegion(
	region: string,
	fetchImpl: FetchImpl,
	referenceIndex: Map<string, ModelSpec<"bedrock-converse-stream">>,
): Promise<RegionDiscoveryOutcome> {
	const controlPlaneBaseUrl = bedrockControlPlaneBaseUrl(region);
	const runtimeBaseUrl = bedrockRuntimeBaseUrl(region);
	const profiles = await listAllInferenceProfiles({ controlPlaneBaseUrl, fetch: fetchImpl });
	if (profiles === null) {
		return { models: null, foundationsOk: false, profilesOk: false, profileCount: 0 };
	}

	const out: ModelSpec<"bedrock-converse-stream">[] = [];
	const seen = new Set<string>();

	for (const summary of profiles) {
		const id = resolveBedrockDiscoveredModelId(summary);
		if (!id || seen.has(id)) continue;
		if (!isBedrockCatalogEligibleModelId(id)) continue;
		const referenceIds = foundationIdsFromInferenceProfileSummary(summary);
		const reference = findBedrockReferenceFromCandidates([id, ...referenceIds], referenceIndex);
		// Fail closed: no fabricated limits for unknown models.
		if (!reference) continue;
		seen.add(id);
		const name =
			typeof summary.inferenceProfileName === "string" && summary.inferenceProfileName.trim()
				? summary.inferenceProfileName.trim()
				: id;
		out.push(toDiscoveredBedrockModel(id, name, runtimeBaseUrl, reference));
	}

	const foundations = await listAllFoundationModels({ controlPlaneBaseUrl, fetch: fetchImpl });
	const foundationsOk = foundations !== null;
	if (foundations) {
		for (const summary of foundations) {
			const id = typeof summary.modelId === "string" ? summary.modelId.trim() : "";
			if (!id || seen.has(id)) continue;
			if (!isBedrockCatalogEligibleModelId(id)) continue;
			if (!isOnDemandConverseFoundationModel(summary)) continue;
			const reference = findBedrockReferenceFromCandidates([id], referenceIndex);
			if (!reference) continue;
			seen.add(id);
			const name = typeof summary.modelName === "string" && summary.modelName.trim() ? summary.modelName.trim() : id;
			out.push(toDiscoveredBedrockModel(id, name, runtimeBaseUrl, reference));
		}
	}

	return {
		models: out,
		foundationsOk,
		profilesOk: true,
		profileCount: profiles.length,
	};
}

function toDiscoveredBedrockModel(
	id: string,
	name: string,
	runtimeBaseUrl: string,
	reference: ModelSpec<"bedrock-converse-stream">,
): ModelSpec<"bedrock-converse-stream"> {
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
		if (model.api !== "bedrock-converse-stream") continue;
		const spec = modelToBedrockSpec(model);
		if (!spec) continue;
		map.set(spec.id, spec);
		const bare = stripBedrockGeoPrefix(spec.id);
		if (!map.has(bare)) map.set(bare, spec);
		// Index us./eu. variants under bare foundation id for geo profile lookup.
		if (bare !== spec.id && !map.has(bare)) map.set(bare, spec);
	}
	return map;
}

function modelToBedrockSpec(model: Model): ModelSpec<"bedrock-converse-stream"> | undefined {
	if (model.api !== "bedrock-converse-stream") return undefined;
	// Copy only fields safe on ModelSpec<"bedrock-converse-stream">. `compat` is
	// re-derived by buildModel / catalog policies at load time; copying the union
	// Model.compat would require an unsafe cast.
	return {
		id: model.id,
		name: model.name,
		api: "bedrock-converse-stream",
		provider: model.provider,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.thinking ? { thinking: model.thinking } : {}),
	};
}

function findBedrockReferenceFromCandidates(
	candidates: string[],
	references: Map<string, ModelSpec<"bedrock-converse-stream">>,
): ModelSpec<"bedrock-converse-stream"> | undefined {
	for (const candidate of candidates) {
		const hit = findBedrockReference(candidate, references);
		if (hit) return hit;
	}
	return undefined;
}

function findBedrockReference(
	id: string,
	references: Map<string, ModelSpec<"bedrock-converse-stream">>,
): ModelSpec<"bedrock-converse-stream"> | undefined {
	const leaf = extractProfileLeafId(id);
	const bare = stripBedrockGeoPrefix(leaf);
	const direct = references.get(id) ?? references.get(leaf) ?? references.get(bare);
	if (direct) return direct;
	// us./eu./global. siblings of the bare foundation id.
	for (const prefix of BEDROCK_GEO_PREFIXES) {
		const hit = references.get(`${prefix}${bare}`);
		if (hit) return hit;
	}
	// GovCloud often lists llama3-8b while the commercial catalog has llama3-1-8b.
	const llama = /^meta\.llama3-(\d+b-instruct(?:-v\d+(?::\d+)?)?)$/i.exec(bare);
	if (llama) {
		const alt = `meta.llama3-1-${llama[1]}`;
		const hit = references.get(alt) ?? references.get(`us.${alt}`);
		if (hit) return hit;
	}
	return undefined;
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
	// Missing inferenceTypes: do not invent eligibility (fail closed).
	return false;
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
