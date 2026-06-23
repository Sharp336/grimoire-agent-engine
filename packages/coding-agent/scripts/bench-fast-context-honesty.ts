#!/usr/bin/env bun
/**
 * FastContext citation-honesty benchmark.
 *
 * Verifies that FastContext's citations are honest — cited files actually
 * exist on disk, contain the claimed keyword content, and carry valid line
 * ranges. Inspired by the determinacy repo's grep-certified receipts: a
 * citation is a *promise* about the repo, and promises must be checkable.
 *
 * Runs the REAL FastContext hint pipeline (FastContextTool.execute, hint mode)
 * against the omp-dev repo with the local LLM mocked to return a FIXED plan per
 * query (same harness as bench-fast-context-retrieval.ts). For each citation
 * emitted we then:
 *   1. resolve the cited path under the repo and check it exists on disk
 *      (Bun.file().exists()) — phantom_citation_rate / citation_existence_rate
 *   2. read the file and confirm each FC keyword appears somewhere in at least
 *      one cited file — keyword_verification_rate
 *   3. compare cited files against the ground-truth set for the query —
 *      false_positive_rate / false_negative_rate
 *   4. parse the `path:start-end` line range and confirm start<=end<=lineCount
 *      — line_range_valid_rate
 *
 * Run from repo root:
 *   bun packages/coding-agent/scripts/bench-fast-context-honesty.ts
 */
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FastContextTool } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const REPO = path.resolve(import.meta.dir, "../../..");

interface Plan {
	keywords: string[];
	globs: string[];
	grep_patterns: string[];
	grep_paths: string[];
	description: string;
}

interface Case {
	query: string;
	/** Mocked LLM hint plan — a realistic query expansion. */
	plan: Plan;
	/** Repo-relative ground-truth definition file(s) the agent needs. */
	gt: string[];
}

// Realistic cross-package retrieval queries. Plans mimic a competent FC model;
// the ranking challenge comes from grep/glob noise (tests, docs, CHANGELOG,
// unrelated same-keyword files across packages), not from a bad plan.
const SUITE: Case[] = [
	{
		query: "where is the fast context hint ranking and snippet selection logic",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "snippet", "ranking", "hint"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["readSnippets", "executeHint"],
			grep_paths: ["packages/coding-agent"],
			description: "FastContext ranking + snippets",
		},
	},
	{
		query: "how does the coding agent declare the worker host entry and dispatch workers",
		gt: ["packages/coding-agent/src/cli.ts", "packages/utils/src/worker-host.ts"],
		plan: {
			keywords: ["worker", "declareWorkerHostEntry", "dispatch"],
			globs: ["**/cli.ts", "**/*worker-host*"],
			grep_patterns: ["declareWorkerHostEntry", "__omp_worker"],
			grep_paths: ["packages"],
			description: "Worker host entry + dispatch",
		},
	},
	{
		query: "find the model identity family and version classification",
		gt: ["packages/catalog/src/identity/classify.ts"],
		plan: {
			keywords: ["classify", "identity", "family", "version"],
			globs: ["**/identity/**", "**/*classify*"],
			grep_patterns: ["classify", "family"],
			grep_paths: ["packages/catalog"],
			description: "Model identity classification",
		},
	},
	{
		query: "where is the agent main loop that calls tools and manages state",
		gt: ["packages/agent/src/agent-loop.ts"],
		plan: {
			keywords: ["agent", "loop", "tool", "state"],
			globs: ["**/agent-loop*", "**/*agent*"],
			grep_patterns: ["agentLoop", "tool"],
			grep_paths: ["packages/agent"],
			description: "Agent loop + tool calls",
		},
	},
	{
		query: "how are settings isolated and overridden per session",
		gt: ["packages/coding-agent/src/config/settings.ts"],
		plan: {
			keywords: ["settings", "isolated", "override"],
			globs: ["**/config/settings.ts"],
			grep_patterns: ["isolated", "override"],
			grep_paths: ["packages/coding-agent"],
			description: "Settings isolation + override",
		},
	},
	{
		query: "where is the commit changelog finalization and version bump",
		gt: ["packages/coding-agent/src/commit/changelog/index.ts"],
		plan: {
			keywords: ["changelog", "commit", "version", "release"],
			globs: ["**/changelog/**", "**/*changelog*"],
			grep_patterns: ["changelog", "finalize"],
			grep_paths: ["packages/coding-agent"],
			description: "Changelog finalization",
		},
	},
	{
		query: "how is tool output sanitized and truncated for terminal rendering",
		gt: ["packages/coding-agent/src/tools/render-utils.ts"],
		plan: {
			keywords: ["sanitize", "truncate", "render", "tabs"],
			globs: ["**/*render-utils*"],
			grep_patterns: ["replaceTabs", "truncateToWidth"],
			grep_paths: ["packages/coding-agent"],
			description: "Tool render sanitization",
		},
	},
	{
		query: "find the subprocess worker client that spawns and communicates with workers",
		gt: ["packages/coding-agent/src/subprocess/worker-client.ts"],
		plan: {
			keywords: ["worker", "client", "subprocess", "spawn"],
			globs: ["**/subprocess/**", "**/*worker-client*"],
			grep_patterns: ["WorkerClient", "subprocess"],
			grep_paths: ["packages/coding-agent"],
			description: "Subprocess worker client",
		},
	},
	{
		query: "where is the generated model thinking metadata and policy application",
		gt: ["packages/catalog/src/model-thinking.ts", "packages/catalog/scripts/generated-policies.ts"],
		plan: {
			keywords: ["thinking", "model", "policy", "generated"],
			globs: ["**/*model-thinking*"],
			grep_patterns: ["applyGeneratedModelPolicies", "thinking"],
			grep_paths: ["packages/catalog"],
			description: "Model thinking metadata",
		},
	},
	{
		query: "find the catalog provider descriptors and discovery factory",
		gt: ["packages/catalog/src/provider-models/descriptors.ts"],
		plan: {
			keywords: ["provider", "descriptor", "catalog", "discovery"],
			globs: ["**/provider-models/**", "**/*descriptor*"],
			grep_patterns: ["CATALOG_PROVIDERS", "descriptor"],
			grep_paths: ["packages/catalog"],
			description: "Provider descriptors",
		},
	},
	{
		query: "where is the MCP server transport and tool registration",
		gt: ["packages/coding-agent/src/mcp/manager.ts", "packages/coding-agent/src/mcp/tool-bridge.ts"],
		plan: {
			keywords: ["mcp", "transport", "tool", "register"],
			globs: ["**/mcp/**"],
			grep_patterns: ["mcp", "transport"],
			grep_paths: ["packages/coding-agent"],
			description: "MCP transport + tools",
		},
	},
	{
		query: "how is the LSP client manager initialized and requests handled",
		gt: ["packages/coding-agent/src/lsp/index.ts"],
		plan: {
			keywords: ["lsp", "client", "request", "symbol"],
			globs: ["**/lsp/**"],
			grep_patterns: ["lsp", "codeActions"],
			grep_paths: ["packages/coding-agent"],
			description: "LSP client manager",
		},
	},
	{
		query: "where is the task subagent spawn and parallel dispatch",
		gt: ["packages/coding-agent/src/task/index.ts"],
		plan: {
			keywords: ["task", "subagent", "spawn", "parallel"],
			globs: ["**/task/**"],
			grep_patterns: ["spawn", "subagent"],
			grep_paths: ["packages/coding-agent"],
			description: "Task subagent dispatch",
		},
	},
	{
		query: "find the tool result builder that constructs read approval results",
		gt: ["packages/coding-agent/src/tools/tool-result.ts"],
		plan: {
			keywords: ["tool", "result", "builder", "approval"],
			globs: ["**/*tool-result*"],
			grep_patterns: ["toolResult", "approval"],
			grep_paths: ["packages/coding-agent"],
			description: "Tool result builder",
		},
	},
	{
		query: "where is the fast context tool renderer that displays citations inline",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "renderer", "citation", "inline"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["fastContextToolRenderer", "parseCitationTarget"],
			grep_paths: ["packages/coding-agent"],
			description: "FastContext TUI renderer",
		},
	},
	{
		query: "how is streaming output truncated and buffered for display",
		gt: ["packages/coding-agent/src/session/streaming-output.ts"],
		plan: {
			keywords: ["streaming", "output", "truncated", "buffered"],
			globs: ["**/*streaming-output*"],
			grep_patterns: ["truncateTail", "TailBuffer"],
			grep_paths: ["packages/coding-agent"],
			description: "Streaming output truncation",
		},
	},
	{
		query: "find the temporary file and directory utility helpers",
		gt: ["packages/utils/src/temp.ts"],
		plan: {
			keywords: ["temporary", "file", "directory", "utility"],
			globs: ["**/utils/**", "**/*temp*"],
			grep_patterns: ["TempDir", "temp"],
			grep_paths: ["packages/utils"],
			description: "Temp file utilities",
		},
	},
	{
		query: "where is the git status parsing and porcelain diff handling",
		gt: ["packages/coding-agent/src/utils/git.ts"],
		plan: {
			keywords: ["git", "status", "parsing", "porcelain"],
			globs: ["**/utils/git.ts"],
			grep_patterns: ["porcelain", "gitStatus"],
			grep_paths: ["packages/coding-agent"],
			description: "Git status parsing",
		},
	},
	{
		query: "where is the conversation message type and context structure definition",
		gt: ["packages/agent/src/types.ts", "packages/ai/src/types.ts"],
		plan: {
			keywords: ["message", "type", "context", "structure"],
			globs: ["**/agent/types.ts"],
			grep_patterns: ["Message", "Context"],
			grep_paths: ["packages/agent"],
			description: "Message types",
		},
	},
	{
		query: "where is the logger setup and log file rotation",
		gt: ["packages/utils/src/logger.ts"],
		plan: {
			keywords: ["logger", "setup", "log", "rotation"],
			globs: ["**/utils/logger.ts"],
			grep_patterns: ["logger", "rotation"],
			grep_paths: ["packages/utils"],
			description: "Logger setup",
		},
	},
	{
		query: "how is the conversation context assembled and message history tracked",
		gt: ["packages/coding-agent/src/session/session-context.ts"],
		plan: {
			keywords: ["context", "assembled", "message", "history"],
			globs: ["**/*session-context*"],
			grep_patterns: ["sessionContext", "context"],
			grep_paths: ["packages/coding-agent"],
			description: "Session context",
		},
	},
	{
		query: "where is the tool output metadata and content type structure",
		gt: ["packages/coding-agent/src/tools/output-meta.ts"],
		plan: {
			keywords: ["tool", "output", "metadata", "content"],
			globs: ["**/*output-meta*"],
			grep_patterns: ["outputMeta", "ToolContent"],
			grep_paths: ["packages/coding-agent"],
			description: "Output metadata",
		},
	},
];
// Messy query variants — test robustness to typos, fragments, pronouns, multi-intent.
// These reuse existing GTs but with degraded query quality.
const MESSY: Case[] = [
	{
		query: "fastcontext snipet rankng",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "snippet", "ranking", "hint"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["readSnippets", "executeHint"],
			grep_paths: ["packages/coding-agent"],
			description: "FC ranking + snippets (typo query)",
		},
	},
	{
		query: "the thing that handles temp files and dirs",
		gt: ["packages/utils/src/temp.ts"],
		plan: {
			keywords: ["temporary", "file", "directory", "utility", "helpers"],
			globs: ["**/utils/**", "**/*temp*"],
			grep_patterns: ["TempDir", "temp"],
			grep_paths: ["packages/utils"],
			description: "Temp file utilities (pronoun query)",
		},
	},
	{
		query: "how does settings work and where do i change the commit log",
		gt: ["packages/coding-agent/src/config/settings.ts", "packages/coding-agent/src/commit/changelog/index.ts"],
		plan: {
			keywords: ["settings", "commit", "changelog", "config"],
			globs: ["**/config/settings.ts", "**/changelog/**"],
			grep_patterns: ["settings", "changelog"],
			grep_paths: ["packages/coding-agent"],
			description: "Settings + changelog (multi-intent query)",
		},
	},
	{
		query: "logger",
		gt: ["packages/utils/src/logger.ts"],
		plan: {
			keywords: ["logger", "log", "rotation", "setup"],
			globs: ["**/utils/logger.ts"],
			grep_patterns: ["logger", "rotation"],
			grep_paths: ["packages/utils"],
			description: "Logger setup (fragment query)",
		},
	},
	{
		query: "fix the mcp transport its broken",
		gt: ["packages/coding-agent/src/mcp/manager.ts", "packages/coding-agent/src/mcp/tool-bridge.ts"],
		plan: {
			keywords: ["mcp", "transport", "tool", "register"],
			globs: ["**/mcp/**"],
			grep_patterns: ["mcp", "transport"],
			grep_paths: ["packages/coding-agent"],
			description: "MCP transport + tools (bug-report query)",
		},
	},
];
const ALL_SUITE = [...SUITE, ...MESSY];

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function mockFetch(plan: Plan) {
	return async (url: string): Promise<Response> => {
		if (url === "http://127.0.0.1:8080/v1/models")
			return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
		if (url === "http://127.0.0.1:8080/v1/chat/completions")
			return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] });
		return new Response("not found", { status: 404 });
	};
}

function rel(absPath: string): string {
	return path.relative(REPO, absPath).replace(/\\/g, "/");
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/");
}

// Parse a FastContext hint-mode citation of the form "<abspath>:<start>-<end>"
// into its components. Returns null when the line-range suffix is absent or
// malformed (those citations are counted as "no line range" for the
// line_range_valid_rate denominator).
interface ParsedCitation {
	absPath: string;
	start: number;
	end: number;
	hasRange: boolean;
}

function parseCitation(citation: string): ParsedCitation {
	const m = citation.match(/^(.*):(\d+)-(\d+)$/);
	if (!m) {
		return { absPath: citation, start: 0, end: 0, hasRange: false };
	}
	return { absPath: m[1], start: Number(m[2]), end: Number(m[3]), hasRange: true };
}

const session = makeSession(REPO);

// Honesty accumulators.
let totalCitations = 0;
let phantomCount = 0; // cited files that DON'T exist on disk
let existCount = 0; // cited files that DO exist on disk
let totalKeywords = 0; // sum of FC keyword counts across queries
let keywordVerifiedCount = 0; // keywords that appear in >=1 cited file's content
let totalGtFiles = 0; // sum of GT file counts across queries
let falseNegativeCount = 0; // GT files NOT in citations
let falsePositiveCount = 0; // cited files NOT in ground truth
let citationsWithRange = 0; // denominator for line_range_valid_rate
let lineRangeValidCount = 0; // citations with start<=end<=lineCount

const perCase: string[] = [];

for (const c of ALL_SUITE) {
	const tool = new FastContextTool(session, { fetch: mockFetch(c.plan) });
	const result = await tool.execute("bench", {
		query: c.query,
		include_snippets: true,
		snippet_lines: 10,
	});
	const rawCites = result.details?.citations ?? [];
	const keywords: string[] = result.details?.keywords ?? c.plan.keywords;
	const gtNorm = c.gt.map(normalize);

	// Resolve + verify each citation against disk.
	const citedRels: string[] = [];
	const citedAbsPaths: string[] = [];
	for (const raw of rawCites) {
		totalCitations++;
		const parsed = parseCitation(raw);
		const abs = parsed.absPath;
		citedAbsPaths.push(abs);
		const citedRel = rel(abs);
		citedRels.push(citedRel);

		// (1) existence — the core honesty check.
		const exists = await Bun.file(abs).exists();
		if (exists) {
			existCount++;
		} else {
			phantomCount++;
		}

		// (4) line-range validity: start<=end<=lineCount, only when a range
		// is present and the file exists (a non-existent file has no line
		// count to validate against).
		if (parsed.hasRange) {
			citationsWithRange++;
			if (exists) {
				const text = await Bun.file(abs).text();
				const lineCount = text.split(/\r?\n/).length;
				if (parsed.start >= 1 && parsed.end >= parsed.start && parsed.end <= lineCount) {
					lineRangeValidCount++;
				}
			}
		}

		// (5) false positive: cited file not in ground truth (path match,
		// tolerant of trailing-segment / prefix differences like the
		// retrieval bench).
		const isGt = gtNorm.some(
			g => citedRel === g || citedRel.endsWith("/" + g) || g.endsWith("/" + citedRel),
		);
		if (!isGt) falsePositiveCount++;
	}

	// (3) keyword verification: a keyword is "honest" if it appears in at
	// least one cited file's content (case-insensitive substring). Uses the
	// FC-reported keywords (from result.details), not the mocked plan, so we
	// audit what FC actually claimed.
	const fileTexts: string[] = [];
	for (const abs of citedAbsPaths) {
		if (await Bun.file(abs).exists()) {
			fileTexts.push((await Bun.file(abs).text()).toLowerCase());
		}
	}
	for (const kw of keywords) {
		totalKeywords++;
		const kwLower = kw.toLowerCase();
		if (fileTexts.some(t => t.includes(kwLower))) {
			keywordVerifiedCount++;
		}
	}

	// (6) false negative: GT files NOT covered by any citation.
	totalGtFiles += gtNorm.length;
	for (const g of gtNorm) {
		const covered = citedRels.some(cr => cr === g || cr.endsWith("/" + g) || g.endsWith("/" + cr));
		if (!covered) falseNegativeCount++;
	}

	perCase.push(
		`  cites=${rawCites.length} exist=${existCount === totalCitations ? "ok" : "PHANTOM"} ` +
			`kw=${keywords.length} ${c.query.slice(0, 38)}  →  ${citedRels.slice(0, 3).join(", ")}`,
	);
}

const n = ALL_SUITE.length;
const phantomRate = totalCitations > 0 ? phantomCount / totalCitations : 0;
const existenceRate = totalCitations > 0 ? existCount / totalCitations : 0;
const keywordVerificationRate = totalKeywords > 0 ? keywordVerifiedCount / totalKeywords : 0;
const falsePositiveRate = totalCitations > 0 ? falsePositiveCount / totalCitations : 0;
const falseNegativeRate = totalGtFiles > 0 ? falseNegativeCount / totalGtFiles : 0;
const lineRangeValidRate = citationsWithRange > 0 ? lineRangeValidCount / citationsWithRange : 0;

if (process.env.FC_BENCH_VERBOSE) {
	console.log(perCase.join("\n"));
	console.log("");
}

console.log(`METRIC phantom_citation_rate=${phantomRate.toFixed(4)}`);
console.log(`METRIC citation_existence_rate=${existenceRate.toFixed(4)}`);
console.log(`METRIC keyword_verification_rate=${keywordVerificationRate.toFixed(4)}`);
console.log(`METRIC false_positive_rate=${falsePositiveRate.toFixed(4)}`);
console.log(`METRIC false_negative_rate=${falseNegativeRate.toFixed(4)}`);
console.log(`METRIC line_range_valid_rate=${lineRangeValidRate.toFixed(4)}`);
console.log(`# total_citations=${totalCitations} total_keywords=${totalKeywords} total_gt_files=${totalGtFiles} citations_with_range=${citationsWithRange} queries=${n}`);
