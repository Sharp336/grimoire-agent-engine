import { describe, expect, it } from "bun:test";
import { isAgentsContextFile } from "@oh-my-pi/pi-coding-agent/utils/context-files";

describe("isAgentsContextFile", () => {
	it("classifies canonical and explicitly marked AGENTS context only", () => {
		expect(isAgentsContextFile({ path: "/project/AGENTS.md" })).toBe(true);
		expect(isAgentsContextFile({ path: "/project/agents.MD" })).toBe(true);
		expect(isAgentsContextFile({ path: "/tmp/strict.md", kind: "agents-md" })).toBe(true);
		expect(isAgentsContextFile({ path: "/project/context.md" })).toBe(false);
	});
});
