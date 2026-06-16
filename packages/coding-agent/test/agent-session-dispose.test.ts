import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanup.length > 0) {
		const run = cleanup.pop();
		if (run) await run();
	}
});

describe("AgentSession.dispose", () => {
	it("keeps owned auth storage open until memory teardown finishes", async () => {
		const tempDir = TempDir.createSync("@pi-agent-session-dispose-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const agent = new Agent({
			initialState: {
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			ownedModelRegistry: modelRegistry,
			ownedAuthStorage: authStorage,
		});
		let disposed = false;
		cleanup.push(async () => {
			if (!disposed) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		const order: string[] = [];
		const originalRegistryDispose = modelRegistry.dispose.bind(modelRegistry);
		vi.spyOn(modelRegistry, "dispose").mockImplementation(() => {
			order.push("registry");
			originalRegistryDispose();
		});
		const originalAuthClose = authStorage.close.bind(authStorage);
		vi.spyOn(authStorage, "close").mockImplementation(() => {
			order.push("auth");
			originalAuthClose();
		});
		setMnemopiSessionState(session, {
			async dispose() {
				order.push("mnemopi");
			},
		} as MnemopiSessionState);

		await session.dispose();
		disposed = true;

		expect(order).toEqual(["mnemopi", "registry", "auth"]);
	});
});
