import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { $ } from "bun";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

/** Minimal SegmentContext factory — only the fields the git segment reads. */
function createContext(overrides?: {
	branch?: string | null;
	remote?: { ahead: number; behind: number } | null;
	showRemote?: boolean;
	dirty?: boolean;
}): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {
			git: overrides?.showRemote === undefined ? {} : { showRemote: overrides.showRemote },
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: {
			branch: overrides?.branch ?? null,
			status: overrides?.dirty ? { staged: 0, unstaged: 1, untracked: 0 } : null,
			remote: overrides?.remote ?? null,
			pr: null,
		},
		usage: null,
	};
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

describe("status line git segment: upstream divergence markers", () => {
	it("appends an ahead marker after the branch when only ahead", () => {
		const rendered = renderSegment("git", createContext({ branch: "main", remote: { ahead: 2, behind: 0 } }));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.branch, "main ↑2"));
	});

	it("appends a behind marker when only behind", () => {
		const rendered = renderSegment("git", createContext({ branch: "main", remote: { ahead: 0, behind: 3 } }));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.branch, "main ↓3"));
	});

	it("shows both markers when diverged, positioned before the dirty counts", () => {
		const rendered = renderSegment(
			"git",
			createContext({ branch: "main", remote: { ahead: 2, behind: 1 }, dirty: true }),
		);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.branch, "main ↑2 ↓1 *1"));
	});

	it("adds nothing for an in-sync branch (remote null)", () => {
		const rendered = renderSegment("git", createContext({ branch: "main", remote: null }));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.branch, "main"));
	});

	it("is hidden by git.showRemote: false", () => {
		const rendered = renderSegment(
			"git",
			createContext({ branch: "main", remote: { ahead: 5, behind: 0 }, showRemote: false }),
		);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.branch, "main"));
	});

	it("renders markers alone when the branch label is hidden", () => {
		const ctx = createContext({ remote: { ahead: 4, behind: 2 } });
		ctx.options = { git: { showBranch: false } };
		const rendered = renderSegment("git", ctx);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.git, "↑4 ↓2"));
	});

	it("combines markers and dirty counts under a git icon when the branch label is hidden", () => {
		const ctx = createContext({ remote: { ahead: 4, behind: 0 }, dirty: true });
		ctx.options = { git: { showBranch: false } };
		const rendered = renderSegment("git", ctx);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.git, "↑4 *1"));
	});
});

describe("git.status.divergence against a real repository", () => {
	it("reports ahead / behind / in-sync /.upstream-less", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-statusline-remote-"));
		const origin = path.join(dir, "origin.git");
		const work1 = path.join(dir, "work1");
		const work2 = path.join(dir, "work2");
		try {
			await $`git init --bare --initial-branch=main origin.git`.cwd(dir).quiet();
			await $`git init --initial-branch=main work1`.cwd(dir).quiet();
			await $`git config user.email tester@example.com`.cwd(work1).quiet();
			await $`git config user.name Tester`.cwd(work1).quiet();
			await $`git config commit.gpgsign false`.cwd(work1).quiet();
			await $`git remote add origin ${origin}`.cwd(work1).quiet();
			const commit = async (msg: string) => {
				await $`git add -A`.cwd(work1).quiet();
				await $`git commit -qm ${msg}`.cwd(work1).quiet();
			};

			// Baseline: one commit pushed with an upstream set -> in sync -> null.
			await fs.writeFile(path.join(work1, "a.txt"), "a");
			await commit("base");
			await $`git push -q -u origin HEAD:main`.cwd(work1).quiet();
			expect(await git.status.divergence(work1)).toBeNull();

			// Two unpushed local commits -> ahead.
			await fs.writeFile(path.join(work1, "b.txt"), "b");
			await commit("one");
			await fs.writeFile(path.join(work1, "c.txt"), "c");
			await commit("two");
			expect(await git.status.divergence(work1)).toEqual({ ahead: 2, behind: 0 });

			// A remote-only commit (pushed from a sibling clone) -> diverged.
			await $`git clone -q origin.git work2`.cwd(dir).quiet();
			await $`git config user.email tester2@example.com`.cwd(work2).quiet();
			await $`git config user.name Tester2`.cwd(work2).quiet();
			await $`git config commit.gpgsign false`.cwd(work2).quiet();
			await fs.writeFile(path.join(work2, "d.txt"), "d");
			await $`git add -A`.cwd(work2).quiet();
			await $`git commit -qm remote`.cwd(work2).quiet();
			await $`git push -q origin HEAD:main`.cwd(work2).quiet();
			await $`git fetch -q origin`.cwd(work1).quiet();
			expect(await git.status.divergence(work1)).toEqual({ ahead: 2, behind: 1 });

			// A branch without any upstream -> nothing to compare -> null.
			await $`git checkout -q -b feature`.cwd(work1).quiet();
			expect(await git.status.divergence(work1)).toBeNull();

			// Detached HEAD (@{upstream} has no meaning) -> null.
			await $`git checkout -q --detach`.cwd(work1).quiet();
			expect(await git.status.divergence(work1)).toBeNull();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
