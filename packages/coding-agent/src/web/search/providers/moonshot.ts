/**
 * Moonshot Open Platform Web Search Provider
 *
 * Uses Moonshot's built-in $web_search tool function via Open Platform
 * (/v1/chat/completions).
 */
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource, SearchUsage } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_MODEL = "kimi-k3";
const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
const MAX_STEPS = 5;

export interface MoonshotSearchParams extends SearchParams {
	moonshotModel?: string;
}

function resolveBaseUrl(): string {
	return ($env.MOONSHOT_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function resolveMoonshotSearchModel(configuredModel: string | undefined): string {
	return $env.MOONSHOT_SEARCH_MODEL?.trim() || configuredModel?.trim() || DEFAULT_MODEL;
}

interface MoonshotChoiceMessage {
	role?: string;
	content?: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{
		id: string;
		type?: string;
		function: {
			name: string;
			arguments: string;
		};
	}>;
	annotations?: Array<{
		type?: string;
		url?: string;
		title?: string;
		text?: string;
		cited_text?: string;
	}>;
}

interface MoonshotChoice {
	index?: number;
	message?: MoonshotChoiceMessage;
	finish_reason?: string;
}

interface MoonshotChatResponse {
	id?: string;
	model?: string;
	choices?: MoonshotChoice[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		input_tokens?: number;
		output_tokens?: number;
	};
}

/** Execute Moonshot web search using the $web_search built-in tool loop. */
export async function searchMoonshot(params: MoonshotSearchParams): Promise<SearchResponse> {
	const apiKey = await params.authStorage.getApiKey("moonshot", params.sessionId, { signal: params.signal });
	if (!apiKey) {
		throw new SearchProviderError("moonshot", "Moonshot API key not configured.", 401);
	}

	const baseUrl = resolveBaseUrl();
	const model = resolveMoonshotSearchModel(params.moonshotModel);
	const fetchImpl: FetchImpl = params.fetch ?? fetch;

	const messages: Array<Record<string, unknown>> = [];
	if (params.systemPrompt) {
		messages.push({ role: "system", content: params.systemPrompt });
	}
	messages.push({ role: "user", content: params.query });

	const tools = [
		{
			type: "builtin_function",
			function: {
				name: "$web_search",
			},
		},
	];

	let step = 0;
	let finalAnswer: string | undefined;
	let modelUsed = model;
	let usageTotal: SearchUsage | undefined;
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];

	while (step < MAX_STEPS) {
		step++;
		const body: Record<string, unknown> = {
			model,
			messages,
			tools,
		};
		if (params.maxOutputTokens !== undefined) {
			body.max_tokens = params.maxOutputTokens;
		}
		// Kimi K3 accepts only temperature 1; omit other tool-supplied values so the API uses its required default.
		if (params.temperature === 1) {
			body.temperature = 1;
		}

		const response = await fetchImpl(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: withHardTimeout(params.signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("moonshot", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError(
				"moonshot",
				`Moonshot API error (${response.status}): ${errorText}`,
				response.status,
			);
		}

		const data = (await response.json()) as MoonshotChatResponse;

		if (data.model) {
			modelUsed = data.model;
		}
		if (data.usage) {
			const inputTokens = data.usage.prompt_tokens ?? data.usage.input_tokens;
			const outputTokens = data.usage.completion_tokens ?? data.usage.output_tokens;
			if (inputTokens !== undefined || outputTokens !== undefined) {
				usageTotal = { inputTokens, outputTokens };
			}
		}

		const choice = data.choices?.[0];
		if (!choice) {
			throw new SearchProviderError("moonshot", "Moonshot API returned empty choices.", 500);
		}

		const message = choice.message;
		const finishReason = choice.finish_reason;

		if (finishReason === "tool_calls" && message?.tool_calls && message.tool_calls.length > 0) {
			// Moonshot emits "builtin_function", but raw replay rejects it with "tokenization failed"; normalize to "function".
			const formattedMessage = {
				...message,
				tool_calls: message.tool_calls.map(tc => ({
					...tc,
					type: tc.type === "builtin_function" ? "function" : (tc.type ?? "function"),
				})),
			};
			messages.push(formattedMessage as unknown as Record<string, unknown>);

			for (const toolCall of message.tool_calls) {
				const toolName = toolCall.function?.name;
				let argsObj: Record<string, unknown> | undefined;
				if (toolCall.function?.arguments) {
					try {
						argsObj = JSON.parse(toolCall.function.arguments);
					} catch {
						// Pass raw string if unparseable
					}
				}

				if (toolName === "$web_search") {
					if (typeof argsObj?.query === "string" && !searchQueries.includes(argsObj.query)) {
						searchQueries.push(argsObj.query);
					}
				}

				const toolResult = argsObj ?? toolCall.function?.arguments ?? {};
				messages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					name: toolName,
					content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
				});
			}
		} else {
			finalAnswer = message?.content ?? undefined;
			if (Array.isArray(message?.annotations)) {
				for (const item of message.annotations) {
					if (item && typeof item.url === "string") {
						sources.push({
							title: item.title ?? item.url,
							url: item.url,
							snippet: item.text ?? item.cited_text ?? undefined,
						});
					}
				}
			}
			break;
		}
	}

	return {
		provider: "moonshot",
		answer: finalAnswer,
		sources,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		model: modelUsed,
		usage: usageTotal,
	};
}

/** Search provider for Moonshot Open Platform web search. */
export class MoonshotProvider extends SearchProvider {
	readonly id = "moonshot" as const;
	readonly label = "Moonshot";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("moonshot");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchMoonshot(params);
	}
}
