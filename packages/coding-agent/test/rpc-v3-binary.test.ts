import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

describe("RPC v3 real process conformance", () => {
	test("negotiates authority, snapshots, invokes, and settles with the final frame", async () => {
		const binaryPath = Bun.env.OMP_RPC_CONFORMANCE_BIN;
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const command = binaryPath
			? [binaryPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"]
			: ["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];
		const child = Bun.spawn(command, {
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const commands = [
			{
				id: "initialize-1",
				type: "initialize",
				profile: { name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 },
				framingVersion: 1,
				hostCapabilities: { interactions: [], semanticContent: [] },
				requestedCapabilities: ["session.observe", "session.execute", "session.shutdown"],
			},
			{ id: "open-1", type: "session_open", snapshot: true },
			{
				id: "invoke-1",
				type: "session_invoke",
				command: {
					kind: "set_follow_up_mode",
					input: { mode: "one-at-a-time" },
					idempotencyKey: "binary-conformance-1",
				},
			},
			{ id: "new-session-1", type: "new_session" },
			{ id: "open-2", type: "session_open", snapshot: true },
			{ id: "shutdown-1", type: "session_shutdown" },
		];
		const frames: Record<string, unknown>[] = [];

		try {
			for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
			await child.stdin.flush();

			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (isRecord(frame)) frames.push(frame);
			}
			const exitCode = await child.exited;
			const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
			expect(exitCode, stderr).toBe(0);
		} finally {
			child.kill();
			await child.exited.catch(() => {});
		}

		const response = (id: string) => frames.find(frame => frame.type === "response" && frame.id === id);
		const initialization = response("initialize-1");
		expect(initialization).toMatchObject({
			type: "response",
			command: "initialize",
			success: true,
			data: {
				ok: true,
				profile: { name: "omp.session", major: 3, minor: 0 },
			},
		});
		const negotiatedCapabilities = Reflect.get(Reflect.get(initialization ?? {}, "data") ?? {}, "capabilities");
		expect(negotiatedCapabilities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "session.observe", supported: true }),
				expect.objectContaining({ id: "session.execute", supported: true }),
				expect.objectContaining({ id: "session.shutdown", supported: true }),
			]),
		);

		const firstOpen = response("open-1");
		expect(firstOpen).toMatchObject({
			success: true,
			data: {
				subscriptionId: expect.any(String),
				snapshot: {
					sessionId: expect.any(String),
					revision: expect.any(Number),
					watermark: { epoch: expect.any(String), sequence: expect.any(Number) },
				},
			},
		});
		expect(response("invoke-1")).toMatchObject({
			success: true,
			data: { outcome: "completed", revision: expect.any(Number) },
		});
		expect(response("new-session-1")).toMatchObject({
			success: true,
			data: { cancelled: false },
		});
		const secondOpen = response("open-2");
		expect(secondOpen).toMatchObject({
			success: true,
			data: {
				subscriptionId: expect.any(String),
				snapshot: {
					sessionId: expect.any(String),
					watermark: { epoch: expect.any(String), sequence: expect.any(Number) },
				},
			},
		});
		const firstSnapshot = Reflect.get(Reflect.get(firstOpen ?? {}, "data") ?? {}, "snapshot");
		const secondSnapshot = Reflect.get(Reflect.get(secondOpen ?? {}, "data") ?? {}, "snapshot");
		expect(Reflect.get(firstSnapshot, "sessionId")).not.toBe(Reflect.get(secondSnapshot, "sessionId"));
		expect(Reflect.get(Reflect.get(firstSnapshot, "watermark"), "epoch")).not.toBe(
			Reflect.get(Reflect.get(secondSnapshot, "watermark"), "epoch"),
		);
		expect(frames.at(-1)).toMatchObject({
			id: "shutdown-1",
			type: "response",
			command: "session_shutdown",
			success: true,
			data: { state: "settled" },
		});
	}, 30_000);
});
