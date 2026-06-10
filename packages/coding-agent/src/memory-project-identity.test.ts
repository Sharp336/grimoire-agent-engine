import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBankScope } from "./hindsight/bank";
import type { HindsightConfig } from "./hindsight/config";
import { getMemoryRoot } from "./memories";
import { closeMemoryDb, listStage1OutputsForGlobal, openMemoryDb } from "./memories/storage";
import { resolveMemoryProjectIdentity } from "./memory-project-identity";

const baseHindsightConfig: HindsightConfig = {
	hindsightApiUrl: null,
	hindsightApiToken: null,
	bankId: "omp",
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	projectKey: null,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 0,
	retainOverlapTurns: 0,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1000,
	recallTypes: [],
	recallContextTurns: 0,
	recallMaxQueryChars: 1000,
	recallPromptPreamble: "",
	debug: false,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 0,
	mentalModelMaxRenderChars: 0,
};

function withTempRepo<T>(fn: (paths: { root: string; main: string; linked: string; other: string }) => T): T {
	const root = mkdtempSync(join(tmpdir(), "omp-memory-identity-"));
	try {
		const main = join(root, "repo-main");
		const linked = join(root, "repo-feature-worktree");
		const other = join(root, "other-repo");
		const mainGit = join(main, ".git");
		const linkedGitDir = join(mainGit, "worktrees", "repo-feature-worktree");
		mkdirSync(linkedGitDir, { recursive: true });
		mkdirSync(linked, { recursive: true });
		mkdirSync(join(other, ".git"), { recursive: true });
		writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feature\n");
		return fn({ root, main, linked, other });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("memory project identity", () => {
	it("uses an explicit project key across tags, banks, and path segments", () => {
		const identity = resolveMemoryProjectIdentity("/tmp/any-worktree", " github.com/Org/Repo.git ");

		expect(identity.key).toBe("github.com/org/repo");
		expect(identity.segment).toBe("github-com-org-repo");
		expect(identity.source).toBe("explicit");

		const scope = computeBankScope(
			{ ...baseHindsightConfig, projectKey: "github.com/Org/Repo.git" },
			"/tmp/any-worktree",
		);
		expect(scope.bankId).toBe("omp");
		expect(scope.retainTags).toEqual(["project:github.com/org/repo"]);
		expect(scope.recallTags).toEqual(["project:github.com/org/repo"]);
	});

	it("prefers a normalized git remote when one is configured", () => {
		withTempRepo(({ main, linked }) => {
			writeFileSync(join(main, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:Org/Repo.git\n`);

			const mainIdentity = resolveMemoryProjectIdentity(main);
			const linkedIdentity = resolveMemoryProjectIdentity(linked);

			expect(mainIdentity.key).toBe("github.com/org/repo");
			expect(mainIdentity.source).toBe("git-remote");
			expect(linkedIdentity.key).toBe(mainIdentity.key);
			expect(linkedIdentity.segment).toBe("github-com-org-repo");
		});
	});

	it("prefers upstream over fork origin when both remotes exist", () => {
		withTempRepo(({ main, linked }) => {
			writeFileSync(
				join(main, ".git", "config"),
				`[remote "origin"]\n\turl = git@github.com:Fork/Repo.git\n[remote "upstream"]\n\turl = https://github.com/Org/Repo.git\n`,
			);

			const mainIdentity = resolveMemoryProjectIdentity(main);
			const linkedIdentity = resolveMemoryProjectIdentity(linked);

			expect(mainIdentity.key).toBe("github.com/org/repo");
			expect(mainIdentity.source).toBe("git-remote");
			expect(linkedIdentity.key).toBe(mainIdentity.key);
			expect(linkedIdentity.segment).toBe("github-com-org-repo");
		});
	});

	it("derives the same project identity for linked git worktrees", () => {
		withTempRepo(({ main, linked }) => {
			const mainIdentity = resolveMemoryProjectIdentity(main);
			const linkedIdentity = resolveMemoryProjectIdentity(linked);

			expect(mainIdentity.key).toStartWith("local/repo-main/");
			expect(mainIdentity.source).toBe("git-common-dir");
			expect(linkedIdentity.key).toBe(mainIdentity.key);
			expect(linkedIdentity.segment).toBe(mainIdentity.segment);

			expect(getMemoryRoot("/tmp/agent", linked)).toBe(getMemoryRoot("/tmp/agent", main));
		});
	});

	it("consolidates local rollout outputs by repo identity instead of worktree cwd", () => {
		withTempRepo(({ root, main, linked, other }) => {
			const db = openMemoryDb(join(root, "memory.db"));
			try {
				const insertThread = db.prepare(
					"INSERT INTO threads (id, updated_at, rollout_path, cwd, source_kind) VALUES (?, ?, ?, ?, 'cli')",
				);
				insertThread.run("main", 100, join(main, "main.jsonl"), main);
				insertThread.run("linked", 200, join(linked, "linked.jsonl"), linked);
				insertThread.run("other", 300, join(other, "other.jsonl"), other);

				const insertOutput = db.prepare(
					"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, NULL, ?)",
				);
				insertOutput.run("main", 100, "main raw", "main summary", 1000);
				insertOutput.run("linked", 200, "linked raw", "linked summary", 2000);
				insertOutput.run("other", 300, "other raw", "other summary", 3000);

				const threadIds = listStage1OutputsForGlobal(db, 10, linked).map(row => row.threadId);
				expect(threadIds).toEqual(["linked", "main"]);
			} finally {
				closeMemoryDb(db);
			}
		});
	});
});
