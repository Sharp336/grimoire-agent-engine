import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState, type MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeFakeSession(settings: Settings) {
	const listeners = new Set<(event: unknown) => void>();
	return {
		sessionId: "mnemopi-side-recall",
		settings,
		sessionManager: {
			getEntries: () => [
				{
					id: "previous-assistant",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "previous assistant context" }],
						model: "x",
						provider: "x",
						api: "x",
						stopReason: "end_turn" as const,
						timestamp: 0,
					},
				},
			],
			getCwd: () => "/tmp",
			getSessionFile: () => null,
			getSessionId: () => "mnemopi-side-recall",
		},
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

describe("mnemopiBackend side-request recall", () => {
	it("recalls independently for side prompts without replacing the main cached snippet", async () => {
		const tempDir = await TempDir.create("@mnemopi-side-recall-");
		let state: MnemopiSessionState | undefined;
		try {
			const settings = Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.dbPath": path.join(tempDir.path(), "mnemopi.db"),
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
			});
			const session = makeFakeSession(settings);
			await mnemopiBackend.start({
				session: session as never,
				settings,
				modelRegistry: {
					getApiKeyForProvider: async () => undefined,
				} as never,
				agentDir: tempDir.path(),
				taskDepth: 0,
			});

			state = getMnemopiSessionState(session as never);
			expect(state).toBeDefined();
			if (!state) return;
			const recallSpy = vi.spyOn(state, "collectScopedRecallResults").mockImplementation(async query => [
				{ id: query, content: `memory for ${query}` } as never,
			]);

			const main = await mnemopiBackend.beforeAgentStartPrompt(session as never, "main prompt");
			const sideOne = await mnemopiBackend.beforeSideRequestPrompt(session as never, "first side prompt");
			const sideTwo = await mnemopiBackend.beforeSideRequestPrompt(session as never, "second side prompt");
			const replayedMain = await mnemopiBackend.beforeAgentStartPrompt(session as never, "later main prompt");

			expect(recallSpy).toHaveBeenCalledTimes(3);
			expect(recallSpy.mock.calls[1]?.[0]).toContain("first side prompt");
			expect(recallSpy.mock.calls[2]?.[0]).toContain("second side prompt");
			expect(sideOne).toContain("first side prompt");
			expect(sideTwo).toContain("second side prompt");
			expect(replayedMain).toBe(main);
			expect(state.lastRecallSnippet).toBe(main);
		} finally {
			await state?.dispose({ consolidate: false });
			await Bun.sleep(0);
			await tempDir.remove();
		}
	});
});
