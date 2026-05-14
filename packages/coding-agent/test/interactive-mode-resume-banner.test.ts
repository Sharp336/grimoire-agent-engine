import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { GitRefHead } from "../src/utils/git";
import * as git from "../src/utils/git";

function makeRefHead(branchName: string): GitRefHead {
	return {
		branchName,
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		commonDir: "/repo/.git",
		gitDir: "/repo/.git",
		gitEntryPath: "/repo/.git",
		headContent: `ref: refs/heads/${branchName}\n`,
		headPath: "/repo/.git/HEAD",
		kind: "ref",
		repoRoot: "/repo",
		ref: `refs/heads/${branchName}`,
	};
}

function renderUi(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.ui.render(120).join("\n"));
}

function findBranchHistoryLine(mode: InteractiveMode): string {
	return (
		renderUi(mode)
			.split("\n")
			.find(line => line.includes("Branch history:")) ?? ""
	);
}

describe("InteractiveMode resume banner", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-resume-banner-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("renders a branch history banner when chronology spans multiple branches", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("main"));
		session.sessionManager.recordGitRef("feat/x");

		await mode.init();

		const branchHistoryLine = findBranchHistoryLine(mode);
		expect(branchHistoryLine).toContain("Branch history:");
		expect(branchHistoryLine).toContain("feat/x");
		expect(branchHistoryLine).toContain("main (current)");
	});

	it("suppresses the branch history banner when chronology has a single branch", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("main"));

		await mode.init();

		expect(findBranchHistoryLine(mode)).toBe("");
		expect(session.sessionManager.getGitRefChronology().map(record => record.branch)).toEqual(["main"]);
	});

	it("suppresses the branch history banner when startup quiet is enabled", async () => {
		settings.set("startup.quiet", true);
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("main"));
		session.sessionManager.recordGitRef("feat/x");

		await mode.init();

		expect(findBranchHistoryLine(mode)).toBe("");
		expect(session.sessionManager.getGitRefChronology().map(record => record.branch)).toEqual(["feat/x", "main"]);
	});

	it("records the resumed branch before rendering the banner", async () => {
		session.sessionManager.recordGitRef("main");
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("feat/x"));

		await mode.init();

		expect(session.sessionManager.getGitRefChronology().map(record => record.branch)).toEqual(["main", "feat/x"]);
		const branchHistoryLine = findBranchHistoryLine(mode);
		expect(branchHistoryLine).toContain("Branch history:");
		expect(branchHistoryLine).toContain("main");
		expect(branchHistoryLine).toContain("feat/x (current)");
	});
});
