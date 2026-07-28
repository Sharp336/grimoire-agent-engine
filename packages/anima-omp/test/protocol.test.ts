import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ControlProtocolError, StdioControlClient } from "../src/protocol";

let client: StdioControlClient | undefined;

afterEach(async () => {
	await client?.close();
	client = undefined;
});

describe("StdioControlClient", () => {
	it("negotiates protocol v1 and correlates out-of-order responses", async () => {
		client = new StdioControlClient(["bun", path.join(import.meta.dir, "fixtures/control-server.ts")]);
		const hello = await client.hello();
		expect(hello).toMatchObject({ protocol: "anima-control", version: 1, anima_version: "fixture" });

		const first = client.request<{ order: number }>("test.first", {}, { id: "first" });
		const second = client.request<{ order: number }>("test.second", {}, { id: "second" });
		expect(await second).toEqual({ order: 2 });
		expect(await first).toEqual({ order: 1 });
	});

	it("delivers invocation events without confusing response correlation", async () => {
		client = new StdioControlClient(["bun", path.join(import.meta.dir, "fixtures/control-server.ts")]);
		const events: string[] = [];
		client.onEvent(event => events.push(`${event.invocation_id}:${event.event.kind}`));
		expect(await client.request<{ delivered: boolean }>("test.event", {}, { id: "event-request" })).toEqual({
			delivered: true,
		});
		expect(events).toEqual(["in-fixture:generating"]);
	});

	it("preserves typed protocol failures", async () => {
		client = new StdioControlClient(["bun", path.join(import.meta.dir, "fixtures/control-server.ts")]);
		try {
			await client.request("test.missing", {}, { id: "missing" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ControlProtocolError);
			expect(error).toMatchObject({ code: "unknown_method", message: "test.missing", retryable: false });
		}
	});
});
