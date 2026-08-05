import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function createSession(backend: "off" | "local"): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "memory.backend": backend }),
	};
}

function pathDescription(tool: ReadTool): string {
	const schema = tool.parameters.toJsonSchema() as {
		properties?: { path?: { description?: string } };
	};
	return schema.properties?.path?.description ?? "";
}

// Regression for issue #7673: with memory.backend=off, the Read tool schema
// must not advertise memory:// as an example URI.
describe("memory.backend=off (issue #7673)", () => {
	it("omits memory:// from the Read schema when the backend is off", () => {
		const description = pathDescription(new ReadTool(createSession("off")));
		expect(description).not.toContain("memory://");
		expect(description).toContain("skill://");
	});

	it("keeps memory:// in the Read schema when a backend is active", () => {
		const description = pathDescription(new ReadTool(createSession("local")));
		expect(description).toContain("memory://");
	});
});
