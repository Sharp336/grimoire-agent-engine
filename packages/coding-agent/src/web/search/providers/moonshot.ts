/**
 * Moonshot Open Platform Web Search Provider
 *
 * Executes the official `moonshot/web-search:latest` Formula, then lets Kimi
 * consume the Formula's protected output and synthesize the answer.
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
const FORMULA_URI = "moonshot/web-search:latest";
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

interface MoonshotTool {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

interface MoonshotToolsResponse {
	tools?: MoonshotTool[];
}

interface MoonshotFiberResponse {
	status?: string;
	context?: {
		output?: string;
		encrypted_output?: string;
		error?: unknown;
	};
	error?: unknown;
}

/** Execute Moonshot web search using the official Formula tool loop. */
export async function searchMoonshot(params: MoonshotSearchParams): Promise<SearchResponse> {
	const apiKey = await params.authStorage.getApiKey("moonshot", params.sessionId, { signal: params.signal });
	if (!apiKey) {
		throw new SearchProviderError("moonshot", "Moonshot API key not configured.", 401);
	}

	const baseUrl = resolveBaseUrl();
	const model = resolveMoonshotSearchModel(params.moonshotModel);
	const fetchImpl: FetchImpl = params.fetch ?? fetch;
	const authorization = `Bearer ${apiKey}`;
	const searchSignal = withHardTimeout(params.signal);

	const toolsResponse = await fetchImpl(`${baseUrl}/formulas/${FORMULA_URI}/tools`, {
		headers: { Authorization: authorization },
		signal: searchSignal,
	});
	if (!toolsResponse.ok) {
		const errorText = await toolsResponse.text();
		const classified = classifyProviderHttpError("moonshot", toolsResponse.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"moonshot",
			`Moonshot Formula tools API error (${toolsResponse.status}): ${errorText}`,
			toolsResponse.status,
		);
	}

	const toolsData = (await toolsResponse.json()) as MoonshotToolsResponse;
	const tools = toolsData.tools ?? [];
	if (tools.length === 0) {
		throw new SearchProviderError("moonshot", "Moonshot Formula returned no web-search tool declaration.", 502);
	}

	const messages: Array<Record<string, unknown>> = [];
	if (params.systemPrompt) {
		messages.push({ role: "system", content: params.systemPrompt });
	}
	messages.push({ role: "user", content: params.query });

	let step = 0;
	let finalAnswer: string | undefined;
	let modelUsed = model;
	let requestId: string | undefined;
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
		// K3 defaults to max reasoning, which can spend tens of seconds before a search-only tool decision.
		if (model.startsWith("kimi-k3")) {
			body.reasoning_effort = "low";
		}
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
				Authorization: authorization,
			},
			body: JSON.stringify(body),
			signal: searchSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("moonshot", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError(
				"moonshot",
				`Moonshot chat API error (${response.status}): ${errorText}`,
				response.status,
			);
		}

		const data = (await response.json()) as MoonshotChatResponse;
		requestId = data.id ?? requestId;
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
			throw new SearchProviderError("moonshot", "Moonshot API returned empty choices.", 502);
		}

		const message = choice.message;
		if (choice.finish_reason === "tool_calls" && message?.tool_calls && message.tool_calls.length > 0) {
			messages.push(message as unknown as Record<string, unknown>);

			for (const toolCall of message.tool_calls) {
				let argsObj: Record<string, unknown> | undefined;
				try {
					argsObj = JSON.parse(toolCall.function.arguments);
				} catch {
					// The Formula endpoint still receives the original encoded arguments unchanged.
				}
				if (toolCall.function.name === "web_search") {
					const searchQuery = argsObj?.query;
					if (typeof searchQuery === "string" && !searchQueries.includes(searchQuery)) {
						searchQueries.push(searchQuery);
					}
				}

				const fiberResponse = await fetchImpl(`${baseUrl}/formulas/${FORMULA_URI}/fibers`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: authorization,
					},
					body: JSON.stringify(toolCall.function),
					signal: searchSignal,
				});
				if (!fiberResponse.ok) {
					const errorText = await fiberResponse.text();
					const classified = classifyProviderHttpError("moonshot", fiberResponse.status, errorText);
					if (classified) throw classified;
					throw new SearchProviderError(
						"moonshot",
						`Moonshot Formula fiber API error (${fiberResponse.status}): ${errorText}`,
						fiberResponse.status,
					);
				}

				const fiber = (await fiberResponse.json()) as MoonshotFiberResponse;
				if (fiber.status !== "succeeded") {
					const rawError = fiber.error ?? fiber.context?.error;
					const detail =
						typeof rawError === "string"
							? rawError
							: rawError === undefined
								? `status ${fiber.status ?? "unknown"}`
								: JSON.stringify(rawError);
					throw new SearchProviderError("moonshot", `Moonshot Formula fiber failed: ${detail}`, 502);
				}

				const toolResult = fiber.context?.output ?? fiber.context?.encrypted_output;
				if (typeof toolResult !== "string" || toolResult.length === 0) {
					throw new SearchProviderError("moonshot", "Moonshot Formula fiber returned no output.", 502);
				}
				messages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: toolResult,
				});
			}
			continue;
		}

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

	if (step === MAX_STEPS && !finalAnswer) {
		throw new SearchProviderError("moonshot", `Moonshot Formula exceeded ${MAX_STEPS} tool-call steps.`, 502);
	}

	return {
		provider: "moonshot",
		answer: finalAnswer,
		sources,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		model: modelUsed,
		usage: usageTotal,
		requestId,
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
