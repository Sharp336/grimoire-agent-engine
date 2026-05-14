import { afterEach, describe, expect, it, vi } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { GitRefHead } from "../../src/utils/git";
import * as git from "../../src/utils/git";

const TEST_CWD = "/repo";

function makeRefHead(branchName: string): GitRefHead {
	return {
		branchName,
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		commonDir: `${TEST_CWD}/.git`,
		gitDir: `${TEST_CWD}/.git`,
		gitEntryPath: `${TEST_CWD}/.git`,
		headContent: `ref: refs/heads/${branchName}\n`,
		headPath: `${TEST_CWD}/.git/HEAD`,
		kind: "ref",
		repoRoot: TEST_CWD,
		ref: `refs/heads/${branchName}`,
	};
}

function mockResolvedBranch(branchName: string | null): void {
	vi.spyOn(git.head, "resolveSync").mockReturnValue(branchName ? makeRefHead(branchName) : null);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Git branch tracking in sessions", () => {
	it("captures gitBranch in session header when HEAD resolves to a branch", () => {
		mockResolvedBranch("main");
		const session = SessionManager.inMemory(TEST_CWD);
		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.gitBranch).toBe("main");
	});

	it("does not set gitBranch when HEAD cannot be resolved", () => {
		mockResolvedBranch(null);
		const session = SessionManager.inMemory(TEST_CWD);
		const header = session.getHeader();
		expect(header!.gitBranch).toBeUndefined();
		expect(session.getGitRefs()).toEqual([]);
	});

	it("recordGitRef deduplicates and getGitRefs returns all unique branches", () => {
		mockResolvedBranch("main");
		const session = SessionManager.inMemory(TEST_CWD);

		// Header branch is already tracked
		expect(session.getGitRefs()).toContain("main");

		// Recording a new branch
		session.recordGitRef("feature/new");
		expect(session.getGitRefs()).toContain("feature/new");

		// Recording the same branch again should not duplicate
		const countBefore = session.getGitRefs().length;
		session.recordGitRef("feature/new");
		expect(session.getGitRefs().length).toBe(countBefore);

		// Recording another branch
		session.recordGitRef("fix/hotfix");
		expect(session.getGitRefs()).toContain("fix/hotfix");
		expect(session.getGitRefs().length).toBe(countBefore + 1);
	});

	it("recordGitRef appends a custom entry to the session", () => {
		mockResolvedBranch("main");
		const session = SessionManager.inMemory(TEST_CWD);

		session.recordGitRef("feature/tracked");
		const entries = session.getEntries();
		const gitRefEntry = entries.find(
			e => e.type === "custom" && e.customType === "git_ref" && e.data === "feature/tracked",
		);
		expect(gitRefEntry).toBeDefined();
	});

	it("list extraction includes both header gitBranch and runtime gitRefs", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-list-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.recordGitRef("feature/listed");
		await session.ensureOnDisk();
		await session.flush();

		const sessions = await SessionManager.list(TEST_CWD, sessionDir);
		expect(sessions.length).toBe(1);

		const info = sessions[0]!;
		expect(info.gitBranch).toBe("main");
		expect(info.gitRefs).toBeArray();
		expect(info.gitRefs).toContain("main");
		expect(info.gitRefs).toContain("feature/listed");
	});

	it("buildIndex seeds gitRefs on reload from file", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-reload-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		session.appendMessage({ role: "user", content: "test reload", timestamp: 1 });
		session.recordGitRef("feature/reloaded");
		session.recordGitRef("fix/reloaded");
		await session.ensureOnDisk();
		await session.flush();

		const sessionFile = session.getSessionFile()!;

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const refs = reopened.getGitRefs();
		expect(refs).toContain("main");
		expect(refs).toContain("feature/reloaded");
		expect(refs).toContain("fix/reloaded");
	});

	it("fork preserves gitBranch in new header", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-fork-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		session.appendMessage({ role: "user", content: "before fork", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();

		expect(session.getHeader()!.gitBranch).toBe("main");
		await session.fork();
		expect(session.getHeader()!.gitBranch).toBe("main");
	});

	it("newSession resets stale refs and recaptures the latest branch", async () => {
		vi.spyOn(git.head, "resolveSync")
			.mockReturnValueOnce(makeRefHead("main"))
			.mockReturnValueOnce(makeRefHead("release"));
		const session = SessionManager.inMemory(TEST_CWD);
		session.recordGitRef("stale/branch");
		expect(session.getGitRefs()).toContain("stale/branch");

		await session.newSession();
		expect(session.getGitRefs()).toContain("release");
		expect(session.getGitRefs()).not.toContain("stale/branch");
		expect(session.getHeader()!.gitBranch).toBe("release");
	});
});
