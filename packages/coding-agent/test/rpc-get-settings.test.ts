import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { handleGetSettings } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-get-settings";

/**
 * Covers the command's response plumbing directly. The mock-agent client test
 * cannot catch a missing or wrong case here, and the snapshot tests stop at
 * the builder.
 */
describe("handleGetSettings", () => {
	it("answers an unscoped request with the full snapshot", () => {
		const response = handleGetSettings(Settings.isolated(), "req-1", undefined);
		expect(response).toMatchObject({ id: "req-1", type: "response", command: "get_settings", success: true });
		if (!response.success || response.command !== "get_settings") throw new Error("expected a success response");
		expect(response.data.settings.length).toBeGreaterThan(0);
	});

	it("scopes to the requested tab", () => {
		const response = handleGetSettings(Settings.isolated(), "req-2", "appearance");
		if (!response.success || response.command !== "get_settings") throw new Error("expected a success response");
		expect(response.data.settings.length).toBeGreaterThan(0);
		for (const entry of response.data.settings) expect(entry.ui?.tab).toBe("appearance");
	});

	it("rejects a tab the wire could carry but the schema does not define", () => {
		for (const tab of ["appearence", "", 7, null, {}, ["appearance"]]) {
			const response = handleGetSettings(Settings.isolated(), "req-3", tab);
			expect(response).toMatchObject({
				id: "req-3",
				command: "get_settings",
				success: false,
				code: "invalid_tab",
			});
		}
	});

	it("preserves an absent request id", () => {
		const response = handleGetSettings(Settings.isolated(), undefined, undefined);
		expect(response.id).toBeUndefined();
		expect(response.success).toBe(true);
	});
});
