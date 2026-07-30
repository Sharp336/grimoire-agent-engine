import { describe, expect, it, vi } from "bun:test";
import { CollabGuestLink } from "../src/collab/guest";
import { CollabHost } from "../src/collab/host";
import { CollabSocket } from "../src/collab/relay-client";
import {
	disposeRpcCollab,
	getRpcCollabStatus,
	isRpcCollabGuestJoining,
	joinRpcCollabSession,
	leaveRpcCollabSession,
	startRpcCollabHosting,
	stopRpcCollabHosting,
} from "../src/modes/rpc/rpc-collab";
import type { AgentSession } from "../src/session/agent-session";

function fakeSession(): AgentSession {
	return {
		sessionManager: { onEntryAppended: undefined },
		settings: {
			get: (path: string) => (path === "collab.webUrl" ? "" : undefined),
		},
		emitNotice: () => {},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

function fakeJoinSession(): AgentSession {
	return {
		...fakeSession(),
		getVibeModeState: () => undefined,
		acquireSessionTransition: () => ({
			run: async () => ({ result: undefined, committed: false, honorPlanDefault: false }),
			release: () => {},
		}),
	} as unknown as AgentSession;
}

describe("RPC collaboration hosting lifecycle", () => {
	it("shares one in-flight startup and keeps it reachable to disposal", async () => {
		const startupGate = Promise.withResolvers<void>();
		const start = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async () => {
			await startupGate.promise;
		});
		const stop = vi.spyOn(CollabHost.prototype, "stop");
		const session = fakeSession();

		try {
			const first = startRpcCollabHosting(session, "wss://relay.example.com");
			expect(start).toHaveBeenCalledTimes(1);

			const second = startRpcCollabHosting(session, "wss://relay.example.com");
			const disposal = disposeRpcCollab(session);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);

			startupGate.resolve();
			const [firstLinks, secondLinks] = await Promise.all([first, second, disposal]);

			expect(firstLinks).toEqual(secondLinks);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(await getRpcCollabStatus(session)).toEqual({
				role: "none",
				links: null,
				participants: [],
				readOnly: false,
			});
		} finally {
			startupGate.resolve();
			vi.restoreAllMocks();
		}
	});

	it("cleans up a failed startup and permits a retry", async () => {
		const startupError = new Error("relay unavailable");
		const start = vi.spyOn(CollabHost.prototype, "start").mockRejectedValueOnce(startupError).mockResolvedValueOnce();
		const stop = vi.spyOn(CollabHost.prototype, "stop");
		const session = fakeSession();

		try {
			await expect(startRpcCollabHosting(session, "wss://relay.example.com")).rejects.toBe(startupError);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);

			await startRpcCollabHosting(session, "wss://relay.example.com");
			expect(start).toHaveBeenCalledTimes(2);

			await stopRpcCollabHosting(session);
			expect(stop).toHaveBeenCalledTimes(2);
			expect((await getRpcCollabStatus(session)).role).toBe("none");
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("does not publish a host stopped while its relay connection opens", async () => {
		const subscribe = vi.fn(() => () => {});
		const sessionManager = {
			getSessionId: () => "session-1",
			onEntryAppended: undefined,
		};
		const context = {
			session: { subscribe, emitNotice: () => {} },
			sessionManager,
			collabHost: undefined,
		};
		const host = new CollabHost(context as never);
		try {
			const close = vi.spyOn(CollabSocket.prototype, "close").mockImplementation(() => {});
			vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
				void host.stop("session ended");
				this.onOpen?.();
			});

			await expect(host.start("wss://relay.example.com")).rejects.toThrow("Collab host stopped during startup");

			expect(close).toHaveBeenCalled();
			expect(subscribe).not.toHaveBeenCalled();
			expect(sessionManager.onEntryAppended).toBeUndefined();
			expect(context.collabHost).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe("RPC collaboration guest startup", () => {
	it("blocks guest mutations and leaves an owned startup without waiting for welcome", async () => {
		const startupGate = Promise.withResolvers<void>();
		const join = vi.spyOn(CollabGuestLink.prototype, "join").mockImplementation(async () => {
			await startupGate.promise;
		});
		const leave = vi.spyOn(CollabGuestLink.prototype, "leave").mockResolvedValue();
		const session = fakeJoinSession();

		try {
			const joining = joinRpcCollabSession(session, "wss://relay.example.com");
			expect(isRpcCollabGuestJoining(session)).toBe(true);

			const leaving = leaveRpcCollabSession(session);
			await Promise.resolve();
			expect(leave).toHaveBeenCalledWith("left");

			startupGate.resolve();
			await Promise.all([joining, leaving]);
			expect(isRpcCollabGuestJoining(session)).toBe(false);
			expect(join).toHaveBeenCalledTimes(1);
		} finally {
			startupGate.resolve();
			vi.restoreAllMocks();
		}
	});
});
