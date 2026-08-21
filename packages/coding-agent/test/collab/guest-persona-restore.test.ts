/**
 * Regression: leaving a collab session must clear the replica persona
 * override mirrored from the host (`AgentSession#setReplicaPersonaName`).
 *
 * Oracle: `#applyHostState()` sets a sticky override whenever the host
 * reports `activePersonaName`, and `AgentSession.activePersonaName` prefers
 * that override over the local persona (see agent-session.ts). Without
 * clearing it on teardown, the guest's restored local session — resumed or
 * freshly created — would keep showing the host's (possibly now-stale)
 * persona name in the status line and in the next persisted `agent` stamp,
 * corrupting resume inference for a session that was never actually using
 * that persona.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function makeContext() {
	const setReplicaPersonaName = vi.fn();
	const ctx = {
		collabGuest: undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			setReplicaPersonaName,
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {},
	} as unknown as InteractiveModeContext;
	return { ctx, setReplicaPersonaName };
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CollabGuestLink — persona restore on leave", () => {
	it("clears the replica persona override before restoring the local session", async () => {
		const { ctx, setReplicaPersonaName } = makeContext();
		const guest = new CollabGuestLink(ctx);

		await guest.leave("test cleanup");

		expect(setReplicaPersonaName).toHaveBeenCalledWith(undefined);
	});
});
