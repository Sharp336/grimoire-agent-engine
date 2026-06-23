#!/usr/bin/env bun
/**
 * FastContext token-savings benchmark.
 *
 * Measures how FastContext saves tokens versus NOT using FastContext, across
 * the same query suite used by bench-fast-context-retrieval.ts.
 *
 * Two paths per query:
 *   1. FC hint path  — real FastContextTool.execute (hint mode) with mocked
 *      fetch, identical to the retrieval bench. Token cost = the hint packet
 *      returned to the agent (chars/4). Output tokens are 0 (the hint-server
 *      response is mocked and not charged to the agent).
 *   2. No-FC path    — a SIMULATED multi-round agent trajectory (search → read
 *      → search+read) that an agent would follow without fast_context. Token
 *      costs are estimated from a fixed per-round model; retrieval quality is
 *      simulated by a "dumb grep" over a pre-scanned repo file list ranked by
 *      keyword/path overlap with the ground-truth file.
 *
 * Metrics emitted (METRIC lines):
 *   fc_avg_tokens, nofc_avg_tokens, token_savings_pct,
 *   fc_avg_packet_chars, nofc_avg_tool_calls,
 *   fc_hit_at_1, fc_hit_at_5, fc_mrr,
 *   nofc_hit_at_1, nofc_hit_at_5, nofc_mrr.
 *
 * Run from repo root:
 *   bun packages/coding-agent/scripts/bench-fast-context-token-savings.ts
 */
import * as path from "node:path";
import * as fs from "node:fs";
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

// ---------------------------------------------------------------------------
// No-FC path: simulate a "dumb grep" trajectory against a pre-scanned file list.
// ---------------------------------------------------------------------------

const NOISE_RE = /(^|\/)(test|tests|__tests__|docs?|scripts|\.github|infra|CHANGELOG|README|DEVELOPMENT|AGENTS)\b|\.test\.|\.spec\.|\.md$/i;

/** Recursively collect repo-relative source file paths under `dir`. */
function scanFiles(dir: string, acc: string[] = []): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build")
			continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			scanFiles(full, acc);
		} else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
			acc.push(rel(full));
		}
	}
	return acc;
}

const ALL_FILES = scanFiles(path.join(REPO, "packages"));

/**
 * Simulate a no-FC agent: grep for plan keywords (path + basename overlap),
 * rank candidates by keyword-hit count (desc) then path specificity (shorter
 * first), and return the ranked list. This is the "dumb grep" the agent would
 * scan before reading files.
 */
function simulateGrep(plan: Plan): string[] {
	const kws = plan.keywords.map(k => k.toLowerCase());
	const candidates = ALL_FILES.filter(f => {
		const fl = f.toLowerCase();
		return kws.some(k => fl.includes(k));
	});
	// Also include glob-matched files so globs aren't ignored.
	const globHits = ALL_FILES.filter(f => {
		const fl = f;
		return plan.globs.some(g => {
			const pattern = g.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
			return new RegExp(pattern).test(fl);
		});
	});
	const pool = new Set<string>([...candidates, ...globHits]);
	const scored = [...pool].map(f => {
		const fl = f.toLowerCase();
		let score = 0;
		for (const k of kws) if (fl.includes(k)) score++;
		// Prefer definition-site (non-noise) files.
		if (!NOISE_RE.test(f)) score += 0.5;
		return { f, score, len: f.length };
	});
	scored.sort((a, b) => (b.score - a.score) || (a.len - b.len));
	return scored.map(s => s.f);
}

/** Compute the 1-indexed rank of the first GT file in a ranked list (0 = miss). */
function gtRank(ranked: string[], gt: string[]): number {
	const gtNorm = gt.map(normalize);
	for (let i = 0; i < ranked.length; i++) {
		const r = normalize(ranked[i]);
		if (gtNorm.some(g => r === g || r.endsWith("/" + g) || g.endsWith("/" + r))) return i + 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// No-FC per-round token model (estimated, fixed).
//   Round 1 — search/grep:   input 500, output 200, result 2000
//   Round 2 — read top file:  input 600, output 100, result 4000
//   Round 3 — search+read:    input 800, output 100, result 3000
// Trajectory length depends on where (if anywhere) GT surfaces in the grep.
// ---------------------------------------------------------------------------
function simulateNoFc(plan: Plan, gt: string[]): { tokens: number; toolCalls: number; rank: number } {
	const ranked = simulateGrep(plan);
	const rank = gtRank(ranked, gt);
	// Round 1 always happens (the agent always greps first).
	let tokens = 500 + 200 + 2000;
	let toolCalls = 1; // the search tool call
	if (ranked.length > 0) {
		// Round 2: agent reads the top candidate.
		tokens += 600 + 100 + 4000;
		toolCalls += 1;
	}
	if (rank !== 1) {
		// GT not the top hit → agent does another search + read (round 3).
		tokens += 800 + 100 + 3000;
		toolCalls += 2; // a second search and a second read
	}
	return { tokens, toolCalls, rank };
}

// ---------------------------------------------------------------------------
// Run both paths over the suite.
// ---------------------------------------------------------------------------
const session = makeSession(REPO);

let fcTokenSum = 0;
let fcPacketCharSum = 0;
let fcHit1 = 0;
let fcHit5 = 0;
let fcRrSum = 0;

let nofcTokenSum = 0;
let nofcToolCallSum = 0;
let nofcHit1 = 0;
let nofcHit5 = 0;
let nofcRrSum = 0;

const perCase: string[] = [];

for (const c of ALL_SUITE) {
	// --- FC path ---
	const tool = new FastContextTool(session, { fetch: mockFetch(c.plan) });
	const result = await tool.execute("bench", {
		query: c.query,
		include_snippets: true,
		snippet_lines: 10,
	});
	const text = result.content.find(cc => cc.type === "text");
	const textStr = text?.type === "text" ? text.text : "";
	const fcPacketChars = textStr.length;
	const fcTokens = Math.ceil(fcPacketChars / 4); // input tokens = hint packet
	fcTokenSum += fcTokens;
	fcPacketCharSum += fcPacketChars;

	const fcCites = (result.details?.citations ?? []).map(x => rel(x.replace(/:\d+-\d+.*$/, "")));
	const fcRank = gtRank(fcCites, c.gt);
	if (fcRank > 0) {
		fcRrSum += 1 / fcRank;
		if (fcRank === 1) fcHit1++;
		if (fcRank <= 5) fcHit5++;
	}

	// --- No-FC path (simulated) ---
	const nofc = simulateNoFc(c.plan, c.gt);
	nofcTokenSum += nofc.tokens;
	nofcToolCallSum += nofc.toolCalls;
	if (nofc.rank > 0) {
		nofcRrSum += 1 / nofc.rank;
		if (nofc.rank === 1) nofcHit1++;
		if (nofc.rank <= 5) nofcHit5++;
	}

	perCase.push(
		`  fc#${fcRank || "MISS"}(${fcTokens}tok) nofc#${nofc.rank || "MISS"}(${nofc.tokens}tok,${nofc.toolCalls}calls)  ${c.query.slice(0, 38)}`,
	);
}

const n = ALL_SUITE.length;
const fcAvgTokens = fcTokenSum / n;
const nofcAvgTokens = nofcTokenSum / n;
const tokenSavingsPct = nofcAvgTokens > 0 ? ((nofcAvgTokens - fcAvgTokens) / nofcAvgTokens) * 100 : 0;
const fcAvgPacketChars = fcPacketCharSum / n;
const nofcAvgToolCalls = nofcToolCallSum / n;

const fcHitAt1 = fcHit1 / n;
const fcHitAt5 = fcHit5 / n;
const fcMrr = fcRrSum / n;
const nofcHitAt1 = nofcHit1 / n;
const nofcHitAt5 = nofcHit5 / n;
const nofcMrr = nofcRrSum / n;

if (process.env.FC_BENCH_VERBOSE) {
	console.log(perCase.join("\n"));
}

console.log(`METRIC fc_avg_tokens=${fcAvgTokens.toFixed(0)}`);
console.log(`METRIC nofc_avg_tokens=${nofcAvgTokens.toFixed(0)}`);
console.log(`METRIC token_savings_pct=${tokenSavingsPct.toFixed(2)}`);
console.log(`METRIC fc_avg_packet_chars=${fcAvgPacketChars.toFixed(0)}`);
console.log(`METRIC nofc_avg_tool_calls=${nofcAvgToolCalls.toFixed(2)}`);
console.log(`METRIC fc_hit_at_1=${fcHitAt1.toFixed(4)}`);
console.log(`METRIC fc_hit_at_5=${fcHitAt5.toFixed(4)}`);
console.log(`METRIC fc_mrr=${fcMrr.toFixed(4)}`);
console.log(`METRIC nofc_hit_at_1=${nofcHitAt1.toFixed(4)}`);
console.log(`METRIC nofc_hit_at_5=${nofcHitAt5.toFixed(4)}`);
console.log(`METRIC nofc_mrr=${nofcMrr.toFixed(4)}`);
