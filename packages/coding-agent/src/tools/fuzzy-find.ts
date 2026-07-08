import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import { fuzzyContentSearch } from "@oh-my-pi/pi-natives";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import fuzzyFindDescription from "../prompts/tools/fuzzy-find.md" with { type: "text" };
import { fileHyperlink, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import { formatMoreItems, replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_LINE_CHAR_LIMIT = 1000;
const LINE_TRUNCATE_LEN = 240;

const fuzzyFindSchema = type({
	query: type("string").describe("Fuzzy query to match against file contents."),
	"path?": type("string").describe("File or directory to search. Defaults to the current working directory."),
	"maxResults?": type("number").describe("Maximum matches to return (default 20)."),
	"gitignore?": type("boolean").describe("Respect .gitignore (default true)."),
	"hidden?": type("boolean").describe("Include hidden files (default false)."),
});

type FuzzyFindParams = typeof fuzzyFindSchema.infer;

export interface FuzzyFindDetails {
	query: string;
	scopePath?: string;
	matchCount?: number;
	totalMatches?: number;
	filesSearched?: number;
	truncated?: boolean;
	matches?: Array<{ path: string; line: number; content: string; score: number }>;
	meta?: OutputMeta;
}

function formatMatch(
	match: { path: string; line: number; content: string; score: number },
	cwd: string,
	includeHyperlinks: boolean,
): string {
	const absolutePath = match.path;
	const displayPath = formatPathRelativeToCwd(absolutePath, cwd);
	const safeContent = replaceTabs(match.content);
	const truncated = truncateToWidth(safeContent, LINE_TRUNCATE_LEN);
	const prefix = includeHyperlinks
		? fileHyperlink(absolutePath, `${displayPath}:${match.line}`, { line: match.line })
		: `${displayPath}:${match.line}`;
	return `${prefix}: ${truncated}`;
}

export class FuzzyFindTool implements AgentTool<typeof fuzzyFindSchema, FuzzyFindDetails> {
	readonly name = "fuzzy_find";
	readonly approval: ToolTier = "read";
	readonly loadMode = "essential";
	readonly label = "FuzzyFind";
	readonly summary = "Fuzzy search file contents";
	readonly description: string;
	readonly parameters = fuzzyFindSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(fuzzyFindDescription);
	}

	async execute(
		_toolCallId: string,
		params: FuzzyFindParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<FuzzyFindDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FuzzyFindDetails>> {
		const { query, path: pathInput, maxResults, gitignore, hidden } = params;

		return untilAborted(signal, async () => {
			if (!query.trim()) {
				throw new ToolError("Query must not be empty");
			}

			const rawPath = pathInput ?? ".";
			const absolutePath = path.resolve(this.session.cwd, rawPath);
			const scopePath = formatPathRelativeToCwd(absolutePath, this.session.cwd);

			const result = await fuzzyContentSearch({
				query: query.trim(),
				path: absolutePath,
				maxResults: maxResults ?? DEFAULT_MAX_RESULTS,
				gitignore: gitignore ?? true,
				hidden: hidden ?? false,
				lineCharLimit: DEFAULT_LINE_CHAR_LIMIT,
				signal,
			});

			const details: FuzzyFindDetails = {
				query: query.trim(),
				scopePath,
				matchCount: result.matches.length,
				totalMatches: result.totalMatches,
				filesSearched: result.filesSearched,
				truncated: result.matches.length < result.totalMatches,
				matches: result.matches.map(m => ({
					path: m.path,
					line: m.line,
					content: m.content,
					score: m.score,
				})),
			};

			if (result.matches.length === 0) {
				return toolResult(details).text(`No fuzzy content matches for "${query.trim()}" in ${scopePath}`).done();
			}

			const includeHyperlinks = this.session.hasUI;
			const lines = result.matches.map(match => formatMatch(match, this.session.cwd, includeHyperlinks));
			const header = `Fuzzy content matches for "${query.trim()}" in ${scopePath} (${result.totalMatches} matches across ${result.filesSearched} files)`;
			const remaining = result.totalMatches - result.matches.length;
			const moreItems = remaining > 0 ? formatMoreItems(remaining, "match") : "";
			const body = [header, "", ...lines];
			if (moreItems) {
				body.push(moreItems);
			}

			return toolResult(details).text(body.join("\n")).limits({ resultLimit: remaining }).done();
		});
	}
}
