/**
 * Pins the MCP client capabilities advertised on `initialize`.
 *
 * `roots.listChanged: true` is what authorizes the client to send
 * `notifications/roots/list_changed` per MCP spec. Flipping it back to false
 * silently disables every consumer of MCPManager.setCwd; this test fails fast
 * on that regression.
 */
import { describe, expect, it } from "bun:test";
import { CLIENT_CAPABILITIES } from "../src/mcp/client";

describe("CLIENT_CAPABILITIES", () => {
	it("declares roots.listChanged = true", () => {
		expect(CLIENT_CAPABILITIES.roots.listChanged).toBe(true);
	});

	it("declares the roots capability (object present)", () => {
		expect(CLIENT_CAPABILITIES.roots).toBeDefined();
	});
});
