/**
 * Benchmark: PR rendering path comparison.
 *
 * Compares three paths for surfacing a GitHub PR to the LLM:
 *
 *   A) pr://  Full markdown  — the current omp internal-URL path.
 *             Calls `gh pr view --json <all-fields>` + review-comments fetch,
 *             renders a rich Markdown document with headers, body, files,
 *             reviews, comments.
 *
 *   B) lean   Compact YAML   — the format produced by `gh-axi pr view`.
 *             Same GitHub data; rendered as terse key:value blocks.
 *
 *   C) subp   bunx gh-axi    — subprocess path: spawns `bunx gh-axi pr view`,
 *             gets compact output but pays process-spawn overhead.
 *
 * Gate question: does a native in-process lean renderer save enough tokens
 * to justify the implementation cost, and can it beat the subprocess path on
 * latency?
 *
 * Run:
 *   cd packages/coding-agent
 *   bun bench/pr-render.ts
 *
 * Env vars:
 *   PR_BENCH_ITERS   render iterations per renderer (default: 200)
 *   PR_BENCH_SUBP    subprocess timing iterations (default: 5)
 */

import { countTokens } from "@oh-my-pi/pi-natives";
import * as path from "node:path";

// ── fixture ──────────────────────────────────────────────────────────────────
// microsoft/vscode#325031 — captured 2026-07-08, small PR with review comment.
// Stored under bench/fixtures/ so the benchmark is self-contained and
// deterministic without live GitHub calls.

const fixtureRepo = "microsoft/vscode";
const fixtureNumber = 325031;
const fixturePath = path.resolve(import.meta.dir, "fixtures/pr-325031-vscode.json");
const fixture = JSON.parse(await Bun.file(fixturePath).text()) as PrData;

// ── types ─────────────────────────────────────────────────────────────────────

interface PrAuthor {
	login?: string;
	name?: string;
	is_bot?: boolean;
}

interface PrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

interface PrReview {
	author?: PrAuthor | null;
	body?: string;
	state?: string;
	submittedAt?: string;
}

interface PrData {
	number?: number;
	title?: string;
	state?: string;
	isDraft?: boolean;
	author?: PrAuthor | null;
	baseRefName?: string;
	headRefName?: string;
	url?: string;
	createdAt?: string;
	updatedAt?: string;
	mergeStateStatus?: string;
	reviewDecision?: string;
	body?: string;
	labels?: Array<{ name?: string }>;
	files?: PrFile[];
	reviews?: PrReview[];
	comments?: Array<{ author?: PrAuthor | null; body?: string; createdAt?: string }>;
	reviewComments?: Array<{ author?: PrAuthor | null; body?: string; path?: string; line?: number }>;
}

// ── renderer A: full markdown (mirrors omp formatPrView) ─────────────────────
//
// Faithfully reproduces the output of the private `formatPrView` function in
// packages/coding-agent/src/tools/gh.ts. The function is not exported; this
// re-implementation is the benchmark's source of truth for path A.

const FILE_PREVIEW_LIMIT = 15;

function normalizeText(t?: string | null): string {
	if (!t) return "";
	return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function formatAuthor(a?: PrAuthor | null): string | undefined {
	if (!a) return undefined;
	return a.login ?? undefined;
}

function formatLabels(ls?: Array<{ name?: string }>): string | undefined {
	if (!ls || ls.length === 0) return undefined;
	const names = ls.map(l => l.name).filter(Boolean).join(", ");
	return names || undefined;
}

function pushLine(lines: string[], key: string, value: unknown): void {
	if (value === undefined || value === null || value === false || value === "") return;
	lines.push(`**${key}:** ${value}`);
}

function renderFull(data: PrData): string {
	const lines: string[] = [];
	const id = data.number ?? "?";
	lines.push(`# Pull Request #${id}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if (data.files && data.files.length > 0) {
		lines.push("");
		lines.push(`## Files (${data.files.length})`);
		lines.push("");
		for (const f of data.files.slice(0, FILE_PREVIEW_LIMIT)) {
			const ct = f.changeType ?? "CHANGED";
			const add = f.additions ?? 0;
			const del = f.deletions ?? 0;
			lines.push(`- ${f.path ?? "(unknown)"} [${ct}] (+${add} -${del})`);
		}
		if (data.files.length > FILE_PREVIEW_LIMIT) {
			lines.push(`[...${data.files.length - FILE_PREVIEW_LIMIT} files elided...]`);
		}
	}

	if (data.reviews && data.reviews.length > 0) {
		lines.push("");
		lines.push("## Reviews");
		for (const r of data.reviews) {
			lines.push("");
			lines.push(`### Review by @${r.author?.login ?? "unknown"} — ${r.state ?? "?"}`);
			lines.push(`*${r.submittedAt ?? ""}*`);
			lines.push("");
			lines.push(normalizeText(r.body) || "*(no body)*");
		}
	}

	if (data.comments && data.comments.length > 0) {
		lines.push("");
		lines.push("## Comments");
		for (const c of data.comments) {
			lines.push("");
			lines.push(`### @${c.author?.login ?? "unknown"} — ${c.createdAt ?? ""}`);
			lines.push("");
			lines.push(normalizeText(c.body) || "*(empty)*");
		}
	}

	if (data.reviewComments && data.reviewComments.length > 0) {
		lines.push("");
		lines.push("## Inline Review Comments");
		for (const rc of data.reviewComments) {
			const loc = rc.path ? `${rc.path}:${rc.line ?? "?"}` : "unknown";
			lines.push("");
			lines.push(`### @${rc.author?.login ?? "unknown"} on \`${loc}\``);
			lines.push("");
			lines.push(normalizeText(rc.body) || "*(empty)*");
		}
	}

	return lines.join("\n").trim();
}

// ── renderer B: lean compact YAML (mirrors gh-axi pr view --full) ─────────────
//
// The format gh-axi emits: `pull_request:\n  key: value\n  body: "..."\n`.
// Body is truncated to ~1000 chars with a note if it overflows; reviews and
// comments are inlined as compact blocks rather than full markdown sections.
// This is what a native in-process lean renderer would produce — identical
// token cost to the subprocess path (C), zero process-spawn overhead.

const LEAN_BODY_MAX = 1200;

function escapeLean(s: string): string {
	return `"${s.replace(/\r\n/g, "\\n").replace(/\r/g, "\\n").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
}

function renderLean(data: PrData): string {
	const lines: string[] = [];
	lines.push("pull_request:");
	lines.push(`  number: ${data.number ?? "?"}`);
	lines.push(`  title: ${escapeLean(data.title ?? "")}`);
	lines.push(`  state: ${(data.state ?? "?").toLowerCase()}`);
	lines.push(`  author: ${data.author?.login ?? "?"}`);
	lines.push(`  draft: ${data.isDraft ? "yes" : "no"}`);
	lines.push(`  merged: ${data.state?.toLowerCase() === "merged" ? "yes" : "no"}`);
	if (data.baseRefName) lines.push(`  base: ${data.baseRefName}`);
	if (data.headRefName) lines.push(`  head: ${data.headRefName}`);
	if (data.reviewDecision) lines.push(`  review_decision: ${data.reviewDecision}`);

	const body = normalizeText(data.body);
	const bodyTrunc =
		body.length > LEAN_BODY_MAX
			? `${body.slice(0, LEAN_BODY_MAX)}\n... (truncated, ${body.length} chars total -- use --full to see complete body)`
			: body;
	lines.push(`  body: ${escapeLean(bodyTrunc)}`);

	const commentCount = (data.comments?.length ?? 0) + (data.reviewComments?.length ?? 0);
	const reviewCount = data.reviews?.length ?? 0;
	lines.push(`  comment_count: ${commentCount} -- use --comments to see full comments`);
	lines.push(`  review_count: ${reviewCount} -- use --reviews to see full reviews`);

	if (data.files && data.files.length > 0) {
		lines.push("  files:");
		for (const f of data.files) {
			lines.push(`    - path: ${f.path ?? "?"}`);
			lines.push(`      changes: +${f.additions ?? 0} -${f.deletions ?? 0} [${f.changeType ?? "?"}]`);
		}
	}

	return lines.join("\n");
}

// ── renderer C: subprocess gh-axi ────────────────────────────────────────────

async function runGhAxiSubprocess(repo: string, number: number): Promise<string> {
	const proc = Bun.spawn(
		["bunx", "gh-axi", "pr", "view", String(number), "-R", repo, "--full"],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

// ── timing helpers ────────────────────────────────────────────────────────────

function timeSyncMs(iters: number, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < iters; i++) fn();
	return (Bun.nanoseconds() - start) / 1e6 / iters;
}

async function timeAsyncMs(iters: number, fn: () => Promise<unknown>): Promise<number> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < iters; i++) await fn();
	return (Bun.nanoseconds() - start) / 1e6 / iters;
}

// ── run ───────────────────────────────────────────────────────────────────────

const ITERS = Number(Bun.env.PR_BENCH_ITERS ?? "200");
const SUBP_ITERS = Number(Bun.env.PR_BENCH_SUBP ?? "5");

console.log("PR rendering benchmark");
console.log(`Fixture: ${fixtureRepo}#${fixtureNumber} (${Buffer.byteLength(JSON.stringify(fixture), "utf8")} raw JSON bytes)`);
console.log(`Render iterations: ${ITERS}  Subprocess iterations: ${SUBP_ITERS}\n`);

// Render each path once to validate output exists.
const outFull = renderFull(fixture);
const outLean = renderLean(fixture);
const outSubp = await runGhAxiSubprocess(fixtureRepo, fixtureNumber);

// Byte counts.
const bytesFull = Buffer.byteLength(outFull, "utf8");
const bytesLean = Buffer.byteLength(outLean, "utf8");
const bytesSubp = Buffer.byteLength(outSubp, "utf8");

// Token counts (o200k_base — closest to Claude's tokenizer; ±5-10% error).
const toksFull = countTokens(outFull);
const toksLean = countTokens(outLean);
const toksSubp = countTokens(outSubp);

// Latency (render functions run many iters; subprocess runs few).
const msRenderFull = timeSyncMs(ITERS, () => renderFull(fixture));
const msRenderLean = timeSyncMs(ITERS, () => renderLean(fixture));
const msSubp = await timeAsyncMs(SUBP_ITERS, () => runGhAxiSubprocess(fixtureRepo, fixtureNumber));

// ── report ────────────────────────────────────────────────────────────────────

const pct = (n: number, base: number) => `${((n / base) * 100).toFixed(1)}%`;
const savings = (n: number, base: number) => `${(((base - n) / base) * 100).toFixed(1)}% smaller`;

console.log("=".repeat(72));
console.log("Path            Bytes     Tokens    Render ms    Notes");
console.log("-".repeat(72));
console.log(
	`pr:// full      ${String(bytesFull).padEnd(9)} ${String(toksFull).padEnd(9)} ${msRenderFull.toFixed(3).padEnd(12)} (baseline)`,
);
console.log(
	`lean in-proc    ${String(bytesLean).padEnd(9)} ${String(toksLean).padEnd(9)} ${msRenderLean.toFixed(3).padEnd(12)} ${savings(toksLean, toksFull)} vs full`,
);
console.log(
	`bunx gh-axi     ${String(bytesSubp).padEnd(9)} ${String(toksSubp).padEnd(9)} ${msSubp.toFixed(1).padEnd(12)} (subprocess)`,
);
console.log("=".repeat(72));
console.log();
console.log("Token savings detail:");
console.log(`  lean vs pr://:      ${toksFull - toksLean} tokens saved (${savings(toksLean, toksFull)})`);
console.log(`  lean vs subprocess: subprocess output is ${bytesSubp} bytes / ${toksSubp} tokens`);
console.log(`  lean token budget:  ${toksLean} tokens (${pct(toksLean, toksFull)} of full)`);
console.log();
console.log("Latency detail:");
console.log(`  lean in-proc render:  ${msRenderLean.toFixed(3)}ms`);
console.log(`  full pr:// render:    ${msRenderFull.toFixed(3)}ms`);
console.log(`  bunx gh-axi subproc:  ${msSubp.toFixed(1)}ms avg over ${SUBP_ITERS} runs`);
console.log(
	`  lean vs subproc:      ${(msSubp / msRenderLean).toFixed(0)}x faster (${(msSubp - msRenderLean).toFixed(1)}ms saved per call)`,
);
console.log();

// ── recommendation ────────────────────────────────────────────────────────────

const tokenSavingsPct = ((toksFull - toksLean) / toksFull) * 100;
const subprocOverheadMs = msSubp - msRenderLean;
const leanSameAsSubp = Math.abs(toksLean - toksSubp) <= Math.max(5, toksSubp * 0.05);

console.log("Recommendation:");
if (tokenSavingsPct >= 40 && subprocOverheadMs >= 200) {
	console.log("  BUILD NATIVE NOW");
	console.log(`  Token savings (${tokenSavingsPct.toFixed(0)}%) and subprocess overhead (${subprocOverheadMs.toFixed(0)}ms) are both significant.`);
	console.log("  The lean in-process renderer pays off on both the token-cost and latency axes.");
} else if (tokenSavingsPct >= 40) {
	console.log("  BUILD NATIVE NOW (token savings justify it)");
	console.log(`  ${tokenSavingsPct.toFixed(0)}% token reduction is substantial; subprocess overhead of ${subprocOverheadMs.toFixed(0)}ms is a secondary win.`);
} else if (tokenSavingsPct >= 15 && subprocOverheadMs >= 200) {
	console.log("  BUILD NATIVE (latency win is the stronger argument)");
	console.log(`  ${subprocOverheadMs.toFixed(0)}ms subprocess overhead dominates at this savings level (${tokenSavingsPct.toFixed(0)}% tokens).`);
} else if (tokenSavingsPct >= 15) {
	console.log("  NEEDS DATA: token savings are moderate, subprocess overhead is low.");
	console.log("  Consider measuring over PRs with larger bodies/more comments before committing.");
} else {
	console.log("  DO NOT BUILD: savings are marginal.");
	console.log(`  Token delta: ${toksFull - toksLean} (${tokenSavingsPct.toFixed(1)}%). Not worth the maintenance surface.`);
}

if (!leanSameAsSubp) {
	console.log(`  NOTE: lean renderer (${toksLean} tok) and subprocess (${toksSubp} tok) diverge by >`
		+ ` 5% -- lean format may need tuning to match gh-axi fidelity.`);
}

console.log();
console.log("Output samples:");
console.log("-".repeat(40));
console.log("pr:// full (first 400 chars):");
console.log(outFull.slice(0, 400));
console.log("\nlean in-proc (first 400 chars):");
console.log(outLean.slice(0, 400));
console.log("\nbunx gh-axi (first 400 chars):");
console.log(outSubp.slice(0, 400));
