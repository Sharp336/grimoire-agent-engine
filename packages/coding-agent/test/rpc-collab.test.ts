import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	RpcCollabHostController,
	type RpcCollabHostControllerContext,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import type { RpcCollabLifecycleFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { type InMemoryRelay, installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";

function makeControllerContext(output: (frame: RpcCollabLifecycleFrame) => void): RpcCollabHostControllerContext {
	return {
		defaultRelayUrl: "ws://localhost:8787",
		displayName: "rpc-host",
		output,
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
	};
}

describe("RPC collaboration host controls", () => {
	let relay: InMemoryRelay;

	beforeEach(() => {
		relay = installInMemoryRelay();
	});
	afterEach(() => uninstallInMemoryRelay());

	it("starts one room idempotently, reports status, and stops it", async () => {
		const frames: RpcCollabLifecycleFrame[] = [];
		const controller = new RpcCollabHostController(makeControllerContext(frame => frames.push(frame)));

		const started = await controller.start({});
		expect(started).toMatchObject({ active: true, participants: [{ name: "rpc-host", role: "host" }] });
		expect(started.joinUrl).toStartWith("ws://localhost:8787/");
		expect(started.viewUrl).not.toBe(started.joinUrl);
		expect(await controller.start({ relayUrl: "ws://ignored.example" })).toEqual(started);
		expect(controller.status()).toEqual(started);
		expect(frames.filter(frame => frame.state === "started")).toHaveLength(1);

		await controller.stop("RPC client requested stop");
		expect(controller.status()).toEqual({ active: false, participants: [] });
		expect(frames.at(-1)).toEqual({
			type: "collab_state",
			state: "stopped",
			reason: "RPC client requested stop",
			room: { active: false, participants: [] },
		});
	});

	it("rejects when the relay closes during startup without leaking session taps", async () => {
		const frames: RpcCollabLifecycleFrame[] = [];
		let subscriptions = 0;
		const context = makeControllerContext(frame => frames.push(frame));
		context.session.subscribe = () => {
			subscriptions++;
			return () => subscriptions--;
		};
		const controller = new RpcCollabHostController(context);
		relay.failNextHostOnConnect(4001, "room closed during startup");

		await expect(controller.start({})).rejects.toThrow("collaboration room ended while starting");
		expect(controller.status()).toEqual({ active: false, participants: [] });
		expect(subscriptions).toBe(0);
		expect(frames.some(frame => frame.state === "started")).toBe(false);
		expect(frames.filter(frame => frame.state === "failed")).toHaveLength(1);
	});

	it("emits a failed lifecycle frame when the relay closes the room", async () => {
		const failed = Promise.withResolvers<RpcCollabLifecycleFrame>();
		const controller = new RpcCollabHostController(
			makeControllerContext(frame => {
				if (frame.state === "failed") failed.resolve(frame);
			}),
		);
		await controller.start({});

		relay.failHost(4001, "room closed");

		expect(await failed.promise).toEqual({
			type: "collab_state",
			state: "failed",
			reason: "room closed",
			room: { active: false, participants: [] },
		});
		expect(controller.status().active).toBe(false);
	});
});
