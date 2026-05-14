import { afterEach, describe, expect, it, vi } from "bun:test";
import { getRecentSessions, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

	it("seeds chronology with the header branch on creation", () => {
		mockResolvedBranch("main");
		const session = SessionManager.inMemory(TEST_CWD);
		const chronology = session.getGitRefChronology();
		expect(chronology.length).toBe(1);
		expect(chronology[0]!.branch).toBe("main");
		expect(typeof chronology[0]!.at).toBe("string");
		expect(session.getLatestGitRef()).toBe("main");
	});

	it("does not seed gitBranch when HEAD cannot be resolved", () => {
		mockResolvedBranch(null);
		const session = SessionManager.inMemory(TEST_CWD);
		expect(session.getHeader()!.gitBranch).toBeUndefined();
		expect(session.getGitRefChronology().length).toBe(0);
		expect(session.getLatestGitRef()).toBeNull();
		expect(session.getGitRefs()).toEqual([]);
	});

	it("recordGitRef no-ops when branch equals the previous chronology entry", () => {
		mockResolvedBranch("main");
		const session = SessionManager.inMemory(TEST_CWD);

		// Header seed already provides "main" as the previous entry.
		expect(session.getGitRefChronology().length).toBe(1);
		session.recordGitRef("main");
		expect(session.getGitRefChronology().length).toBe(1);

		session.recordGitRef("feature/new");
		session.recordGitRef("feature/new");
		expect(session.getGitRefChronology().length).toBe(2);
	});

	it("recordGitRef preserves order for hotfix-style interruptions (X -> Y -> X)", () => {
		mockResolvedBranch("feat/x");
		const session = SessionManager.inMemory(TEST_CWD);

		session.recordGitRef("hotfix/y");
		session.recordGitRef("feat/x");

		const chronology = session.getGitRefChronology();
		expect(chronology.map(r => r.branch)).toEqual(["feat/x", "hotfix/y", "feat/x"]);
		expect(session.getLatestGitRef()).toBe("feat/x");
		// getGitRefs() compat shim returns unique branches only.
		expect(session.getGitRefs().sort()).toEqual(["feat/x", "hotfix/y"]);
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

	it("list extraction exposes initial, latest, and ordered chronology", async () => {
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
		expect(info.gitBranchInitial).toBe("main");
		expect(info.gitBranchLatest).toBe("feature/listed");
		expect(info.gitRefs).toBeArray();
		expect(info.gitRefs!.map(r => r.branch)).toEqual(["main", "feature/listed"]);
		// Every chronology entry should have a timestamp (from entry-level or header).
		for (const record of info.gitRefs!) {
			expect(typeof record.at).toBe("string");
		}
	});

	it("buildIndex rehydrates chronology in file order on reload", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-reload-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		session.appendMessage({ role: "user", content: "test reload", timestamp: 1 });
		session.recordGitRef("feature/reloaded");
		session.recordGitRef("fix/reloaded");
		session.recordGitRef("feature/reloaded");
		await session.ensureOnDisk();
		await session.flush();

		const sessionFile = session.getSessionFile()!;
		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const chronology = reopened.getGitRefChronology();
		expect(chronology.map(r => r.branch)).toEqual(["main", "feature/reloaded", "fix/reloaded", "feature/reloaded"]);
		expect(reopened.getLatestGitRef()).toBe("feature/reloaded");
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

	it("newSession resets stale chronology and seeds from the new HEAD", async () => {
		vi.spyOn(git.head, "resolveSync")
			.mockReturnValueOnce(makeRefHead("main"))
			.mockReturnValueOnce(makeRefHead("release"));
		const session = SessionManager.inMemory(TEST_CWD);
		session.recordGitRef("stale/branch");
		expect(session.getGitRefChronology().map(r => r.branch)).toEqual(["main", "stale/branch"]);

		await session.newSession();
		const chronology = session.getGitRefChronology();
		expect(chronology.map(r => r.branch)).toEqual(["release"]);
		expect(session.getLatestGitRef()).toBe("release");
		expect(session.getHeader()!.gitBranch).toBe("release");
	});

	it("getRecentSessions populates branchLatest via a bounded tail read past the head window", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-tail-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		// Long padded message pushes any subsequent entry past the 4 KiB head window
		// used by getSortedSessions / RecentSessionInfo.
		session.appendMessage({ role: "user", content: "x".repeat(8192), timestamp: 1 });
		session.recordGitRef("feature/tail");
		await session.ensureOnDisk();
		await session.flush();

		const recent = await getRecentSessions(sessionDir);
		expect(recent.length).toBe(1);
		const info = recent[0]!;
		expect(info.branchInitial).toBe("main");
		expect(info.branchLatest).toBe("feature/tail");
	});

	it("getRecentSessions falls back to initial when no runtime ref was recorded", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-tail-noop-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		session.appendMessage({ role: "user", content: "just a message", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();

		const recent = await getRecentSessions(sessionDir);
		expect(recent.length).toBe(1);
		expect(recent[0]!.branchInitial).toBe("main");
		expect(recent[0]!.branchLatest).toBe("main");
	});

	it("SessionManager.list captures git_ref entries past the 4 KiB head window", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-list-past-head-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		// Bury the switch deep in the file: enough padding to clear the 4 KiB head
		// window used by the prefix scan and the 4 KiB tail window used by the old
		// tail-only reader, while still leaving plenty of room between.
		session.appendMessage({ role: "user", content: "x".repeat(8192), timestamp: 1 });
		session.recordGitRef("feature/buried");
		session.appendMessage({ role: "user", content: "y".repeat(8192), timestamp: 2 });
		await session.ensureOnDisk();
		await session.flush();

		const sessions = await SessionManager.list(TEST_CWD, sessionDir);
		expect(sessions.length).toBe(1);
		const info = sessions[0]!;
		expect(info.gitBranchInitial).toBe("main");
		expect(info.gitBranchLatest).toBe("feature/buried");
		expect(info.gitRefs!.map(r => r.branch)).toEqual(["main", "feature/buried"]);
	});

	it("getRecentSessions finds branch switches even when both head and tail windows would miss them", async () => {
		mockResolvedBranch("main");
		using tempDir = TempDir.createSync("@pi-git-ref-recent-past-tail-");
		const sessionDir = tempDir.path();

		const session = SessionManager.create(TEST_CWD, sessionDir);
		// Symmetric padding so the git_ref sits in the middle of the file, beyond
		// both the 4 KiB head and the 4 KiB tail.
		session.appendMessage({ role: "user", content: "x".repeat(8192), timestamp: 1 });
		session.recordGitRef("feature/middle");
		session.appendMessage({ role: "user", content: "y".repeat(8192), timestamp: 2 });
		await session.ensureOnDisk();
		await session.flush();

		const recent = await getRecentSessions(sessionDir);
		expect(recent.length).toBe(1);
		expect(recent[0]!.branchInitial).toBe("main");
		expect(recent[0]!.branchLatest).toBe("feature/middle");
	});
});
