import { describe, expect, it, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("consultation read-only routing", () => {
	it("is absent from messageable rosters and direct IRC fails before lifecycle activity", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: {} as never, status: "idle" });
		registry.register({
			id: "Main/consult:1",
			displayName: "consult:1",
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/consult.jsonl",
			status: "parked",
		});
		const lifecycle = new AgentLifecycleManager(registry);
		const ensureLive = vi.spyOn(lifecycle, "ensureLive");
		const bus = new IrcBus(registry, lifecycle);
		const rosterBeforeDelivery = registry.list().map(ref => ({
			id: ref.id,
			session: ref.session,
			status: ref.status,
		}));
		expect(registry.listMessageableTo("Main").map(ref => ref.id)).not.toContain("Main/consult:1");
		const result = await bus.send({ from: "Main", to: "Main/consult:1", body: "hello" });
		expect(result).toMatchObject({ outcome: "failed" });
		expect(result.error).toContain("read-only consultation transcript");
		expect(ensureLive).not.toHaveBeenCalled();
		expect(registry.list().map(ref => ({ id: ref.id, session: ref.session, status: ref.status }))).toEqual(
			rosterBeforeDelivery,
		);
		await expect(lifecycle.ensureLive("Main/consult:1")).rejects.toThrow(
			'"Main/consult:1" is a read-only consultation transcript — nothing to revive.',
		);
		await expect(lifecycle.release("Main/consult:1")).rejects.toThrow(
			'"Main/consult:1" is a read-only consultation transcript — cannot be killed.',
		);
		expect(registry.get("Main/consult:1")).toBeDefined();
		expect(registry.list().map(ref => ({ id: ref.id, session: ref.session, status: ref.status }))).toEqual(
			rosterBeforeDelivery,
		);
	});

	it("keeps running and parked consultation threads out of every peer roster", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: {} as never, status: "idle" });
		registry.register({
			id: "Main/consult:running",
			displayName: "consult:running",
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/consult-running.jsonl",
			status: "running",
		});
		registry.register({
			id: "Main/consult:parked",
			displayName: "consult:parked",
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/consult-parked.jsonl",
			status: "parked",
		});
		registry.register({
			id: "Main/sub:peer",
			displayName: "sub:peer",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/peer.jsonl",
			status: "parked",
		});

		expect(registry.listVisibleTo("Main").map(ref => ref.id)).not.toContain("Main/consult:running");
		expect(registry.listMessageableTo("Main").map(ref => ref.id)).toEqual(["Main/sub:peer"]);
	});
});
