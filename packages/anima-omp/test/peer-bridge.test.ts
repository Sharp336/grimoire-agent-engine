import { describe, expect, it } from "bun:test";
import type { IrcMessage, IrcPeerTransport, IrcSendOptions } from "@oh-my-pi/pi-coding-agent";
import type { ActiveInvocation, AnimaExecutorController } from "../src/executor";
import { AnimaPeerBridge } from "../src/peer-bridge";
import {
	type AnimaControl,
	ControlProtocolError,
	type ControlRequestOptions,
	type MailReceiveResult,
	type ProtocolHello,
} from "../src/protocol";

const HELLO: ProtocolHello = {
	protocol: "anima-control",
	version: 1,
	anima_version: "test",
	owner: "external:omp:test",
	mailbox: "omp-test-Main",
	methods: [
		"invoke.start",
		"invoke.observe",
		"invoke.wait_turn",
		"invoke.cancel",
		"invoke.message",
		"invoke.release",
		"mail.receive",
		"mail.ack",
	],
	capabilities: { turn_authority: true, threaded_mail: true, external_mailbox: true },
	limits: { max_line_bytes: 1_048_576, max_in_flight: 128 },
};

class FakeControl implements AnimaControl {
	readonly calls: Array<{ method: string; params: unknown; options?: ControlRequestOptions }> = [];
	readonly receiveResults: MailReceiveResult[] = [];
	readonly acknowledged = Promise.withResolvers<string>();
	#pendingReceive?: ReturnType<typeof Promise.withResolvers<never>>;

	hello(): Promise<ProtocolHello> {
		return Promise.resolve(HELLO);
	}

	request<T>(method: string, params: unknown, options?: ControlRequestOptions): Promise<T> {
		this.calls.push({ method, params, options });
		if (method === "mail.receive") {
			const result = this.receiveResults.shift();
			if (result) return Promise.resolve(result as T);
			this.#pendingReceive = Promise.withResolvers<never>();
			return this.#pendingReceive.promise;
		}
		if (
			method === "mail.ack" &&
			params !== null &&
			typeof params === "object" &&
			"message_id" in params &&
			typeof params.message_id === "string"
		) {
			this.acknowledged.resolve(params.message_id);
		}
		return Promise.resolve({ acknowledged: true } as T);
	}

	close(): Promise<void> {
		this.#pendingReceive?.reject(new ControlProtocolError("transport_closed", "closed", true));
		this.#pendingReceive = undefined;
		return Promise.resolve();
	}
}

class FakeBus {
	transport?: IrcPeerTransport;
	readonly inbound: IrcMessage[] = [];

	registerPeerTransport(transport: IrcPeerTransport): () => void {
		this.transport = transport;
		return () => {
			if (this.transport === transport) this.transport = undefined;
		};
	}

	deliverInbound(message: IrcMessage): Promise<{ outcome: string }> {
		this.inbound.push(message);
		return Promise.resolve({ outcome: "injected" });
	}
}

function fakeController(): {
	controller: AnimaExecutorController;
	sent: Array<{ message: IrcMessage; options?: Readonly<IrcSendOptions> }>;
} {
	const active: ActiveInvocation = {
		requestId: "task-1",
		invocationId: "in-1",
		agentId: "reviewer-1",
		agentName: "claude-reviewer",
		sessionName: "omp-reviewer-1",
		state: "generating",
		detail: "reviewing",
	};
	const sent: Array<{ message: IrcMessage; options?: Readonly<IrcSendOptions> }> = [];
	const controller = {
		findByPeerId: (peerId: string) => (peerId === active.sessionName ? { ...active } : undefined),
		list: () => [{ ...active }],
		peerStatus: (invocation: ActiveInvocation) => invocation.state,
		sendPeer: (message: IrcMessage, options?: Readonly<IrcSendOptions>) => {
			sent.push({ message, options });
			return Promise.resolve("mail-1");
		},
	} as unknown as AnimaExecutorController;
	return { controller, sent };
}

describe("AnimaPeerBridge", () => {
	it("registers active Anima sessions as routable peers", async () => {
		const client = new FakeControl();
		const bus = new FakeBus();
		const { controller, sent } = fakeController();
		const bridge = new AnimaPeerBridge({ client, controller, bus });
		await bridge.start();

		expect(bus.transport).toBe(bridge);
		expect(bridge.claims("omp-reviewer-1")).toBe(true);
		expect(bridge.claims("unknown")).toBe(false);
		expect(bridge.listPeers()).toEqual([
			{
				id: "omp-reviewer-1",
				displayName: "claude-reviewer",
				status: "generating",
				activity: "reviewing",
			},
		]);
		const message: IrcMessage = {
			id: "irc-1",
			from: "Main",
			to: "omp-reviewer-1",
			body: "Report status.",
			ts: Date.now(),
		};
		await bridge.send(message, { expectsReply: true });
		expect(sent).toEqual([{ message, options: { expectsReply: true } }]);

		await bridge.stop();
		expect(bus.transport).toBeUndefined();
	});

	it("delivers canonical mailbox messages once and acknowledges them", async () => {
		const client = new FakeControl();
		client.receiveResults.push({
			messages: [
				{
					id: "mail-1",
					from: "omp-reviewer-1",
					to: HELLO.mailbox,
					subject: "Re: status",
					body: "Review complete.",
					priority: 1,
					thread_id: "thread-1",
					reply_to: "outbound-1",
					sent_at: "2026-07-28T00:00:00Z",
				},
			],
		});
		const bus = new FakeBus();
		const { controller } = fakeController();
		const bridge = new AnimaPeerBridge({ client, controller, bus });
		await bridge.start();
		expect(await client.acknowledged.promise).toBe("mail-1");

		expect(bus.inbound).toEqual([
			{
				id: "mail-1",
				from: "omp-reviewer-1",
				to: "Main",
				body: "Review complete.",
				ts: Date.parse("2026-07-28T00:00:00Z"),
				threadId: "thread-1",
				replyTo: "outbound-1",
			},
		]);
		expect(client.calls.some(call => call.method === "mail.ack")).toBe(true);
		await bridge.stop();
	});
});
