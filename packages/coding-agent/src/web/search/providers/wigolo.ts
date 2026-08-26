/**
 * Wigolo Web Search Provider
 *
 * Calls a local Wigolo REST API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 *
 * Wigolo is a self-hosted search aggregator that exposes a simple JSON API.
 * No API key is required for local installations.
 *
 * Configuration via settings:
 *   wigolo.baseUrl   - Base URL of the Wigolo instance (default http://127.0.0.1:3333)
 *   wigolo.authToken - Optional bearer token (optional; local instances typically don't require one)
 *
 * Environment variable fallbacks:
 *   WIGOLO_BASE_URL  - Base URL of the Wigolo instance
 *   WIGOLO_AUTH_TOKEN - Optional bearer token
 *
 * Reference: POST {base}/v1/search
 */

import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";

import { settings } from "../../../config/settings";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_BASE_URL = "http://127.0.0.1:3333";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface WigoloResult {
 title?: string;
 url?: string;
 snippet?: string;
 publishedDate?: string;
 published_date?: string;
 relevanceScore?: number;
 relevance_score?: number;
 source?: string;
}

interface WigoloResponse {
 results?: WigoloResult[];
 enginesUsed?: string[];
 engines_used?: string[];
 totalTimeMs?: number;
 total_time_ms?: number;
}

interface WigoloRequest {
 query: string;
 max_results?: number;
 search_engines?: string[];
 category?: string;
 time_range?: "day" | "week" | "month" | "year";
 language?: string;
 country?: string;
 exclude_domains?: string[];
 include_domains?: string[];
 search_depth?: "fast" | "balanced" | "deep";
 force_refresh?: boolean;
}

function findBaseUrl(): string | null {
 try {
  const baseUrl = settings.get("wigolo.baseUrl");
  if (baseUrl) return baseUrl;
 } catch {
  // Settings not initialized yet
 }
 return process.env.WIGOLO_BASE_URL ?? DEFAULT_BASE_URL;
}

function findAuthToken(): string | null {
 try {
  const token = settings.get("wigolo.authToken");
  if (token) return token;
 } catch {
  // Settings not initialized yet
 }
 return process.env.WIGOLO_AUTH_TOKEN ?? null;
}

async function callWigoloSearch(
 baseUrl: string,
 params: {
  query: string;
  numResults?: number;
  recency?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: FetchImpl;
 },
 authToken: string | null,
): Promise<WigoloResponse> {
 const url = new URL(`${baseUrl.replace(/\/$/, "")}/v1/search`);

 const body: WigoloRequest = {
  query: params.query,
  max_results: params.numResults,
  search_depth: "fast",
 };
 if (params.recency) body.time_range = params.recency;

 const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
 };
 if (authToken) {
  headers.Authorization = `Bearer ${authToken}`;
 }

 const response = await (params.fetch ?? fetch)(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: withHardTimeout(params.signal, params.timeoutMs),
 });

 if (!response.ok) {
  const errorText = await response.text();
  const classified = classifyProviderHttpError("wigolo", response.status, errorText);
  if (classified) throw classified;
  throw new SearchProviderError("wigolo", `Wigolo API error (${response.status}): ${errorText}`, response.status);
 }

 return (await response.json()) as WigoloResponse;
}

/** Execute a Wigolo web search. */
export async function searchWigolo(params: SearchParams): Promise<SearchResponse> {
 const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
 const baseUrl = findBaseUrl();
 if (!baseUrl) {
  throw new Error("Wigolo base URL not configured. Set wigolo.baseUrl in settings or WIGOLO_BASE_URL in environment.");
 }

 const response = await callWigoloSearch(
  baseUrl,
  {
   query: params.query,
   numResults: numResults,
   recency: params.recency,
   signal: params.signal,
   timeoutMs: params.timeoutMs,
   fetch: params.fetch,
  },
  findAuthToken(),
 );

 const rawSources: SearchSource[] = [];
 for (const result of response.results ?? []) {
  if (!result.url) continue;
  const publishedDate = result.publishedDate ?? result.published_date;
  rawSources.push({
   title: result.title ?? result.url,
   url: result.url,
   snippet: result.snippet?.trim() || undefined,
   publishedDate: publishedDate ?? undefined,
   ageSeconds: dateToAgeSeconds(publishedDate),
   author: result.source ?? undefined,
  });
 }

 return {
  provider: "wigolo",
  sources: rawSources.slice(0, numResults),
 };
}

/** Search provider for Wigolo (self-hosted; no API key required). */
export class WigoloProvider extends SearchProvider {
 readonly id = "wigolo";
 readonly label = "Wigolo";

 isAvailable(_authStorage: AuthStorage): boolean {
  try {
   return !!findBaseUrl();
  } catch {
   return false;
  }
 }

 search(params: SearchParams): Promise<SearchResponse> {
  return searchWigolo(params);
}
}