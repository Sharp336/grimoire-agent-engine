import { prompt } from "@oh-my-pi/pi-utils";
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import * as git from "../../../../utils/git";
import * as jj from "../../../../utils/jj";

export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";
export type ReviewSourceRowKind = "context" | "added" | "removed";

export interface ReviewSourceRow {
	kind: ReviewSourceRowKind;
	raw: string;
	content: string;
	oldLine?: number;
	newLine?: number;
	hunkHeader: string;
}

export type ReviewDiffRow =
	| ReviewSourceRow
	| { kind: "hunk"; raw: string; hunkHeader: string }
	| { kind: "no-newline"; raw: string; hunkHeader: string };

export interface ReviewDiffFile {
	path: string;
	oldPath?: string;
	newPath?: string;
	occurrence: number;
	linesAdded: number;
	linesRemoved: number;
	rawDiff: string;
	rows: ReviewDiffRow[];
	isBinary: boolean;
}

export interface ExcludedReviewFile {
	path: string;
	reason: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface ReviewDiffSnapshot {
	files: ReviewDiffFile[];
	excluded: ExcludedReviewFile[];
	totalAdded: number;
	totalRemoved: number;
}

export interface ResolvedReviewTarget {
	kind: LocalReviewKind | "pr";
	mode: string;
	rawDiff: string;
	snapshot: ReviewDiffSnapshot;
	emptyMessage: string;
	filteredMessage?: string;
	diffInstruction?: string;
	contextInstruction?: string;
}

export interface LocalReviewUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{ label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
	{ label: "2. Review uncommitted changes", kind: "uncommitted" },
	{ label: "3. Review a specific commit", kind: "commit" },
];

const EXCLUDED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;
const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
const DEFAULT_CONTEXT_INSTRUCTION = "MAY read full file context as needed via `read`";
const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

function decodeGitPath(token: string): string {
	if (!(token.startsWith('"') && token.endsWith('"'))) return token;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	for (let index = 1; index < token.length - 1; index++) {
		const char = token[index]!;
		if (char !== "\\") {
			bytes.push(...encoder.encode(char));
			continue;
		}
		const escaped = token[++index];
		if (escaped === undefined) break;
		const escapes: Record<string, string> = {
			'"': '"',
			"\\": "\\",
			a: "\x07",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\x0b",
		};
		const decoded = escapes[escaped];
		if (decoded !== undefined) {
			bytes.push(...encoder.encode(decoded));
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && /[0-7]/.test(token[index + 1] ?? "")) octal += token[++index];
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...encoder.encode(escaped));
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

function readGitToken(input: string, offset: number): { token: string; next: number } | undefined {
	let index = offset;
	while (input[index] === " ") index++;
	if (index >= input.length) return undefined;
	if (input[index] !== '"') {
		const end = input.indexOf(" ", index);
		return end < 0
			? { token: input.slice(index), next: input.length }
			: { token: input.slice(index, end), next: end };
	}
	const start = index++;
	let escaped = false;
	while (index < input.length) {
		const char = input[index++];
		if (char === '"' && !escaped) break;
		if (char === "\\" && !escaped) escaped = true;
		else escaped = false;
	}
	return { token: input.slice(start, index), next: index };
}

function stripDiffPrefix(path: string): string {
	return /^[^/]+\//.test(path) ? path.slice(path.indexOf("/") + 1) : path;
}

function parseHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const payload = header.slice("diff --git ".length);
	const oldToken = readGitToken(payload, 0);
	const newToken = oldToken ? readGitToken(payload, oldToken.next) : undefined;
	return {
		oldPath: oldToken ? stripDiffPrefix(decodeGitPath(oldToken.token)) : undefined,
		newPath: newToken ? stripDiffPrefix(decodeGitPath(newToken.token)) : undefined,
	};
}

function parseMarkerPath(line: string): string | undefined {
	const payload = line.slice(4);
	const token = readGitToken(payload, 0)?.token ?? payload.split("\t", 1)[0] ?? "";
	const decoded = decodeGitPath(token);
	return decoded === "/dev/null" ? undefined : stripDiffPrefix(decoded);
}

function parseRenamePath(line: string, prefix: string): string {
	return decodeGitPath(line.slice(prefix.length));
}

function splitFileDiffs(rawDiff: string): string[] {
	const starts: number[] = [];
	const pattern = /^diff --git /gm;
	for (const match of rawDiff.matchAll(pattern)) starts.push(match.index);
	return starts.map((start, index) => rawDiff.slice(start, starts[index + 1] ?? rawDiff.length).trimEnd());
}

function parseRows(lines: readonly string[]): { rows: ReviewDiffRow[]; linesAdded: number; linesRemoved: number } {
	const rows: ReviewDiffRow[] = [];
	let linesAdded = 0;
	let linesRemoved = 0;
	let oldLine = 0;
	let newLine = 0;
	let hunkHeader: string | undefined;
	for (const raw of lines) {
		const hunk = HUNK_HEADER_PATTERN.exec(raw);
		if (hunk) {
			oldLine = Number.parseInt(hunk[1]!, 10);
			newLine = Number.parseInt(hunk[3]!, 10);
			hunkHeader = raw;
			rows.push({ kind: "hunk", raw, hunkHeader: raw });
			continue;
		}
		if (!hunkHeader) continue;
		if (raw === "\\ No newline at end of file") {
			rows.push({ kind: "no-newline", raw, hunkHeader });
			continue;
		}
		if (raw.startsWith("+")) {
			rows.push({ kind: "added", raw, content: raw.slice(1), newLine, hunkHeader });
			newLine++;
			linesAdded++;
			continue;
		}
		if (raw.startsWith("-")) {
			rows.push({ kind: "removed", raw, content: raw.slice(1), oldLine, hunkHeader });
			oldLine++;
			linesRemoved++;
			continue;
		}
		if (raw.startsWith(" ")) {
			rows.push({ kind: "context", raw, content: raw.slice(1), oldLine, newLine, hunkHeader });
			oldLine++;
			newLine++;
		}
	}
	return { rows, linesAdded, linesRemoved };
}

function getExclusionReason(path: string): string | undefined {
	return EXCLUDED_PATTERNS.find(entry => entry.pattern.test(path))?.reason;
}

export function parseReviewDiffSnapshot(rawDiff: string): ReviewDiffSnapshot {
	const files: ReviewDiffFile[] = [];
	const excluded: ExcludedReviewFile[] = [];
	const occurrences = new Map<string, number>();
	let totalAdded = 0;
	let totalRemoved = 0;

	for (const rawFileDiff of splitFileDiffs(rawDiff)) {
		const lines = rawFileDiff.split("\n");
		let { oldPath, newPath } = parseHeaderPaths(lines[0] ?? "");
		for (const line of lines) {
			if (line.startsWith("--- ")) oldPath = parseMarkerPath(line);
			else if (line.startsWith("+++ ")) newPath = parseMarkerPath(line);
			else if (line.startsWith("rename from ")) oldPath = parseRenamePath(line, "rename from ");
			else if (line.startsWith("rename to ")) newPath = parseRenamePath(line, "rename to ");
		}
		const path = newPath ?? oldPath;
		if (!path) continue;
		const parsed = parseRows(lines);
		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({
				path,
				reason: exclusionReason,
				linesAdded: parsed.linesAdded,
				linesRemoved: parsed.linesRemoved,
			});
			continue;
		}
		const occurrence = (occurrences.get(path) ?? 0) + 1;
		occurrences.set(path, occurrence);
		files.push({
			path,
			oldPath,
			newPath,
			occurrence,
			linesAdded: parsed.linesAdded,
			linesRemoved: parsed.linesRemoved,
			rawDiff: rawFileDiff,
			rows: parsed.rows,
			isBinary: lines.some(line => line.startsWith("Binary files ") || line === "GIT binary patch"),
		});
		totalAdded += parsed.linesAdded;
		totalRemoved += parsed.linesRemoved;
	}
	return { files, excluded, totalAdded, totalRemoved };
}

function getFileExt(path: string): string {
	return path.match(/\.([^.]+)$/)?.[1] ?? "";
}

function getRecommendedAgentCount(snapshot: ReviewDiffSnapshot): number {
	const totalLines = snapshot.totalAdded + snapshot.totalRemoved;
	const fileCount = snapshot.files.length;
	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

function getDiffPreview(rawDiff: string, maxLines: number): string {
	const contentLines: string[] = [];
	for (const line of rawDiff.split("\n")) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}
	return contentLines.join("\n");
}

export function buildReviewPrompt(
	mode: string,
	snapshot: ReviewDiffSnapshot,
	rawDiff: string,
	options: { additionalInstructions?: string; diffInstruction?: string; contextInstruction?: string } = {},
): string {
	const agentCount = getRecommendedAgentCount(snapshot);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || snapshot.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = snapshot.totalAdded + snapshot.totalRemoved;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / snapshot.files.length)) : 0;
	const files = snapshot.files.map(file => ({
		path: file.path,
		linesAdded: file.linesAdded,
		linesRemoved: file.linesRemoved,
		ext: getFileExt(file.path),
		hunksPreview: skipDiff ? getDiffPreview(file.rawDiff, linesPerFile) : "",
	}));
	return prompt.render(reviewRequestTemplate, {
		mode,
		files,
		excluded: snapshot.excluded,
		totalAdded: snapshot.totalAdded,
		totalRemoved: snapshot.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions: options.additionalInstructions,
		diffInstruction: options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION,
		contextInstruction: options.contextInstruction ?? DEFAULT_CONTEXT_INSTRUCTION,
	});
}

export function buildReviewPromptForTarget(
	target: ResolvedReviewTarget,
	ui: Pick<LocalReviewUI, "notify"> | undefined,
	additionalInstructions?: string,
): string | undefined {
	if (!target.rawDiff.trim()) {
		ui?.notify(target.emptyMessage, "warning");
		return undefined;
	}
	if (target.snapshot.files.length === 0) {
		ui?.notify(target.filteredMessage ?? "No reviewable files (all changes filtered out)", "warning");
		return undefined;
	}
	return buildReviewPrompt(target.mode, target.snapshot, target.rawDiff, {
		additionalInstructions,
		diffInstruction: target.diffInstruction,
		contextInstruction: target.contextInstruction,
	});
}

function resolvedTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "filteredMessage" | "diffInstruction" | "contextInstruction"> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

async function getGitBranches(cwd: string): Promise<string[]> {
	try {
		return await git.branch.list(cwd, { all: true });
	} catch {
		return [];
	}
}

async function getCurrentBranch(cwd: string): Promise<string> {
	try {
		return (await git.branch.current(cwd)) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getGitStatus(cwd: string): Promise<string> {
	try {
		return await git.status(cwd);
	} catch {
		return "";
	}
}

export async function resolveUncommittedReviewTarget(cwd: string): Promise<ResolvedReviewTarget> {
	if (await jj.repo.is(cwd)) {
		return resolvedTarget(
			"uncommitted",
			"Reviewing JJ working-copy changes",
			await jj.diff(cwd),
			"No uncommitted changes found",
			{
				diffInstruction: JJ_UNCOMMITTED_DIFF_INSTRUCTION,
			},
		);
	}
	const status = await getGitStatus(cwd);
	if (!status.trim()) {
		return resolvedTarget(
			"uncommitted",
			"Reviewing uncommitted changes (staged + unstaged)",
			"",
			"No uncommitted changes found",
			{
				diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
			},
		);
	}
	const [unstagedDiff, stagedDiff] = await Promise.all([git.diff(cwd), git.diff(cwd, { cached: true })]);
	return resolvedTarget(
		"uncommitted",
		"Reviewing uncommitted changes (staged + unstaged)",
		[unstagedDiff, stagedDiff].filter(Boolean).join("\n"),
		"No diff content found",
		{ diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION },
	);
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: LocalReviewUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			const branches = await getGitBranches(cwd);
			if (branches.length === 0) {
				ui.notify("No git branches found", "error");
				return undefined;
			}
			const baseBranch = await ui.select("Select base branch to compare against", branches);
			if (!baseBranch) return undefined;
			const currentBranch = await getCurrentBranch(cwd);
			try {
				return resolvedTarget(
					kind,
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					await git.diff(cwd, { base: `${baseBranch}...${currentBranch}` }),
					`No changes between ${baseBranch} and ${currentBranch}`,
				);
			} catch (error) {
				ui.notify(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}
		case "uncommitted":
			try {
				return await resolveUncommittedReviewTarget(cwd);
			} catch (error) {
				ui.notify(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		case "commit": {
			let commits: string[];
			try {
				commits = await git.log.onelines(cwd, 20);
			} catch {
				commits = [];
			}
			if (commits.length === 0) {
				ui.notify("No commits found", "error");
				return undefined;
			}
			const selectedCommit = await ui.select("Select commit to review", commits);
			if (!selectedCommit) return undefined;
			const hash = selectedCommit.split(" ")[0]!;
			try {
				return resolvedTarget(
					kind,
					`Reviewing commit \`${hash}\``,
					await git.show(cwd, hash, { format: "" }),
					"Commit has no diff content",
					{
						filteredMessage: "No reviewable files in commit (all changes filtered out)",
					},
				);
			} catch (error) {
				ui.notify(`Failed to get commit: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}
	}
}

export async function selectLocalReviewKind(ui: Pick<LocalReviewUI, "select">): Promise<LocalReviewKind | undefined> {
	const selected = await ui.select(
		"Review Mode",
		LOCAL_REVIEW_CHOICES.map(choice => choice.label),
	);
	return LOCAL_REVIEW_CHOICES.find(choice => choice.label === selected)?.kind;
}

export function createPrReviewTarget(
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "diffInstruction" | "contextInstruction"> = {},
): ResolvedReviewTarget {
	return resolvedTarget("pr", mode, rawDiff, emptyMessage, options);
}
