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
		expect(hello).toMatchObject({
			protocol: "anima-control",
			version: 1,
			anima_version: "fixture",
			owner: "external:omp:fixture",
			mailbox: "omp-fixture-Main",
		});

		const first = client.request<{ order: number }>("test.first", {}, { id: "first" });
		const second = client.request<{ order: number }>("test.second", {}, { id: "second" });
		expect(await second).toEqual({ order: 2 });
		expect(await first).toEqual({ order: 1 });
	});

	it("rejects duplicate pending IDs without corrupting response correlation", async () => {
		client = new StdioControlClient(["bun", path.join(import.meta.dir, "fixtures/control-server.ts")]);
		await client.hello();
		const first = client.request<{ order: number }>("test.first", {}, { id: "shared-id" });
		await expect(client.request("test.first", {}, { id: "shared-id" })).rejects.toMatchObject({
			code: "duplicate_request",
		});
		expect(await client.request<{ order: number }>("test.second", {}, { id: "flush" })).toEqual({ order: 2 });
		expect(await first).toEqual({ order: 1 });
		expect(await client.request<{ delivered: boolean }>("test.event", {}, { id: "shared-id" })).toEqual({
			delivered: true,
		});
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

	it("rejects oversized outbound frames before writing and leaves the request ID reusable", async () => {
		client = new StdioControlClient([
			"bun",
			path.join(import.meta.dir, "fixtures/control-server.ts"),
			"--max-line-bytes=512",
		]);
		await client.hello();
		await expect(
			client.request("test.event", { body: "x".repeat(512) }, { id: "bounded-frame" }),
		).rejects.toMatchObject({
			code: "line_too_large",
			message: "Control request exceeds 512 bytes",
		});
		expect(await client.request<{ delivered: boolean }>("test.event", {}, { id: "bounded-frame" })).toEqual({
			delivered: true,
		});
	});

	it("tears down an oversized inbound frame and renegotiates on a clean sidecar", async () => {
		client = new StdioControlClient(["bun", path.join(import.meta.dir, "fixtures/control-server.ts")]);
		await expect(client.request("test.oversized", {}, { id: "oversized-response" })).rejects.toMatchObject({
			code: "line_too_large",
		});
		expect(await client.request<{ delivered: boolean }>("test.event", {}, { id: "after-oversized" })).toEqual({
			delivered: true,
		});
	});

	it("renegotiates before requests after the sidecar exits", async () => {
		client = new StdioControlClient([
			"bun",
			path.join(import.meta.dir, "fixtures/control-server.ts"),
			"--report-pid",
		]);
		const firstPID = Number((await client.hello()).anima_version);
		await expect(client.request("test.crash", {}, { id: "crash" })).rejects.toMatchObject({
			code: expect.stringMatching(/^transport_/),
		});
		const secondPID = Number((await client.hello()).anima_version);
		expect(secondPID).not.toBe(firstPID);
		expect(await client.request<{ delivered: boolean }>("test.event", {}, { id: "after-restart" })).toEqual({
			delivered: true,
		});
	});

	it("tears down and renegotiates after malformed stdout", async () => {
		client = new StdioControlClient([
			"bun",
			path.join(import.meta.dir, "fixtures/control-server.ts"),
			"--report-pid",
		]);
		const firstPID = Number((await client.hello()).anima_version);
		await expect(client.request("test.invalid", {}, { id: "invalid" })).rejects.toMatchObject({
			code: "invalid_response",
		});
		const secondPID = Number((await client.hello()).anima_version);
		expect(secondPID).not.toBe(firstPID);
	});

	it("rejects a control server without durable invocation messaging", async () => {
		client = new StdioControlClient([
			"bun",
			path.join(import.meta.dir, "fixtures/control-server.ts"),
			"--omit-message",
		]);
		expect(client.hello()).rejects.toMatchObject({
			code: "missing_method",
			message: "Anima control is missing required methods: invoke.message",
		});
	});

	it("force-terminates a sidecar that ignores stdin EOF", async () => {
		client = new StdioControlClient(
			["bun", path.join(import.meta.dir, "fixtures/control-server.ts"), "--ignore-eof", "--report-pid"],
			20,
		);
		const hello = await client.hello();
		const pid = Number(hello.anima_version);
		expect(Number.isInteger(pid)).toBe(true);
		const startedAt = Date.now();
		await client.close();
		client = undefined;

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
