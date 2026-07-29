/**
 * Regression: StatusLineComponent's VCS segment was blank on the first (cold)
 * paint and only appeared after an unrelated re-render (e.g. flipping a
 * statusline setting and back). The async git-status and jj-label fetches
 * filled their caches but never called #onBranchChange, so the resolved value
 * had no way to reach the screen until something else forced a repaint. Worst
 * in a jj workspace, where there is no git branch so the PR / default-branch
 * lookups (which do fire #onBranchChange) never run.
 *
 * Contract: when an async VCS fetch resolves with a value, the component
 * requests a repaint via #onBranchChange. (Post-dispose suppression of the
 * same callback is covered by status-line-dispose-async-leak.test.ts.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { GitHeadState, GitRefHead, GitRepository } from "@oh-my-pi/pi-coding-agent/utils/git";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

type GitStatus = { staged: number; unstaged: number; untracked: number };

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "vcs-refresh test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const fakeRefHead: GitRefHead = {
	kind: "ref",
	branchName: "main",
	ref: "refs/heads/main",
	commit: null,
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	headContent: "ref: refs/heads/main\n",
};

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent repaints when an async VCS fetch resolves", () => {
	it("fires #onBranchChange when git status resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(fakeRefHead);
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		const status = Promise.withResolvers<GitStatus | null>();
		vi.spyOn(git.status, "summary").mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the git-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 1, unstaged: 2, untracked: 3 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when the jj label resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(null); // no git branch -> jj overlay
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise); // isolate the jj fire
		vi.spyOn(jj.repo, "rootSync").mockReturnValue("/fake/jj/root");
		const label = Promise.withResolvers<string | null>();
		vi.spyOn(jj.workingCopy, "label").mockReturnValue(label.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-label fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		label.resolve("feature-x");
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when jj status resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(null); // no git -> jj repo
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue("/fake/jj/root");
		vi.spyOn(jj.workingCopy, "label").mockReturnValue(Promise.withResolvers<string | null>().promise); // isolate the status fire
		const status = Promise.withResolvers<GitStatus | null>();
		vi.spyOn(jj.status, "summary").mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 0, unstaged: 4, untracked: 1 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});
});
describe("StatusLineComponent reftable branch resolve honors mid-flight invalidation", () => {
	it("discards a stale resolve invalidated mid-flight, keeps the fresh one", async () => {
		// Force the reftable async-resolve path: #getCurrentBranch only spawns
		// git.head.resolve when the repo resolves as reftable.
		const fakeRepo = {
			commonDir: "/fake/.git",
			gitDir: "/fake/.git",
			gitEntryPath: "/fake/.git",
			headPath: "/fake/.git/HEAD",
			repoRoot: "/fake",
		} as GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		// Keep the sibling async fetches quiet so only the branch resolve drives
		// #onBranchChange: git.status stays in flight forever, jj is no repo here.
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);

		const refHead = (branchName: string): GitRefHead => ({
			...fakeRefHead,
			branchName,
			ref: `refs/heads/${branchName}`,
		});

		// Two controllable resolves: the stale one (R1) then the fresh one (R2).
		const r1 = Promise.withResolvers<GitHeadState | null>();
		const r2 = Promise.withResolvers<GitHeadState | null>();
		const resolveSpy = vi.spyOn(git.head, "resolve");
		resolveSpy.mockReturnValueOnce(r1.promise);
		resolveSpy.mockReturnValueOnce(r2.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		// Cold paint kicks the stale resolve (R1).
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		// A HEAD move fires the watcher: invalidate bumps the generation and
		// releases the in-flight slot.
		component.invalidate();

		// The repaint starts a fresh resolve (R2) for the same cwd.
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(2);

		// R1 (stale) lands first. Pre-fix it passed the in-flight-cwd guard
		// (R2 had re-set the slot), installed the stale branch, cleared the
		// marker, and caused R2 to be discarded — freezing the status line on
		// the pre-change branch.
		r1.resolve(refHead("stale-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).not.toHaveBeenCalled();

		// R2 (fresh) lands and commits.
		r2.resolve(refHead("fresh-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).toHaveBeenCalledTimes(1);

		// The committed value is the fresh branch, served from cache with no new
		// resolve, and the stale name never reaches the rendered segment.
		expect(git.head.resolve).toHaveBeenCalledTimes(2);
		const border = component.getTopBorder(80);
		expect(border.content).toContain("fresh-branch");
		expect(border.content).not.toContain("stale-branch");
		expect(git.head.resolve).toHaveBeenCalledTimes(2);

		component.dispose();
	});
});
