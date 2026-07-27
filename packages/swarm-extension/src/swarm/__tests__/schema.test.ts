import { describe, expect, it } from "bun:test";
import { parseSwarmYaml } from "../schema";

describe("parseSwarmYaml — agent/workspace/gate fields", () => {
	it("parses agent, workspace, and gate into typed SwarmAgent fields", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/workspace
  agents:
    code-reviewer:
      role: reviewer
      task: review the auth module
      agent: reviewer
      workspace: wt/auth
      gate:
        prompt: "Please review the changes"
        actions:
          - approve
          - edit
          - reject
        timeout: 300
        on_timeout: fail
        default_action: reject
`;
		const def = parseSwarmYaml(yaml);
		const agent = def.agents.get("code-reviewer");
		expect(agent).toBeDefined();

		// agent field
		expect(agent?.agent).toBe("reviewer");

		// workspace field
		expect(agent?.workspace).toBe("wt/auth");

		// gate field — must be a typed GateConfig, NOT a string
		const gate = agent?.gate;
		expect(gate).toBeDefined();
		expect(typeof gate).toBe("object");
		expect(gate?.prompt).toBe("Please review the changes");
		expect(gate?.actions).toEqual(["approve", "edit", "reject"]);
		expect(gate?.onTimeout).toBe("fail");
		expect(gate?.defaultAction).toBe("reject");
	});

	it("parses gate with minimal fields (prompt + actions only)", () => {
		const yaml = `
swarm:
  name: minimal-gate
  workspace: /tmp/ws
  agents:
    approver:
      role: approver
      task: approve or reject
      gate:
        prompt: "Ship it?"
        actions:
          - ship
          - hold
`;
		const def = parseSwarmYaml(yaml);
		const agent = def.agents.get("approver");
		expect(agent?.gate).toBeDefined();
		expect(agent?.gate?.prompt).toBe("Ship it?");
		expect(agent?.gate?.actions).toEqual(["ship", "hold"]);
		expect(agent?.gate?.timeout).toBeUndefined();
		expect(agent?.gate?.onTimeout).toBeUndefined();
		expect(agent?.gate?.defaultAction).toBeUndefined();
	});

	it("allows agent field with any non-empty string (shape-only validation)", () => {
		const yaml = `
swarm:
  name: custom-agent
  workspace: /tmp/ws
  agents:
    custom:
      role: custom-role
      task: do something
      agent: my-custom-agent-from-extensions
`;
		const def = parseSwarmYaml(yaml);
		expect(def.agents.get("custom")?.agent).toBe("my-custom-agent-from-extensions");
	});

	it("rejects empty agent string", () => {
		const yaml = `
swarm:
  name: bad-agent
  workspace: /tmp/ws
  agents:
    bad:
      role: reviewer
      task: review
      agent: ""
`;
		expect(() => parseSwarmYaml(yaml)).toThrow();
	});

	it("omits optional fields when not present in YAML", () => {
		const yaml = `
swarm:
  name: no-extras
  workspace: /tmp/ws
  agents:
    basic:
      role: worker
      task: do work
`;
		const def = parseSwarmYaml(yaml);
		const agent = def.agents.get("basic");
		expect(agent?.agent).toBeUndefined();
		expect(agent?.workspace).toBeUndefined();
		expect(agent?.gate).toBeUndefined();
	});

	it("rejects whitespace-only agent string", () => {
		const yaml = `
swarm:
  name: ws-agent
  workspace: /tmp/ws
  agents:
    ws:
      role: reviewer
      task: review
      agent: "   "
`;
		expect(() => parseSwarmYaml(yaml)).toThrow();
	});

	it("rejects non-string workspace", () => {
		const yaml = `
swarm:
  name: num-ws
  workspace: /tmp/ws
  agents:
    bad:
      role: reviewer
      task: review
      workspace: 123
`;
		expect(() => parseSwarmYaml(yaml)).toThrow();
	});

	it("stores trimmed agent and workspace, drops whitespace-only", () => {
		const yaml = `
swarm:
  name: trim-test
  workspace: /tmp/ws
  agents:
    trimmed:
      role: worker
      task: work
      agent: "  reviewer  "
      workspace: "  wt/auth  "
`;
		const def = parseSwarmYaml(yaml);
		expect(def.agents.get("trimmed")?.agent).toBe("reviewer");
		expect(def.agents.get("trimmed")?.workspace).toBe("wt/auth");
	});
});
