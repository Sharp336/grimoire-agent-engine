import { describe, expect, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("IrcBus deadlock detection", () => {
	it("detects circular wait between two agents and throws an error", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);

		// Register two active subagents
		registry.register({ id: "AgentA", displayName: "Agent A", kind: "sub" });
		registry.register({ id: "AgentB", displayName: "Agent B", kind: "sub" });

		// Agent A starts waiting for Agent B
		const waitA = bus.wait("AgentA", { from: "AgentB" }, 0);

		// Agent B starts waiting for Agent A -> circular wait (deadlock!)
		await expect(bus.wait("AgentB", { from: "AgentA" }, 0)).rejects.toThrow(
			"Agent swarm deadlock detected: circular wait (AgentB -> AgentA -> AgentB)"
		);

		// Clean up A's waiter so promise resolves/rejects cleanly
		bus.inbox("AgentA"); // flush
	});

	it("detects circular wait when an agent waits for anyone and another waits for it", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);

		registry.register({ id: "AgentA", displayName: "Agent A", kind: "sub" });
		registry.register({ id: "AgentB", displayName: "Agent B", kind: "sub" });

		// Agent A waits for anyone (from: undefined)
		const waitA = bus.wait("AgentA", {}, 0);

		// Agent B waits for Agent A -> deadlock because Agent A is waiting for B (anyone includes B)
		await expect(bus.wait("AgentB", { from: "AgentA" }, 0)).rejects.toThrow(
			"Agent swarm deadlock detected: circular wait (AgentB -> AgentA -> AgentB)"
		);
	});
});
