import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { readSseJson } from "@oh-my-pi/pi-utils";
import type { SearchCitation, SearchProviderId, SearchSource, SearchUsage } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

export interface HostedResponsesRequestOptions {
	model: string;
	query: string;
	instructions: string;
	searchContextSize?: "low" | "medium" | "high";
}

export interface HostedResponsesCallOptions extends HostedResponsesRequestOptions {
	provider: SearchProviderId;
	displayName: string;
	url: string;
	headers: Headers;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

export interface HostedResponsesResult {
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	model: string;
	requestId: string;
	usage?: SearchUsage;
}

interface HostedWebSearchSource {
	url?: string;
	source_website_url?: string;
	title?: string;
	caption?: string;
}

interface HostedCitationAnnotation {
	type?: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface HostedContentPart {
	type?: string;
	text?: string;
	annotations?: HostedCitationAnnotation[];
}

interface HostedResponseItem {
	type?: string;
	content?: HostedContentPart[];
	annotations?: HostedCitationAnnotation[];
	action?: { sources?: HostedWebSearchSource[] };
	sources?: HostedWebSearchSource[];
	results?: HostedWebSearchSource[];
	summary?: Array<{ type?: string; text?: string }>;
}

interface HostedUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface HostedResponse {
	id?: string;
	model?: string;
	usage?: HostedUsage;
}

/** Resolve a standard OpenAI Responses endpoint from a complete provider URL. */
export function resolveHostedResponsesUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("OpenAI Responses base URL is empty");
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

/** Build the common streamed Hosted Responses web-search request body. */
export function buildHostedResponsesRequestBody(options: HostedResponsesRequestOptions): Record<string, unknown> {
	return {
		model: options.model,
		stream: true,
		store: false,
		include: ["web_search_call.action.sources"],
		parallel_tool_calls: true,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: options.query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.instructions,
	};
}

const IMAGE_PLACEHOLDER_ANSWERS: Record<string, true> = {
	"see attached image": true,
	"attached image": true,
	"see the attached image": true,
	"see image": true,
	"see image above": true,
	"image above": true,
	"see image below": true,
	"image below": true,
};

function isImagePlaceholderAnswer(text: string): boolean {
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS[normalized] === true;
}

/** Raised when a Responses model answers without actually invoking web_search. */
export class HostedResponsesNoWebSearchError extends SearchProviderError {
	constructor(provider: SearchProviderId, displayName: string) {
		super(
			provider,
			`${displayName} returned a completion without running web search (no web_search_call event); refusing to treat a non-search answer as a search result`,
			502,
		);
		this.name = "HostedResponsesNoWebSearchError";
	}
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/u, "");
	}
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	const normalizedSource = { ...source, url: cleanSourceUrl(source.url) };
	const existing = sources.find(candidate => candidate.url === normalizedSource.url);
	if (!existing) {
		sources.push(normalizedSource);
		return;
	}
	if (existing.title === existing.url && normalizedSource.title !== normalizedSource.url) {
		existing.title = normalizedSource.title;
	}
	if (!existing.snippet && normalizedSource.snippet) existing.snippet = normalizedSource.snippet;
}

function addCitation(citations: SearchCitation[], citation: SearchCitation): void {
	const normalized = { ...citation, url: cleanSourceUrl(citation.url) };
	const existing = citations.find(candidate => candidate.url === normalized.url);
	if (!existing) {
		citations.push(normalized);
		return;
	}
	if (existing.title === existing.url && normalized.title !== normalized.url) existing.title = normalized.title;
	if (!existing.citedText && normalized.citedText) existing.citedText = normalized.citedText;
}

function extractCitationSnippet(text: string, start: number | undefined, end: number | undefined): string | undefined {
	if (start === undefined || end === undefined || !text) return undefined;
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	if (!snippet) return undefined;
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const character of text) if (character === target) count += 1;
	return count;
}

function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();
	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}
	if (!/^https?:\/\//.test(url)) return null;
	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;
	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") return null;
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
		if (depth < 0) return null;
	}
	return null;
}

function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") continue;
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") continue;
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) continue;
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) addSource(sources, { title: title || url, url });
		index = urlEnd;
	}
	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (url) addSource(sources, { title: url, url });
	}
	return sources;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asResponse(value: unknown): HostedResponse | undefined {
	return asRecord(value) as HostedResponse | undefined;
}

function asResponseItem(value: unknown): HostedResponseItem | undefined {
	return asRecord(value) as HostedResponseItem | undefined;
}

function extractSseError(rawEvent: Record<string, unknown>): { code: string; message: string } {
	const response = asRecord(rawEvent.response);
	const candidates: unknown[] = [rawEvent, rawEvent.error, response?.error];
	let code = "";
	let message = "";
	for (const candidate of candidates) {
		const record = asRecord(candidate);
		if (!record) continue;
		if (!code && typeof record.code === "string" && record.code) code = record.code;
		if (!message && typeof record.message === "string" && record.message) message = record.message;
	}
	return { code, message };
}

function classifySseErrorStatus(code: string, message: string): number {
	const detail = `${code} ${message}`.toLowerCase();
	if (/rate[- ]?limit|too many requests|quota|\b429\b/u.test(detail)) return 429;
	if (/unauthori[sz]ed|\b401\b/u.test(detail)) return 401;
	if (/forbidden|\b403\b/u.test(detail)) return 403;
	if (/timeout|timed out/u.test(detail)) return 504;
	return 500;
}

function collectAnnotation(
	annotation: HostedCitationAnnotation,
	text: string,
	sources: SearchSource[],
	citations: SearchCitation[],
): void {
	if (annotation.type !== "url_citation" || !annotation.url) return;
	const title = annotation.title ?? annotation.url;
	const snippet = extractCitationSnippet(text, annotation.start_index, annotation.end_index);
	addSource(sources, { title, url: annotation.url, ...(snippet ? { snippet } : {}) });
	addCitation(citations, { title, url: annotation.url, ...(snippet ? { citedText: snippet } : {}) });
}

function collectWebSearchSources(item: HostedResponseItem, sources: SearchSource[]): void {
	if (item.type !== "web_search_call") return;
	for (const group of [item.action?.sources, item.sources, item.results]) {
		if (!Array.isArray(group)) continue;
		for (const source of group) {
			if (!source || typeof source !== "object") continue;
			const url = source.url ?? source.source_website_url;
			if (!url) continue;
			addSource(sources, { title: source.title ?? source.caption ?? url, url });
		}
	}
}

function collectMessage(
	item: HostedResponseItem,
	answerParts: string[],
	sources: SearchSource[],
	citations: SearchCitation[],
): void {
	if (item.type === "message" && Array.isArray(item.content)) {
		for (const part of item.content) {
			if (part.type !== "output_text" || !part.text) continue;
			answerParts.push(part.text);
			for (const annotation of part.annotations ?? []) collectAnnotation(annotation, part.text, sources, citations);
		}
	}
	for (const annotation of item.annotations ?? []) collectAnnotation(annotation, "", sources, citations);
	if (item.type === "reasoning" && Array.isArray(item.summary)) {
		for (const part of item.summary) {
			if (part.type === "summary_text" && part.text) answerParts.push(part.text);
		}
	}
}

/** Parse a streamed Hosted Responses body shared by Codex and OpenAI providers. */
export async function parseHostedResponsesSse(
	body: ReadableStream<Uint8Array>,
	options: Pick<HostedResponsesCallOptions, "provider" | "displayName" | "model" | "signal">,
): Promise<HostedResponsesResult> {
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	let model = options.model;
	let requestId = "";
	let usage: SearchUsage | undefined;
	let webSearchInvoked = false;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;
		if (eventType.startsWith("response.web_search_call")) webSearchInvoked = true;

		if (eventType === "response.created") {
			const response = asResponse(rawEvent.response);
			if (response?.id) requestId = response.id;
			if (response?.model) model = response.model;
			continue;
		}
		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) streamedAnswerParts.push(delta);
			continue;
		}
		if (eventType === "response.output_item.done") {
			const item = asResponseItem(rawEvent.item);
			if (!item) continue;
			if (item.type === "web_search_call") webSearchInvoked = true;
			collectWebSearchSources(item, sources);
			collectMessage(item, answerParts, sources, citations);
			continue;
		}
		if (eventType === "response.completed" || eventType === "response.done") {
			const response = asResponse(rawEvent.response);
			if (!response) continue;
			if (response.model) model = response.model;
			if (response.id) requestId = response.id;
			if (response.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
				const inputTokens = response.usage.input_tokens;
				const outputTokens = response.usage.output_tokens;
				const totalTokens = response.usage.total_tokens;
				const parsedUsage: SearchUsage = {
					...(typeof inputTokens === "number" ? { inputTokens: inputTokens - cachedTokens } : {}),
					...(typeof outputTokens === "number" ? { outputTokens } : {}),
					...(typeof totalTokens === "number" ? { totalTokens } : {}),
				};
				usage = Object.keys(parsedUsage).length > 0 ? parsedUsage : undefined;
			}
			continue;
		}
		if (eventType === "error") {
			const { code, message } = extractSseError(rawEvent);
			throw new SearchProviderError(
				options.provider,
				`${options.displayName} error (${code}): ${message || "Unknown error"}`,
				classifySseErrorStatus(code, message),
			);
		}
		if (eventType === "response.failed") {
			const { code, message } = extractSseError(rawEvent);
			const detail = code
				? `${options.displayName} request failed (${code}): ${message || "Request failed"}`
				: `${options.displayName} request failed: ${message || "Request failed"}`;
			throw new SearchProviderError(options.provider, detail, classifySseErrorStatus(code, message));
		}
	}

	if (!webSearchInvoked) throw new HostedResponsesNoWebSearchError(options.provider, options.displayName);

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
	const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
	const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
	const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
	if (!hasFinalText && !hasStreamedText && sources.length === 0) {
		throw new SearchProviderError(options.provider, `${options.displayName} returned image-only response`, 502);
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) addSource(sources, source);
	}
	return { answer, sources, citations, model, requestId, usage };
}

/** POST and parse one streamed Hosted Responses search. */
export async function callHostedResponsesSearch(options: HostedResponsesCallOptions): Promise<HostedResponsesResult> {
	const response = await (options.fetch ?? fetch)(options.url, {
		method: "POST",
		headers: options.headers,
		body: JSON.stringify(buildHostedResponsesRequestBody(options)),
		signal: withHardTimeout(options.signal, options.timeoutMs),
	});
	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError(options.provider, response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			options.provider,
			`${options.displayName} API error (${response.status}): ${errorText}`,
			response.status,
		);
	}
	if (!response.body) {
		throw new SearchProviderError(options.provider, `${options.displayName} API returned no response body`, 500);
	}
	return parseHostedResponsesSse(response.body, options);
}
