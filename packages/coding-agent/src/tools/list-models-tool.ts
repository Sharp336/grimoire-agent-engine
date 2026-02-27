import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { fuzzyFilter } from "../utils/fuzzy";
import type { ToolSession } from "./index";

const listModelsSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Fuzzy search filter (e.g. 'haiku', 'gpt-4'). If omitted, returns all available models.",
		}),
	),
});

type ListModelsParams = Static<typeof listModelsSchema>;

export interface ListModelsDetails {
	models: ModelEntry[];
}

interface ModelEntry {
	provider: string;
	id: string;
	reasoning: boolean;
	contextWindow: number;
}

/**
 * Normalize separators so 'opus 4.6', 'opus 4-6', 'opus46' all match 'claude-opus-4-6'.
 * Collapses dots, dashes, underscores, and spaces into single spaces for uniform matching.
 */
function normalizeForSearch(text: string): string {
	return text
		.replace(/[.\-_]/g, " ")
		.replace(/([a-z])(\d)/gi, "$1 $2")
		.replace(/(\d)([a-z])/gi, "$1 $2")
		.replace(/(\d)(\d)/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * Check if all query tokens appear as substrings in the text.
 * Stricter than subsequence fuzzy matching -- requires contiguous token matches.
 */
function containsAllTokens(text: string, tokens: string[]): boolean {
	return tokens.every(token => text.includes(token));
}
export class ListModelsTool implements AgentTool<typeof listModelsSchema, ListModelsDetails> {
	readonly name = "list_models";
	readonly label = "ListModels";
	readonly description =
		"List available models with optional fuzzy search. Use to verify exact provider/modelId strings before passing them to task tool's model parameter.";
	readonly parameters = listModelsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ListModelsTool | null {
		if (!session.modelRegistry) return null;
		return new ListModelsTool(session);
	}

	async execute(_toolCallId: string, params: ListModelsParams): Promise<AgentToolResult<ListModelsDetails>> {
		const registry = this.session.modelRegistry!;
		const available = registry.getAvailable();

		if (available.length === 0) {
			return {
				content: [{ type: "text", text: "No models available. No API keys configured." }],
				details: { models: [] },
			};
		}

		let filtered: Model<Api>[] = available;
		if (params.query) {
			const normalizedQuery = normalizeForSearch(params.query);
			const tokens = normalizedQuery.split(/\s+/).filter(t => t.length > 0);
			const getText = (m: Model<Api>) => normalizeForSearch(`${m.provider} ${m.id}`);

			// Prefer strict substring matching -- requires each token to appear contiguously.
			// Falls back to fuzzy subsequence matching only if strict produces no results.
			const strict = available.filter(m => containsAllTokens(getText(m), tokens));
			filtered = strict.length > 0 ? strict : fuzzyFilter(available, normalizedQuery, getText);
		}

		if (filtered.length === 0) {
			return {
				content: [{ type: "text", text: `No models matching "${params.query}".` }],
				details: { models: [] },
			};
		}

		filtered.sort((a, b) => {
			const cmp = a.provider.localeCompare(b.provider);
			if (cmp !== 0) return cmp;
			return a.id.localeCompare(b.id);
		});

		const models: ModelEntry[] = filtered.map(m => ({
			provider: m.provider,
			id: m.id,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
		}));

		const lines = models.map(m => `${m.provider}/${m.id}  reasoning=${m.reasoning}  context=${m.contextWindow}`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { models },
		};
	}
}
