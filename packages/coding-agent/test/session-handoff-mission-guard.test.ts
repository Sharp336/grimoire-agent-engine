import { describe, expect, it } from "bun:test";
import { SessionHandoff, type SessionHandoffHost } from "@oh-my-pi/pi-coding-agent/session/session-handoff";

describe("SessionHandoff mission transition guard", () => {
	it("rejects direct handoff before inspecting or rewriting session state", async () => {
		let inspected = false;
		const unreachable = (): never => {
			throw new Error("must not inspect handoff state");
		};
		const host: SessionHandoffHost = {
			agent: null as never,
			sessionManager: {
				getBranch: () => {
					inspected = true;
					return [];
				},
			} as never,
			settings: null as never,
			modelRegistry: null as never,
			extensionRunner: undefined,
			sideStreamFn: unreachable,
			obfuscator: undefined,
			model: unreachable,
			thinkingLevel: unreachable,
			sessionId: unreachable,
			sessionFile: unreachable,
			baseSystemPrompt: unreachable,
			assertMissionTransitionAllowed: () => {
				throw new Error("MISSION_BUSY");
			},
			assertVibeSessionTransitionAllowed: unreachable,
			setSkipPostTurnMaintenance: unreachable,
			obfuscateTextForProvider: unreachable,
			deobfuscateFromProvider: unreachable,
			convertMessagesToLlm: unreachable,
			prepareSimpleStreamOptions: unreachable,
			effectiveServiceTier: unreachable,
			flushPendingBash: unreachable,
			beginBashSessionTransition: unreachable,
			markBashSessionTransition: unreachable,
			finishBashSessionTransition: unreachable,
			cancelOwnAsyncJobs: unreachable,
			clearCheckpointRuntimeState: unreachable,
			clearSessionScopedToolState: unreachable,
			clearFreshProviderSessionId: unreachable,
			syncAgentSessionId: unreachable,
			rekeyMemoryForCurrentSessionId: unreachable,
			resetMemoryContextForNewTranscript: unreachable,
			clearPendingNextTurnMessages: unreachable,
			resetTodoCycle: unreachable,
			buildDisplaySessionContext: unreachable,
			resetAdvisorRuntimes: unreachable,
			syncTodoPhasesFromBranch: unreachable,
			rearmSessionSchedules: unreachable,
		};

		await expect(new SessionHandoff(host).handoff()).rejects.toThrow("MISSION_BUSY");
		expect(inspected).toBe(false);
	});
});
