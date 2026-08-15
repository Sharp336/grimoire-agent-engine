import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSplitCommits,
	type QuickCommitPlan,
	resolveQuickCommitBranch,
	resolveQuickCommitCwd,
	validateQuickCommitPlan,
} from "@oh-my-pi/pi-coding-agent/commit/quick";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

let repoDir: string;

beforeEach(async () => {
	repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-quick-commit-"));
	await git.repo.init(repoDir, { initialBranch: "main" });
	await git.config.set(repoDir, "user.email", "tester@example.com");
	await git.config.set(repoDir, "user.name", "Tester");
	await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");
	await git.stage.files(repoDir);
	await git.commit(repoDir, "baseline");
});

afterEach(async () => {
	await fs.rm(repoDir, { recursive: true, force: true });
});

describe("quick commit split execution", () => {
	it("creates whole-file commits from one staged snapshot", async () => {
		await Bun.write(path.join(repoDir, "feature.ts"), "export const enabled = true;\n");
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature flag\n\n- Add the feature flag implementation.",
					body: "- Add the feature flag implementation.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document feature flag\n\n- Document how to enable the feature flag.",
					body: "- Document how to enable the feature flag.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		expect(await git.log.subjects(repoDir, 2)).toEqual(["docs: document feature flag", "feat: add feature flag"]);
		expect((await git.commitDetails(repoDir, "HEAD")).message).toContain(
			"- Document how to enable the feature flag.",
		);
		expect(await git.status(repoDir)).toBe("");
	});

	it("commits only the staged snapshot when a split file also has unstaged hunks", async () => {
		await Bun.write(path.join(repoDir, "tracked.txt"), "one\n");
		await git.stage.files(repoDir);
		await git.commit(repoDir, "chore: seed tracked file");

		await Bun.write(path.join(repoDir, "tracked.txt"), "one\ntwo\n");
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);
		// Left unstaged on purpose: the split executor must not fold this in.
		await Bun.write(path.join(repoDir, "tracked.txt"), "one\ntwo\nthree\n");

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["tracked.txt"],
					message: "feat: extend tracked file\n\n- Add the staged line.",
					body: "- Add the staged line.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document the feature\n\n- Document the feature.",
					body: "- Document the feature.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		expect(await git.log.subjects(repoDir, 2)).toEqual(["docs: document the feature", "feat: extend tracked file"]);
		// Everything committed matches the staged snapshot, so the only remaining
		// difference between HEAD and the working tree is the never-staged hunk.
		const residual = await git.diff(repoDir);
		expect(residual).toContain("+three");
		expect(residual).not.toContain("+two");
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual([]);
	});

	it("preserves a staged rename across split commits", async () => {
		await Bun.write(path.join(repoDir, "old.txt"), "alpha\nbeta\ngamma\n");
		await git.stage.files(repoDir);
		await git.commit(repoDir, "chore: seed renamed file");

		await fs.rename(path.join(repoDir, "old.txt"), path.join(repoDir, "new.txt"));
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual(["docs.md", "new.txt"]);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["new.txt"],
					message: "refactor: rename the file\n\n- Rename old.txt to new.txt.",
					body: "- Rename old.txt to new.txt.",
					branchType: "refactor",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document the rename\n\n- Document the rename.",
					body: "- Document the rename.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		const tracked = await git.ls.tree(repoDir, "HEAD");
		expect(tracked).toContain("new.txt");
		expect(tracked).not.toContain("old.txt");
		expect(await git.status(repoDir)).toBe("");
	});
	it("stages and commits a non-ASCII filename across split commits", async () => {
		// Git C-quotes any path with non-ASCII bytes in both `--name-only`
		// listings and `diff --git a/... b/...` headers unless
		// core.quotepath=false; the header parser used to key diffs by the
		// literal `a/`/`b/` prefix and silently dropped the quoted section.
		await Bun.write(path.join(repoDir, "café.txt"), "bonjour\n");
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual(["café.txt", "docs.md"]);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["café.txt"],
					message: "feat: add café greeting\n\n- Add the greeting file.",
					body: "- Add the greeting file.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document the feature\n\n- Document the feature.",
					body: "- Document the feature.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		expect(await git.log.subjects(repoDir, 2)).toEqual(["docs: document the feature", "feat: add café greeting"]);
		expect(await git.ls.tree(repoDir, "HEAD")).toContain("café.txt");
		expect(await git.status(repoDir)).toBe("");
	});

	it("restores the staged snapshot for commits that haven't landed when a later group fails", async () => {
		await fs.mkdir(path.join(repoDir, ".git", "hooks"), { recursive: true });
		// Reject any commit that stages `blocked.txt`, simulating a pre-commit
		// hook or signing failure partway through a multi-commit split.
		await Bun.write(
			path.join(repoDir, ".git", "hooks", "pre-commit"),
			"#!/bin/sh\ngit diff --cached --name-only | grep -q blocked.txt && exit 1\nexit 0\n",
		);
		await fs.chmod(path.join(repoDir, ".git", "hooks", "pre-commit"), 0o755);

		await Bun.write(path.join(repoDir, "ok.txt"), "fine\n");
		await Bun.write(path.join(repoDir, "blocked.txt"), "nope\n");
		await Bun.write(path.join(repoDir, "later.txt"), "later\n");
		await git.stage.files(repoDir);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["ok.txt"],
					message: "feat: add ok file\n\n- Add ok.txt.",
					body: "- Add ok.txt.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["blocked.txt"],
					message: "feat: add blocked file\n\n- Add blocked.txt.",
					body: "- Add blocked.txt.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["later.txt"],
					message: "feat: add later file\n\n- Add later.txt.",
					body: "- Add later.txt.",
					branchType: "feat",
					branchScope: null,
				},
			],
		};

		await expect(createSplitCommits(repoDir, plan)).rejects.toThrow();

		// The first group committed successfully; the failed group and every
		// group after it must be restaged (not left invisible in the working
		// tree) so a retry sees the original staged snapshot.
		expect(await git.log.subjects(repoDir, 1)).toEqual(["feat: add ok file"]);
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual(["blocked.txt", "later.txt"]);
	});
	it("decodes a forced-quoted diff header (embedded tab alongside Unicode text)", () => {
		// core.quotepath=false only suppresses quoting for non-ASCII bytes; a
		// literal tab still forces Git to C-quote the whole header. This must
		// decode the mixed run correctly, not reinterpret the already-decoded
		// Unicode character as a single raw byte.
		const rawDiff = [
			'diff --git "a/café\\tmixed.txt" "b/café\\tmixed.txt"',
			"new file mode 100644",
			"index 0000000..1234567",
			"--- /dev/null",
			'+++ "b/café\\tmixed.txt"',
			"@@ -0,0 +1 @@",
			"+hello",
			"",
		].join("\n");

		expect(git.diff.parseFiles(rawDiff)[0]?.filename).toBe("café\tmixed.txt");
	});

	it("decodes a diff header quoted purely by octal-escaped non-ASCII bytes", () => {
		const rawDiff = [
			'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
			"new file mode 100644",
			"index 0000000..1234567",
			"--- /dev/null",
			'+++ "b/caf\\303\\251.txt"',
			"@@ -0,0 +1 @@",
			"+hello",
			"",
		].join("\n");

		expect(git.diff.parseFiles(rawDiff)[0]?.filename).toBe("café.txt");
	});

	it("rejects a nonconventional subject whose body contains a conventional line", () => {
		const buriedPrefix: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "release the thing\n\nfeat: buried in body",
					body: "feat: buried in body",
					branchType: "feat",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(buriedPrefix, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit message is not conventional: release the thing",
		);
		expect(() => validateQuickCommitPlan(buriedPrefix, ["feature.ts"], "auto", "freeform")).not.toThrow();
	});
	it("accepts a conventional subject with a comma-separated multi-package scope", () => {
		const multiScope: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat(catalog,ai): add SiliconFlow providers\n\n- Add dynamic-only discovery.",
					body: "- Add dynamic-only discovery.",
					branchType: "feat",
					branchScope: "catalog,ai",
				},
			],
		};
		expect(() => validateQuickCommitPlan(multiScope, ["feature.ts"], "auto", "conventional")).not.toThrow();
	});

	it("rejects plans that duplicate or omit staged files before execution", () => {
		const duplicate: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["feature.ts"],
					message: "docs: document feature\n\n- Document the feature.",
					body: "- Document the feature.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(duplicate, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit planner assigned a file to multiple commits: feature.ts",
		);
		expect(() => validateQuickCommitPlan(duplicate, ["feature.ts"], "off", "conventional")).toThrow(
			"Commit planner returned multiple commits while split commits are disabled.",
		);

		const omitted: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(omitted, ["feature.ts", "docs.md"], "auto", "conventional")).toThrow(
			"Commit planner omitted staged file: docs.md",
		);

		const bodyless: QuickCommitPlan = {
			commits: [
				{ files: ["feature.ts"], message: "feat: add feature", body: "", branchType: "feat", branchScope: null },
			],
		};
		expect(() => validateQuickCommitPlan(bodyless, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit planner returned an empty commit body.",
		);
	});
});

describe("quick commit repository resolution", () => {
	it("uses the repository root when invoked from a nested directory", async () => {
		const nestedDir = path.join(repoDir, "packages", "coding-agent", "src");
		await fs.mkdir(nestedDir, { recursive: true });

		expect(await resolveQuickCommitCwd(nestedDir)).toBe(repoDir);
	});
	it("returns no history for a freshly initialized repo instead of throwing", async () => {
		const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-quick-commit-fresh-"));
		try {
			await git.repo.init(freshDir, { initialBranch: "main" });
			expect(await git.log.subjects(freshDir, 8)).toEqual([]);
		} finally {
			await fs.rm(freshDir, { recursive: true, force: true });
		}
	});
});

describe("quick commit command", () => {
	it("registers commit in the in-session command list", async () => {
		const result = await loadCustomCommands({ cwd: repoDir, agentDir: path.join(repoDir, ".omp") });

		expect(result.commands.some(command => command.command.name === "commit")).toBe(true);
	});
});

describe("quick commit protected branch choices", () => {
	it("asks to use an existing feature branch instead of failing before selection", async () => {
		await git.branch.create(repoDir, "feat/add-feature");
		const settings = Settings.isolated({ "commit.mainBranchProtection": "ask" });
		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
			],
		};

		const selected = await resolveQuickCommitBranch(
			repoDir,
			{
				hasUI: true,
				ui: {
					select: async (_title, options) => {
						expect(options).toEqual(["Use existing feat/add-feature", "Commit on main"]);
						return options[0];
					},
				},
			},
			settings,
			"main",
			"main",
			plan,
		);

		expect(selected).toEqual({ name: "feat/add-feature", action: "checkout" });
	});
});

describe("quick commit settings", () => {
	it("defaults to protected, adaptive conventional commits", () => {
		const settings = Settings.isolated();

		expect(settings.get("commit.mainBranchProtection")).toBe("ask");
		expect(settings.get("commit.splitMode")).toBe("auto");
		expect(settings.get("commit.messageFormat")).toBe("conventional");
		expect(settings.get("commit.branchNameTemplate")).toBe("{type}/{slug}");
	});
});
