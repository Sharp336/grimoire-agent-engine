/**
 * Contract: renderer provenance gating must tolerate lightweight view-session
 * implementations. Real sessions answer `isBuiltInTool` from their tool-registry
 * provenance; a session that cannot answer falls back to allowing the built-in
 * renderer (pre-provenance default) instead of crashing the render path.
 */

import { describe, expect, it } from "bun:test";
import { isBuiltInTool } from "@oh-my-pi/pi-coding-agent/modes/utils/tool-provenance";

describe("isBuiltInTool provenance resolution", () => {
	it("delegates to a session that can answer from its tool registry", () => {
		const session = { hasBuiltInTool: (name: string) => name === "write" };
		expect(isBuiltInTool(session, "write")).toBe(true);
		expect(isBuiltInTool(session, "recall")).toBe(false);
	});

	it("falls back to the built-in-renderer default for a lightweight session without provenance", () => {
		// e.g. the partial view-session doubles used across controller tests
		expect(isBuiltInTool({}, "eval")).toBe(true);
	});
});
