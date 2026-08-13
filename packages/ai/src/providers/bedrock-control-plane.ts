/**
 * Amazon Bedrock control-plane fetch (SigV4 or bearer).
 *
 * Used for model discovery (`ListInferenceProfiles`, `ListFoundationModels`)
 * against `bedrock.{region}.amazonaws.com`. Runtime inference continues to
 * use `bedrock-runtime.{region}.amazonaws.com` via the Converse Stream
 * provider.
 *
 * Multi-region discovery signs each request for the region embedded in the
 * request hostname so GovCloud (east+west) and commercial multi-region sweeps
 * work with a single fetch implementation.
 */

import { type AwsBedrockProviderOptions, resolveAwsBearerToken } from "../registry/aws";
import type { FetchImpl } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";

export interface BedrockControlPlaneFetchOptions {
	/** Fallback region when the request host does not embed one. */
	region?: string;
	profile?: string;
	bearerToken?: string;
	/** Registry API key / bearer; AUTHENTICATED_SENTINEL is ignored. */
	apiKey?: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
	if (init?.body !== undefined && init.body !== null) {
		if (typeof init.body === "string") return new TextEncoder().encode(init.body);
		if (init.body instanceof Uint8Array) return init.body;
		if (init.body instanceof ArrayBuffer) return new Uint8Array(init.body);
		throw new TypeError(`Cannot SigV4-sign ${init.body.constructor?.name ?? typeof init.body} request body`);
	}
	if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
	return new Uint8Array();
}

/**
 * Extract the AWS region from a Bedrock control-plane or runtime hostname.
 * Exported for tests and multi-region discovery.
 */
export function regionFromBedrockHost(host: string): string | undefined {
	const match = /^bedrock(?:-runtime)?(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i.exec(host);
	return match?.[1];
}

function createSignedControlPlaneFetch(
	baseFetch: FetchImpl,
	fallbackRegion: string,
	profile: string | undefined,
	signal: AbortSignal | undefined,
): FetchImpl {
	const signedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.delete("authorization");
		const body = await requestBody(input, init);
		const region = regionFromBedrockHost(url.hostname) ?? fallbackRegion;
		const credentials = await resolveAwsCredentials({
			profile,
			region,
			signal: init?.signal ?? signal,
			fetch: baseFetch,
		});
		const contentType = headers.get("content-type") ?? (body.byteLength > 0 ? "application/json" : undefined);
		const signed = await signRequest({
			method,
			host: url.host,
			path: url.pathname,
			query: url.search.slice(1),
			body,
			region,
			service: "bedrock",
			credentials,
			headers: contentType ? { "content-type": contentType } : undefined,
		});
		for (const [name, value] of Object.entries(signed)) {
			if (value !== undefined && name !== "host") headers.set(name, value);
		}
		const response = await baseFetch(
			url,
			method === "GET" || method === "HEAD" ? { ...init, method, headers } : { ...init, method, headers, body },
		);
		if (response.status === 401 || response.status === 403) {
			invalidateAwsCredentialCache({ profile, region });
		}
		return response;
	};
	return Object.assign(signedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

/**
 * Build a fetch implementation that authenticates Bedrock control-plane
 * requests with a bearer API key (when present) or SigV4 IAM credentials.
 */
export function createBedrockControlPlaneFetch(options: BedrockControlPlaneFetchOptions = {}): FetchImpl {
	const region = resolveAwsRegion(options.region, options.profile);
	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const bearerToken = resolveAwsBearerToken(options.apiKey, options.bearerToken);
	if (bearerToken) {
		const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
			headers.set("authorization", `Bearer ${bearerToken}`);
			return baseFetch(input, { ...init, headers });
		};
		return Object.assign(authenticatedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
	}
	return createSignedControlPlaneFetch(baseFetch, region, options.profile, options.signal);
}

/** Control-plane host for a region (`bedrock.{region}.amazonaws.com`). */
export function bedrockControlPlaneBaseUrl(region: string): string {
	return `https://bedrock.${region}.amazonaws.com`;
}

/** Runtime host for Converse Stream (`bedrock-runtime.{region}.amazonaws.com`). */
export function bedrockRuntimeBaseUrl(region: string): string {
	return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Derive the Converse Stream base URL from a control-plane discovery base URL.
 */
export function bedrockRuntimeBaseUrlFromControlPlane(controlPlaneBaseUrl: string): string {
	try {
		const url = new URL(controlPlaneBaseUrl);
		url.hostname = url.hostname.replace(/^bedrock(\.|-fips\.)/, "bedrock-runtime$1");
		return url.origin;
	} catch {
		return controlPlaneBaseUrl.replace("://bedrock.", "://bedrock-runtime.");
	}
}

/**
 * Regions to sweep for discovery given the ambient AWS region.
 *
 * Bedrock model availability is regional: GovCloud Llama/Nova are only listed
 * in us-gov-west-1 while many Claude geo profiles appear in both gov regions.
 * We always include the ambient region first so duplicate ids prefer its
 * runtime endpoint.
 */
export function bedrockDiscoveryRegions(ambientRegion: string): string[] {
	if (ambientRegion.startsWith("us-gov-")) {
		return uniqueRegions([ambientRegion, "us-gov-east-1", "us-gov-west-1"]);
	}
	if (ambientRegion.startsWith("cn-")) {
		return uniqueRegions([ambientRegion, "cn-north-1", "cn-northwest-1"]);
	}
	// Commercial: ambient + common Bedrock regions. Parallel + 2h model cache
	// keeps startup cost acceptable; per-region failures are skipped.
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

export type { AwsBedrockProviderOptions };
