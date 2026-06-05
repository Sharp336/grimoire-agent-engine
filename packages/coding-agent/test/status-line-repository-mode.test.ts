import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import * as git from "../src/utils/git";
import * as jj from "../src/utils/jj";

const originalProjectDir = getProjectDir();
const components: StatusLineComponent[] = [];

function makeSession(): AgentSession {
	return {
		messages: [],
		state: { messages: [] },
		isStreaming: false,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "test-model", contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
	} as unknown as AgentSession;
}

async function flushBackgroundWork(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function createComponent(): StatusLineComponent {
	const component = new StatusLineComponent(makeSession());
	components.push(component);
	return component;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(async () => {
	for (const component of components.splice(0)) {
		component.dispose();
	}
	await flushBackgroundWork();
	vi.restoreAllMocks();
	settings.set("repository.mode", "auto");
	setProjectDir(originalProjectDir);
	jj.repo.clearRootCache();
});

describe("StatusLineComponent repository-aware git segment", () => {
	it("preserves Git branch and status lookup on the first forced-git render", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-git-first-"));
		setProjectDir(cwd);
		settings.set("repository.mode", "git");
		const gitHead = spyOn(git.head, "resolveSync").mockReturnValue({
			branchName: "feature/git-first-render",
			commit: "abc123",
			commonDir: `${cwd}/.git`,
			gitDir: `${cwd}/.git`,
			gitEntryPath: `${cwd}/.git`,
			headContent: "ref: refs/heads/feature/git-first-render",
			headPath: `${cwd}/.git/HEAD`,
			kind: "ref",
			ref: "refs/heads/feature/git-first-render",
			repoRoot: cwd,
		});
		const gitStatus = spyOn(git.status, "summary").mockResolvedValue({ staged: 1, unstaged: 2, untracked: 3 });

		const component = createComponent();
		component.updateSettings({
			preset: "custom",
			leftSegments: ["git"],
			rightSegments: [],
			separator: "none",
		});

		const rendered = component.getTopBorder(80).content;

		expect(gitHead).toHaveBeenCalledWith(cwd);
		expect(gitStatus).toHaveBeenCalledWith(cwd);
		expect(rendered).toContain("feature/git-first-render");
	});

	it("uses jj status and skips Git-only lookups in pure jj mode", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-jj-"));
		setProjectDir(cwd);
		settings.set("repository.mode", "jj");
		spyOn(jj.repo, "resolve").mockResolvedValue({
			repoRoot: cwd,
			storeDir: `${cwd}/.jj/repo/store`,
		});
		spyOn(git.repo, "resolve").mockResolvedValue(null);
		const jjStatus = spyOn(jj.status, "summary").mockResolvedValue({ staged: 0, unstaged: 2, untracked: 0 });
		const gitStatus = spyOn(git.status, "summary").mockResolvedValue({ staged: 7, unstaged: 7, untracked: 7 });
		const gitHead = spyOn(git.head, "resolveSync").mockReturnValue(null);
		const defaultBranch = spyOn(git.branch, "default").mockResolvedValue("main");

		const component = createComponent();
		component.updateSettings({
			preset: "custom",
			leftSegments: ["git"],
			rightSegments: [],
			separator: "none",
		});

		component.getTopBorder(80);
		await flushBackgroundWork();
		component.getTopBorder(80);
		await flushBackgroundWork();
		const rendered = component.getTopBorder(80).content;

		expect(jjStatus).toHaveBeenCalledWith(cwd);
		expect(gitStatus).not.toHaveBeenCalled();
		expect(gitHead).not.toHaveBeenCalled();
		expect(defaultBranch).not.toHaveBeenCalled();
		expect(rendered).toContain("jj");
		expect(rendered).toContain("*2");
		expect(rendered).not.toContain("*7");
	});

	it("does not watch Git HEAD when repository mode is forced to jj", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-jj-watch-"));
		setProjectDir(cwd);
		settings.set("repository.mode", "jj");
		const gitRepoResolve = spyOn(git.repo, "resolveSync").mockReturnValue({
			commonDir: `${cwd}/.git`,
			gitDir: `${cwd}/.git`,
			gitEntryPath: `${cwd}/.git`,
			headPath: `${cwd}/.git/HEAD`,
			repoRoot: cwd,
		});

		const component = createComponent();
		component.watchBranch(() => {});
		component.dispose();

		expect(gitRepoResolve).not.toHaveBeenCalled();
	});
});
