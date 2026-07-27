import { describe, expect, it } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { type } from "arktype";

function createHubTool(): HubTool {
	return new HubTool({} as unknown as ToolSession);
}

describe("HubTool parameters", () => {
	it("preserves runtime validation and provider wire descriptions", () => {
		const tool = createHubTool();
		const schema = tool.parameters;
		const start = {
			op: "start" as const,
			name: "web",
			application: "bun",
			args: ["run", "dev"],
			ready: {
				log: "Local:.*http",
				port: 5173,
				host: "127.0.0.1",
				timeout: 30,
			},
			restart: "on-failure" as const,
			persist: true,
		};

		expect(schema.assert({ op: "list" })).toEqual({ op: "list" });
		expect(schema.assert(start)).toEqual(start);
		expect(() => schema.assert({ op: "launch" })).toThrow();
		expect(() => schema.assert({ op: "logs", cursor: -1 })).toThrow();

		const wire = toolWireSchema(tool);
		const properties = wire.properties as Record<string, Record<string, unknown>>;
		const op = properties.op;
		const ready = properties.ready;
		const readyProperties = ready?.properties as Record<string, Record<string, unknown>>;

		expect(wire).toMatchObject({ type: "object", additionalProperties: false, required: ["op"] });
		expect(op.description).toBe("hub operation");
		expect([...(op.enum as string[])].sort()).toEqual(
			[
				"cancel",
				"describe",
				"inbox",
				"jobs",
				"list",
				"logs",
				"ps",
				"restart",
				"send",
				"start",
				"stop",
				"wait",
			].sort(),
		);
		expect(properties.cursor).toMatchObject({
			type: "number",
			minimum: 0,
			description: "logs: output cursor returned by an earlier call",
		});
		expect(ready).toMatchObject({
			type: "object",
			additionalProperties: false,
			description: "start: readiness conditions; all supplied conditions must pass",
		});
		expect(readyProperties.log).toMatchObject({
			type: "string",
			minLength: 1,
			description: "regex matched against output",
		});
		expect(readyProperties.port).toMatchObject({
			type: "number",
			description: "TCP port that must accept connections",
		});
		expect(readyProperties.host).toMatchObject({
			type: "string",
			minLength: 1,
			description: "TCP readiness host; default 127.0.0.1",
		});
		expect(readyProperties.timeout).toMatchObject({
			type: "number",
			exclusiveMinimum: 0,
			description: "seconds to wait; default 30",
		});
	});

	it("does not retain ArkType JIT precompilation", () => {
		const jitControl = type({ op: "string" });
		const schema = createHubTool().parameters;

		expect(typeof jitControl.precompilation).toBe("string");
		expect(schema.precompilation).toBeUndefined();
	});
});
