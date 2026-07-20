import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CollabHost, type CollabHostContext } from "@oh-my-pi/pi-coding-agent/collab/host";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHeadlessContext(events: string[]): CollabHostContext {
	return {
		displayName: "rpc-host",
		sessionManager: {
			getSessionId: () => "sess-rpc",
			getCwd: () => "/workspace",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: "sess-rpc",
					timestamp: new Date().toISOString(),
					cwd: "/workspace",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "headless",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }),
		},
		onParticipantsChanged: count => events.push(`participants:${count}`),
		onStopped: () => events.push("stopped"),
	};
}

describe("mode-neutral CollabHost context", () => {
	beforeEach(() => installInMemoryRelay());
	afterEach(() => uninstallInMemoryRelay());

	it("hosts and stops without an InteractiveModeContext or TUI", async () => {
		const events: string[] = [];
		const host = new CollabHost(makeHeadlessContext(events));

		await host.start("ws://localhost:8787");
		expect(host.participants).toEqual([{ name: "rpc-host", role: "host" }]);
		expect(events).toEqual(["participants:1"]);

		await host.stop("test done");
		expect(events).toEqual(["participants:1", "participants:0", "stopped"]);
	});
});
