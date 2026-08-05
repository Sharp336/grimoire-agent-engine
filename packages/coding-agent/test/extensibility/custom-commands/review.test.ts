import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseReviewDiffSnapshot,
	ReviewCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import type {
	CustomCommandAPI,
	CustomCommandContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { PrDiffPayload, ViewLookupResult } from "@oh-my-pi/pi-coding-agent/tools/gh";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const SAMPLE_JJ_DIFF = `diff --git a/src/workspace.ts b/src/workspace.ts
--- a/src/workspace.ts
+++ b/src/workspace.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

const SAMPLE_PR_DIFF = `diff --git a/src/pr.ts b/src/pr.ts
--- a/src/pr.ts
+++ b/src/pr.ts
@@ -1 +1 @@
-export const pr = false;
+export const pr = true;
`;

function makeManyFileDiff(fileCount: number): string {
	return Array.from(
		{ length: fileCount },
		(_, idx) => `diff --git a/src/pr-${idx}.ts b/src/pr-${idx}.ts
--- a/src/pr-${idx}.ts
+++ b/src/pr-${idx}.ts
@@ -1 +1 @@
-export const pr${idx} = false;
+export const pr${idx} = true;
`,
	).join("\n");
}

interface SelectCall {
	title: string;
	options: string[];
}

interface NotifyCall {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

function makePrDiffLookup(unified: string): ViewLookupResult<PrDiffPayload> {
	return {
		rendered: unified,
		sourceUrl: undefined,
		payload: { unified, files: [] },
		status: "fresh",
		fetchedAt: Date.now(),
	};
}

function makeUserEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-05T00:00:00.000Z",
		message: {
			role: "user",
			content,
			timestamp: Date.now(),
		},
	};
}

interface EditorCall {
	title: string;
	prefill: string | undefined;
	editorOptions: { promptStyle?: boolean } | undefined;
}

describe("ReviewCommand", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-command-"));
		return tmpDir;
	}

	function createContext(options?: {
		selectedMode?: string;
		selectResults?: string[];
		editorValue?: string | undefined;
		sessionEntries?: SessionEntry[];
		branchEntries?: SessionEntry[];
		onEditorCall?: (call: EditorCall) => void;
		onSelectCall?: (call: SelectCall) => void;
		onNotify?: (call: NotifyCall) => void;
	}): CustomCommandContext {
		const selectResults = [...(options?.selectResults ?? [])];
		return {
			hasUI: true,
			sessionManager: {
				getEntries: () => options?.sessionEntries ?? [],
				getBranch: () => options?.branchEntries ?? options?.sessionEntries ?? [],
			},
			ui: {
				select: (title: string, selectOptions: string[]) => {
					options?.onSelectCall?.({ title, options: selectOptions });
					return Promise.resolve(
						selectResults.shift() ?? options?.selectedMode ?? "4. Custom review instructions",
					);
				},
				editor: (
					title: string,
					prefill?: string,
					_options?: { signal?: AbortSignal },
					editorOptions?: { promptStyle?: boolean },
				) => {
					options?.onEditorCall?.({ title, prefill, editorOptions });
					return Promise.resolve(options?.editorValue);
				},
				notify: (message: string, type?: "info" | "warning" | "error") => {
					options?.onNotify?.({ message, type });
				},
			},
		} as unknown as CustomCommandContext;
	}

	it("uses prompt-style input for custom review instructions", async () => {
		const dir = await createTempDir();
		let editorCall: EditorCall | undefined;

		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
			onEditorCall: call => {
				editorCall = call;
			},
		});

		const result = await command.execute([], ctx);

		expect(editorCall).toEqual({
			title: "Enter custom review instructions",
			prefill: "Review the following:\n\n",
			editorOptions: { promptStyle: true },
		});
		expect(result).toContain("Check authentication boundaries");
	});

	it("renders custom review instructions through the reviewer task prompt when no diff is available", async () => {
		const dir = await createTempDir();
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("Check authentication boundaries");
	});

	it("does not submit empty custom review instructions", async () => {
		const values = [undefined, "", "   \n\t  "];

		for (const editorValue of values) {
			const dir = await createTempDir();
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({ editorValue });

			const result = await command.execute([], ctx);

			expect(result).toBeUndefined();
			await removeWithRetries(dir);
			tmpDir = undefined;
		}
	});

	it("uses JJ diff for uncommitted review prompts", async () => {
		const dir = await createTempDir();
		const jjRepoSpy = spyOn(jj.repo, "is").mockResolvedValue(true);
		const jjDiffSpy = spyOn(jj, "diff").mockResolvedValue(SAMPLE_JJ_DIFF);
		const gitStatusSpy = spyOn(git, "status").mockResolvedValue(" M src/workspace.ts\n");
		const gitDiffSpy = spyOn(git, "diff").mockResolvedValue("");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("src/workspace.ts");
			expect(promptText).toContain("+1/-1");
			expect(promptText).toContain("MAY read full file context as needed via `read`");
			expect(jjDiffSpy).toHaveBeenCalledWith(dir);
			expect(gitStatusSpy).not.toHaveBeenCalled();
			expect(gitDiffSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitStatusSpy.mockRestore();
			gitDiffSpy.mockRestore();
		}
	});

	it("includes JJ diff context for custom review prompts", async () => {
		const dir = await createTempDir();
		const jjRepoSpy = spyOn(jj.repo, "is").mockResolvedValue(true);
		const jjDiffSpy = spyOn(jj, "diff").mockResolvedValue(SAMPLE_JJ_DIFF);
		const gitStatusSpy = spyOn(git, "status").mockResolvedValue("");
		const gitDiffSpy = spyOn(git, "diff").mockResolvedValue("");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				editorValue: "Check workspace state transitions",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("Check workspace state transitions");
			expect(promptText).toContain("src/workspace.ts");
			expect(gitStatusSpy).not.toHaveBeenCalled();
			expect(gitDiffSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitStatusSpy.mockRestore();
			gitDiffSpy.mockRestore();
		}
	});

	it("parses supported explicit PR URL formats", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;

		const cases = [
			"https://github.com/owner/repo/pull/123",
			"https://github.com/owner/repo/pull/123/",
			"https://github.com/owner/repo/pull/123?tab=files",
			"https://github.com/owner/repo/pull/123#discussion_r123",
			"https://github.com/owner/repo/pull/123/files",
			"https://github.com/owner/repo/pull/123/commits",
			"pr://owner/repo/123/diff/all",
			"pr://owner/repo/123/diff/1",
		];

		for (const url of cases) {
			const result = await command.execute([url], ctx);

			expect(result).toBeDefined();
			expect(result!).toContain("PR owner/repo#123");
			expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
		}
	});

	it("prevents local file reads for PR URL reviews", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("MUST NOT read local workspace files for PR file context");
		expect(result!).toContain("`pr://owner/repo/123/diff/all`");
		expect(result!).toContain("per-file `pr://owner/repo/123/diff/<index>`");
		expect(result!).not.toContain("MAY read full file context as needed via `read`");
	});

	it("uses PR diff URLs for omitted large PR diff instructions", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(makeManyFileDiff(21)));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("MUST read assigned PR file diffs from `pr://owner/repo/123/diff/all`");
		expect(result!).toContain("per-file `pr://owner/repo/123/diff/<index>`");
		expect(result!).toContain("NEVER use local `git diff`/`git show` for PR diff content");
		expect(result!).not.toContain("MUST run `git diff`/`git show` for assigned files");
	});

	it("rejects unsupported PR-like URL formats as normal instructions", async () => {
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;

		const cases = [
			"https://github.com/owner/repo/issues/123",
			"https://github.com/owner/repo/commit/abc123",
			"https://example.com/owner/repo/pull/123",
			"pr://123",
			"https://github.com/owner/repo/pull/0",
			"https://github.com/owner/repo/pull/-1",
			"https://github.com/owner/repo/pull/not-a-number",
		];

		for (const url of cases) {
			const result = await command.execute([url], ctx);

			expect(result).toBeDefined();
			expect(result!).toContain(url);
		}
		expect(diffSpy).not.toHaveBeenCalled();
	});

	it("removes only the first valid PR URL from extra instructions", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;
		const secondUrl = "https://github.com/owner/repo/pull/456";

		const result = await command.execute(["focus", "https://github.com/owner/repo/pull/123", "on", secondUrl], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("focus on https://github.com/owner/repo/pull/456");
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
	});

	it("bypasses the interactive menu for explicit PR URLs", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		let selectCalled = false;
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onSelectCall: () => {
				selectCalled = true;
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123", "focus", "on", "CLI", "UX"], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("focus on CLI UX");
		expect(selectCalled).toBe(false);
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/repo", number: 123 });
	});

	it("notifies and stops when explicit PR diff fetching fails", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockRejectedValue(new Error("authentication required"));
		const notifications: NotifyCall[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onNotify: call => {
				notifications.push(call);
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeUndefined();
		expect(notifications).toEqual([
			{
				message: "Failed to fetch PR diff for owner/repo#123: authentication required",
				type: "error",
			},
		]);
	});

	it("notifies and stops when explicit PR diff content is empty", async () => {
		const dir = await createTempDir();
		spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(" \n"));
		const notifications: NotifyCall[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			onNotify: call => {
				notifications.push(call);
			},
		});

		const result = await command.execute(["https://github.com/owner/repo/pull/123"], ctx);

		expect(result).toBeUndefined();
		expect(notifications).toEqual([
			{
				message: "PR owner/repo#123 has no diff content available",
				type: "warning",
			},
		]);
	});

	it("reviews a detected PR from recent conversation context", async () => {
		const dir = await createTempDir();
		const diffSpy = spyOn(gh, "getOrFetchPrDiff").mockResolvedValue(makePrDiffLookup(SAMPLE_PR_DIFF));
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectedMode: "Review PR owner/example#77 from conversation",
			sessionEntries: [makeUserEntry("u1", "Please review https://github.com/owner/example/pull/77.")],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("PR owner/example#77");
		expect(result!).toContain("src/pr.ts");
		expect(diffSpy).toHaveBeenCalledWith({ cwd: dir, repo: "owner/example", number: 77 });
	});

	it("does not detect PR URLs from entries outside the current branch", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [makeUserEntry("stale", "Stale https://github.com/owner/example/pull/77")],
			branchEntries: [],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).not.toContain("Review PR owner/example#77 from conversation");
	});

	it("detects only PR URLs from the active branch path", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("stale", "Stale https://github.com/owner/example/pull/77"),
				makeUserEntry("active", "Active https://github.com/owner/example/pull/78"),
			],
			branchEntries: [makeUserEntry("active", "Active https://github.com/owner/example/pull/78")],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).toContain("Review PR owner/example#78 from conversation");
		expect(reviewModeOptions).not.toContain("Review PR owner/example#77 from conversation");
	});

	it("deduplicates detected PR menu entries", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("u1", "Review https://github.com/owner/example/pull/77 and pr://owner/example/77/diff/1"),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(
			reviewModeOptions.filter(option => option === "Review PR owner/example#77 from conversation"),
		).toHaveLength(1);
	});

	it("orders detected PR menu entries by most recent mention", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry("u1", "Older https://github.com/owner/example/pull/77"),
				makeUserEntry("u2", "Newer https://github.com/owner/example/pull/78"),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("orders detected PR menu entries by rightmost mention within one message", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			sessionEntries: [
				makeUserEntry(
					"u1",
					"Older https://github.com/owner/example/pull/77 newer https://github.com/owner/example/pull/78",
				),
			],
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions.slice(0, 2)).toEqual([
			"Review PR owner/example#78 from conversation",
			"Review PR owner/example#77 from conversation",
		]);
	});

	it("preserves the existing menu shape when no recent PR is detected", async () => {
		const dir = await createTempDir();
		let reviewModeOptions: string[] = [];
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Review docs",
			onSelectCall: call => {
				if (call.title === "Review Mode") reviewModeOptions = call.options;
			},
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(reviewModeOptions).toEqual([
			"1. Review against a base branch (PR Style)",
			"2. Review uncommitted changes",
			"3. Review a specific commit",
			"4. Custom review instructions",
		]);
	});

	it("keeps base branch review mode working", async () => {
		const dir = await createTempDir();
		spyOn(git.branch, "list").mockResolvedValue(["main"]);
		spyOn(git.branch, "current").mockResolvedValue("feature");
		const diffSpy = spyOn(git, "diff").mockResolvedValue(SAMPLE_PR_DIFF);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectResults: ["1. Review against a base branch (PR Style)", "main"],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("Reviewing changes between `main` and `feature`");
		expect(result!).toContain("src/pr.ts");
		expect(diffSpy).toHaveBeenCalledWith(dir, { base: "main...feature" });
	});

	it("keeps specific commit review mode working", async () => {
		const dir = await createTempDir();
		spyOn(git.log, "onelines").mockResolvedValue(["abc1234 Fix review command"]);
		const showSpy = spyOn(git, "show").mockResolvedValue(SAMPLE_PR_DIFF);
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectResults: ["3. Review a specific commit", "abc1234 Fix review command"],
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		expect(result!).toContain("Reviewing commit `abc1234`");
		expect(result!).toContain("src/pr.ts");
		expect(showSpy).toHaveBeenCalledWith(dir, "abc1234", { format: "" });
	});
	it("parses quoted rename paths and exact old/new line anchors", () => {
		const snapshot = parseReviewDiffSnapshot(`diff --git "a/src/old name.ts" "b/src/new name.ts"
similarity index 80%
rename from "src/old name.ts"
rename to "src/new name.ts"
--- "a/src/old name.ts"
+++ "b/src/new name.ts"
@@ -10,2 +10,3 @@ export function value()
 context
-removed
+added
+second
\\ No newline at end of file`);

		expect(snapshot.files).toHaveLength(1);
		expect(snapshot.files[0]).toEqual(
			expect.objectContaining({
				path: "src/new name.ts",
				oldPath: "src/old name.ts",
				newPath: "src/new name.ts",
				linesAdded: 2,
				linesRemoved: 1,
			}),
		);
		expect(snapshot.files[0]!.rows).toMatchObject([
			{ kind: "hunk", hunkHeader: "@@ -10,2 +10,3 @@ export function value()" },
			{ kind: "context", oldLine: 10, newLine: 10, raw: " context" },
			{ kind: "removed", oldLine: 11, raw: "-removed" },
			{ kind: "added", newLine: 11, raw: "+added" },
			{ kind: "added", newLine: 12, raw: "+second" },
			{ kind: "no-newline", raw: "\\ No newline at end of file" },
		]);
	});

	it("parses unquoted marker paths with spaces through a tab suffix or end of line", () => {
		const snapshot = parseReviewDiffSnapshot(`diff --git a/src/old-name.ts b/src/new-name.ts
--- a/src/old name.ts	2026-08-05 12:00:00
+++ b/src/new name.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/created-name.ts b/src/created-name.ts
new file mode 100644
--- /dev/null
+++ b/src/created name.ts
@@ -0,0 +1 @@
+created`);

		expect(snapshot.files.map(file => ({ path: file.path, oldPath: file.oldPath, newPath: file.newPath }))).toEqual([
			{
				path: "src/new name.ts",
				oldPath: "src/old name.ts",
				newPath: "src/new name.ts",
			},
			{
				path: "src/created name.ts",
				oldPath: undefined,
				newPath: "src/created name.ts",
			},
		]);
	});

	it("applies review exclusions to complete unquoted spaced marker paths", () => {
		const snapshot = parseReviewDiffSnapshot(`diff --git a/config/workspace-lock.json b/config/workspace-lock.json
--- a/config/workspace lockfile.lock
+++ b/config/workspace lockfile.lock	2026-08-05 12:00:00
@@ -1 +1 @@
-old
+new`);

		expect(snapshot.files).toHaveLength(0);
		expect(snapshot.excluded).toEqual([
			{
				path: "config/workspace lockfile.lock",
				reason: "lock file",
				linesAdded: 1,
				linesRemoved: 1,
			},
		]);
	});

	it("keeps duplicate staged and unstaged file diffs independently addressable", () => {
		const fileDiff = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -0,0 +1 @@
+value`;
		const snapshot = parseReviewDiffSnapshot(`${fileDiff}\n${fileDiff}`);

		expect(snapshot.files.map(file => ({ path: file.path, occurrence: file.occurrence }))).toEqual([
			{ path: "src/value.ts", occurrence: 1 },
			{ path: "src/value.ts", occurrence: 2 },
		]);
		expect(snapshot.totalAdded).toBe(2);
	});

	it("renders headless review requests through the reviewer task prompt", async () => {
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as CustomCommandContext;

		const result = await command.execute(["focus", "auth"], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("focus auth");
	});
});
