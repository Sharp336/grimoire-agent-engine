import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	IrcBus,
	type IrcMessage,
	type PeerTransportBackend,
	type PeerTransportDelivery,
	type PeerTransportResult,
} from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { executeMessageWait } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

function localSession() {
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: true,
		deliverIrcMessage: async (message: IrcMessage) => {
			delivered.push(message);
			return "injected" as const;
		},
	} as unknown as AgentSession;
	return { session, delivered };
}

function registerRemote(registry: AgentRegistry, id: string, executionId = id): void {
	registry.registerRemote({
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		status: "running",
		identity: { controllerId: "controller", executionId, generation: 3 },
	});
}

function accepted(delivery: PeerTransportDelivery): PeerTransportResult {
	return {
		deliveryId: delivery.deliveryId,
		sequence: delivery.sequence,
		sender: delivery.sender,
		recipient: delivery.recipient,
		outcome: "accepted",
	};
}

describe("remote peer transport", () => {
	it("leaves local-local delivery on the in-process bus", async () => {
		const registry = new AgentRegistry();
		const recipient = localSession();
		registry.register({ id: "Local", displayName: "local", kind: "sub", session: recipient.session });
		const transport: PeerTransportBackend = {
			deliver: vi.fn(async () => {
				throw new Error("transport must not run");
			}),
			cancel: vi.fn(async () => {}),
		};
		const bus = new IrcBus(registry, new AgentLifecycleManager(registry), transport);

		const receipt = await bus.send({ from: "Main", to: "Local", body: "local message" });

		expect(receipt).toEqual({ to: "Local", outcome: "injected" });
		expect(recipient.delivered.map(message => message.body)).toEqual(["local message"]);
		expect(transport.deliver).not.toHaveBeenCalled();
	});

	it("routes remote recipients and senders with exact immutable identities and monotonic metadata", async () => {
		const registry = new AgentRegistry();
		const local = localSession();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: local.session });
		registerRemote(registry, "RemoteA", "exec-a");
		const deliveries: PeerTransportDelivery[] = [];
		const transport: PeerTransportBackend = {
			deliver: vi.fn(async delivery => {
				deliveries.push(delivery);
				return accepted(delivery);
			}),
			cancel: vi.fn(async () => {}),
		};
		const lifecycle = new AgentLifecycleManager(registry);
		const ensureLive = vi.spyOn(lifecycle, "ensureLive");
		const bus = new IrcBus(registry, lifecycle, transport);

		const outbound = await bus.send({
			from: "Main",
			to: "RemoteA",
			body: "remote message",
			replyTo: "prior-id",
			endpoint: "https://attacker.invalid",
			capability: "admin",
		} as Omit<IrcMessage, "id" | "ts">);
		const outboundAgain = await bus.send({ from: "Main", to: "RemoteA", body: "second remote message" });
		const inbound = await bus.send({ from: "RemoteA", to: "Main", body: "remote sender" });

		expect(outbound.outcome).toBe("remote");
		expect(outboundAgain.outcome).toBe("remote");
		expect(inbound.outcome).toBe("remote");
		expect(deliveries.map(delivery => delivery.sequence)).toEqual([1, 2, 1]);
		expect(deliveries[0]?.sender).toMatchObject({ locality: "local", agentId: "Main", generation: 1 });
		expect(deliveries[0]?.recipient).toEqual({
			locality: "remote",
			agentId: "RemoteA",
			controllerId: "controller",
			executionId: "exec-a",
			generation: 3,
		});
		expect(deliveries[0]?.payload).toEqual({ body: "remote message", replyTo: "prior-id" });
		expect(Object.keys(deliveries[0]?.payload ?? {}).sort()).toEqual(["body", "replyTo"]);
		expect(local.delivered).toHaveLength(0);
		expect(bus.unreadCount("Main")).toBe(0);
		expect(bus.unreadCount("RemoteA")).toBe(0);
		expect(ensureLive).not.toHaveBeenCalled();
	});

	it("keeps transport sequences separate for tuple identities that collide under colon concatenation", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: localSession().session });
		registry.registerRemote({
			id: "RemoteOne",
			displayName: "one",
			kind: "sub",
			status: "running",
			identity: { controllerId: "a:b", executionId: "c", generation: 3 },
		});
		registry.registerRemote({
			id: "RemoteTwo",
			displayName: "two",
			kind: "sub",
			status: "running",
			identity: { controllerId: "a", executionId: "b:c", generation: 3 },
		});
		const deliveries: PeerTransportDelivery[] = [];
		const bus = new IrcBus(registry, new AgentLifecycleManager(registry), {
			deliver: async delivery => {
				deliveries.push(delivery);
				return accepted(delivery);
			},
			cancel: async () => {},
		});

		await bus.send({ from: "RemoteOne", to: "Main", body: "one" });
		await bus.send({ from: "RemoteTwo", to: "Main", body: "two" });

		expect(deliveries.map(delivery => delivery.sequence)).toEqual([1, 1]);
	});

	it("fails closed on stale, malformed, duplicate, conflicting, unknown, and unavailable delivery outcomes", async () => {
		const outcomes: Array<"stale" | "malformed" | "duplicate" | "conflict" | "outage"> = [
			"stale",
			"malformed",
			"duplicate",
			"conflict",
			"outage",
		];
		for (const outcome of outcomes) {
			const registry = new AgentRegistry();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: localSession().session });
			registerRemote(registry, "Remote");
			const transport: PeerTransportBackend = {
				deliver: async delivery => {
					if (outcome === "outage") throw new Error("offline");
					if (outcome === "malformed") return { deliveryId: delivery.deliveryId } as never;
					if (outcome === "stale") {
						return {
							...accepted(delivery),
							recipient: { ...delivery.recipient, generation: delivery.recipient.generation + 1 },
						};
					}
					return { ...accepted(delivery), outcome };
				},
				cancel: async () => {},
			};
			const bus = new IrcBus(registry, new AgentLifecycleManager(registry), transport);
			const receipt = await bus.send({ from: "Main", to: "Remote", body: "message" });
			expect(receipt.outcome).toBe("failed");
			expect(bus.unreadCount("Remote")).toBe(0);
		}

		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: localSession().session });
		const deliver = vi.fn(async (delivery: PeerTransportDelivery) => accepted(delivery));
		const bus = new IrcBus(registry, new AgentLifecycleManager(registry), { deliver, cancel: async () => {} });
		const unknown = await bus.send({ from: "Main", to: "Missing", body: "message" });
		expect(unknown.outcome).toBe("failed");
		expect(deliver).not.toHaveBeenCalled();

		registerRemote(registry, "Remote");
		const unavailable = new IrcBus(registry, new AgentLifecycleManager(registry));
		expect((await unavailable.send({ from: "Main", to: "Remote", body: "message" })).outcome).toBe("failed");
	});

	it("installs one global peer transport closure idempotently and rejects replacement", () => {
		IrcBus.resetGlobalForTests();
		try {
			const first: PeerTransportBackend = {
				deliver: async delivery => accepted(delivery),
				cancel: async () => {},
			};
			IrcBus.installGlobalPeerTransport(first);
			expect(() => IrcBus.installGlobalPeerTransport(first)).not.toThrow();
			expect(() =>
				IrcBus.installGlobalPeerTransport({
					deliver: async delivery => accepted(delivery),
					cancel: async () => {},
				}),
			).toThrow("already installed");
		} finally {
			IrcBus.resetGlobalForTests();
		}
	});

	it("rejects filtered and bare remote waits before creating a local bus waiter", async () => {
		IrcBus.resetGlobalForTests();
		try {
			const registry = new AgentRegistry();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: localSession().session });
			registerRemote(registry, "Remote");
			const wait = vi.spyOn(IrcBus.global(), "wait");
			const deps = { registry, senderId: "Main", settings: Settings.isolated() };

			const filtered = await executeMessageWait(deps, { from: "Remote", timeoutMs: 0 });
			const bare = await executeMessageWait(deps, { timeoutMs: 0 });

			expect(filtered.isError).toBe(true);
			expect(bare.isError).toBe(true);
			expect(wait).not.toHaveBeenCalled();
		} finally {
			IrcBus.resetGlobalForTests();
		}
	});

	it("drains buffered IrcBus mail before rejecting a remote-only future wait", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const registry = AgentRegistry.global();
			const mainSession = {
				isStreaming: false,
				deliverIrcMessage: async () => {
					throw new Error("buffer directly in IrcBus mailbox");
				},
			} as unknown as AgentSession;
			registry.register({ id: "Main", displayName: "main", kind: "main", session: mainSession });
			registerRemote(registry, "Remote");
			const bus = IrcBus.global();
			const wait = vi.spyOn(bus, "wait");
			const deps = { registry, senderId: "Main", settings: Settings.isolated() };

			const failedDelivery = await bus.send({ from: "LegacyLocal", to: "Main", body: "already on bus" });
			expect(failedDelivery.outcome).toBe("failed");
			expect(bus.unreadCount("Main")).toBe(1);

			const fromBus = await executeMessageWait(deps, { timeoutMs: 0 });

			expect(fromBus.details?.waited?.body).toBe("already on bus");
			expect(bus.unreadCount("Main")).toBe(0);
			expect(wait).not.toHaveBeenCalled();
		} finally {
			IrcBus.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	it("routes abort cancellation to the same remote delivery identity", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: localSession().session });
		registerRemote(registry, "Remote");
		const pending = Promise.withResolvers<PeerTransportResult>();
		let captured: PeerTransportDelivery | undefined;
		const cancel = vi.fn(async (_delivery: Readonly<PeerTransportDelivery>) => {});
		const transport: PeerTransportBackend = {
			deliver: async delivery => {
				captured = delivery;
				return pending.promise;
			},
			cancel,
		};
		const bus = new IrcBus(registry, new AgentLifecycleManager(registry), transport);
		const controller = new AbortController();
		const sending = bus.send({ from: "Main", to: "Remote", body: "cancel me" }, { signal: controller.signal });
		await Promise.resolve();
		controller.abort(new Error("stop"));
		await Promise.resolve();
		expect(cancel).toHaveBeenCalledWith(captured);
		if (!captured) throw new Error("delivery was not captured");
		pending.resolve(accepted(captured));
		expect((await sending).outcome).toBe("remote");
	});
});
