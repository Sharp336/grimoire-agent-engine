import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

describe("InteractiveMode git ref tracking", () => {
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
		tempDir = TempDir.createSync("@pi-interactive-mode-git-ref-");
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

	it("records the current branch during init before any branch change event", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(makeRefHead("resume-branch"));
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const recordGitRefSpy = vi.spyOn(session.sessionManager, "recordGitRef");

		await mode.init();

		expect(recordGitRefSpy).toHaveBeenCalledTimes(1);
		expect(recordGitRefSpy).toHaveBeenCalledWith("resume-branch");
	});
});
