import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode shutdown resume command", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mode?.stop();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("copies the persisted session resume command before exiting", async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-shutdown-resume-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		await sessionManager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue(undefined);
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await mode.shutdown();

		expect(copySpy).toHaveBeenCalledWith(`omp --resume ${sessionManager.getSessionId()}`);
	});
});
