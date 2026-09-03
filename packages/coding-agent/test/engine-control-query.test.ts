import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES,
	ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS,
	EngineControlQueryClient,
	startEngineControlQueryServer,
} from "@oh-my-pi/pi-coding-agent/engine/control-query";
import type { EngineCommandEnvelope } from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("Engine Control + Query", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("serves authenticated durable commands and restart-safe oldest-first queries", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-control-query-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		const binding = {
			bindingId: "binding-a",
			commandId: "start-a",
			agentInstanceId: "agent-a",
			executionId: "execution-a",
			attemptId: "attempt-a",
			engineAgentId: "Engine-a",
			profileDigest: "profile-a",
			state: "idle" as const,
			engineGeneration: runtime.engineGeneration,
			bindingGeneration: 1,
			authorityGeneration: 2,
		};
		await runtime.store.putBinding(binding);
		await runtime.store.putAttempt(binding, "completed");
		await runtime.store.appendEvent({
			...binding,
			causationCommandId: "trace-a",
			kind: "trace_reasoning",
			payload: { state: "completed", reasoning: "must-not-leak" },
		});
		const full = "x".repeat(ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS + 20);
		await runtime.store.appendEvent({
			...binding,
			causationCommandId: "complete-a",
			kind: "completed",
			payload: { assistantFinal: full, transcriptRef: "history://Engine-a" },
		});

		const options = {
			runtime,
			runtimeDir: tempDir,
			deviceId: "device-a",
			engineId: "engine-a",
			resolveLaunchProfile: async () => ({ spawns: "", profileDigest: "profile-a" }) as const,
		};
		let server = await startEngineControlQueryServer(options);
		const client = new EngineControlQueryClient(tempDir);
		const capabilities = (await client.request("capabilities")) as Record<string, unknown>;
		expect(capabilities).toMatchObject({ contractVersion: "1.0", rawDiagnostics: false });
		expect(
			await rawRequest(
				server.endpoint,
				`${JSON.stringify({
					schema: "grimoire.engine.control_query.request.v1",
					version: "1.0",
					requestId: "bad-token",
					token: "wrong",
					method: "capabilities",
				})}\n`,
			),
		).toMatchObject({ ok: false, error: { code: "unauthorized" } });
		expect(await rawRequest(server.endpoint, "x".repeat(ENGINE_CONTROL_QUERY_MAX_FRAME_BYTES + 1))).toMatchObject({
			ok: false,
			error: { code: "frame_too_large" },
		});

		const first = (await client.request("events.list", { attemptId: "attempt-a", limit: 1 })) as {
			events: Array<{ payload: Record<string, unknown> }>;
			nextCursor: string;
			hasMore: boolean;
		};
		expect(first.events[0]?.payload).toEqual({ state: "completed" });
		expect(first.hasMore).toBeTrue();
		const second = (await client.request("events.list", {
			attemptId: "attempt-a",
			cursor: first.nextCursor,
			limit: 1,
		})) as { events: Array<{ kind: string }>; hasMore: boolean };
		expect(second.events.map(event => event.kind)).toEqual(["completed"]);
		expect(second.hasMore).toBeFalse();

		const forgedCursor = Buffer.from(
			JSON.stringify({ kind: "events", epoch: capabilities.storeEpoch, position: 99_999 }),
		).toString("base64url");
		expect(await client.request("events.list", { attemptId: "attempt-a", cursor: forgedCursor })).toMatchObject({
			resyncRequired: true,
			snapshot: { attemptId: "attempt-a" },
		});
		expect(await client.request("result.get", { attemptId: "attempt-a" })).toMatchObject({
			state: "completed",
			assistantText: "x".repeat(ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS),
			outputTruncated: true,
		});

		const command: EngineCommandEnvelope = {
			schema: "grimoire.engine.command.v1",
			commandId: "reconcile-a",
			op: "reconcile",
			deviceId: "device-a",
			engineId: "engine-a",
			engineGeneration: runtime.engineGeneration,
			agentInstanceId: "agent-a",
			authorityGeneration: 2,
			issuedAt: Date.now(),
			payload: {},
		};
		expect(await client.request("command", { command })).toEqual({ outcome: "applied" });
		const cli = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../src/cli.ts"),
				"engine",
				"capabilities",
				"--runtime-dir",
				tempDir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await cli.exited).toBe(0);
		expect(JSON.parse(await new Response(cli.stdout).text())).toMatchObject({ contractVersion: "1.0" });
		await server.close();
		server = await startEngineControlQueryServer(options);
		expect(await client.request("command", { command })).toEqual({ outcome: "applied" });
		await expect(
			client.request("command", { command: { ...command, payload: { changed: true } } }),
		).rejects.toMatchObject({
			code: "command_id_conflict",
		});

		await server.close();
		await runtime.dispose();
	});
});

function rawRequest(endpoint: string, body: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(endpoint);
		let data = "";
		socket.once("error", reject);
		socket.once("connect", () => socket.write(body));
		socket.on("data", chunk => {
			data += chunk.toString();
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			socket.end();
			resolve(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
		});
	});
}
