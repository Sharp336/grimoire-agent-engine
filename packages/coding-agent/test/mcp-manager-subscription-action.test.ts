import { describe, expect, it } from "bun:test";
import {
	PENDING_RESOURCE_UPDATE_CAP,
	queuePendingResourceUpdate,
	resolveSubscriptionPostAction,
	takePendingResourceUpdates,
} from "@oh-my-pi/pi-coding-agent/mcp/manager";

describe("resolveSubscriptionPostAction", () => {
	it("returns rollback when notifications are disabled", () => {
		expect(resolveSubscriptionPostAction(false, 5, 5)).toBe("rollback");
		expect(resolveSubscriptionPostAction(false, 10, 2)).toBe("rollback");
	});

	it("returns ignore when notifications are enabled but epoch is stale", () => {
		expect(resolveSubscriptionPostAction(true, 8, 7)).toBe("ignore");
	});

	it("returns apply when notifications are enabled and epoch matches", () => {
		expect(resolveSubscriptionPostAction(true, 3, 3)).toBe("apply");
	});
});

describe("pending resource-update buffer (awaited-startup gap)", () => {
	it("dedupes by server+uri and drains in insertion order", () => {
		const pending = new Map<string, { serverName: string; uri: string }>();
		queuePendingResourceUpdate(pending, "a", "uri://1");
		queuePendingResourceUpdate(pending, "b", "uri://2");
		queuePendingResourceUpdate(pending, "a", "uri://1"); // dedupe
		expect(takePendingResourceUpdates(pending)).toEqual([
			{ serverName: "a", uri: "uri://1" },
			{ serverName: "b", uri: "uri://2" },
		]);
		expect(pending.size).toBe(0);
		expect(takePendingResourceUpdates(pending)).toEqual([]);
	});

	it("stops accepting new keys once the cap is reached", () => {
		const pending = new Map<string, { serverName: string; uri: string }>();
		const cap = 3;
		for (let i = 0; i < cap + 5; i++) {
			queuePendingResourceUpdate(pending, "s", `uri://${i}`, cap);
		}
		expect(pending.size).toBe(cap);
		// Existing keys can still be refreshed under the cap.
		queuePendingResourceUpdate(pending, "s", "uri://0", cap);
		expect(pending.size).toBe(cap);
		expect(PENDING_RESOURCE_UPDATE_CAP).toBeGreaterThan(0);
	});
});
