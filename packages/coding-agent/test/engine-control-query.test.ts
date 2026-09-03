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
		expect(capabilities).toMatchObject({
			commands: expect.arrayContaining(["compact", "release"]),
			queries: expect.arrayContaining([
				"session.context",
				"session.usage",
				"inbox.list",
				"inbox.enqueue",
				"inbox.mutate",
			]),
		});
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

		const target = {
			bindingId: binding.bindingId,
			agentInstanceId: binding.agentInstanceId,
			executionId: binding.executionId,
			attemptId: binding.attemptId,
			authorityGeneration: binding.authorityGeneration,
			engineGeneration: binding.engineGeneration,
			bindingGeneration: binding.bindingGeneration,
		};
		runtime.sessionContext = async received => ({
			schema: "grimoire.engine.session_context.v1",
			attemptId: received.attemptId,
			context: { usedTokens: 42 },
		});
		runtime.sessionUsage = async received => ({
			schema: "grimoire.engine.session_usage.v1",
			attemptId: received.attemptId,
			provider: { status: "unavailable", reason: "provider_usage_not_supported" },
		});
		runtime.listInbox = async received => [
			{
				queueId: "queue-a",
				sessionId: "session-a",
				agentInstanceId: received.agentInstanceId,
				attemptId: received.attemptId,
				sourceEventId: "source-a",
				sourceType: "user",
				sourceBody: "original",
				deliveryPayload: "edited",
				wakeIntent: false,
				position: 1024,
				disposition: "pending",
				revision: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		];
		runtime.mutateInbox = async (received, mutation) => ({
			...(await runtime.listInbox(received))[0]!,
			deliveryPayload: String(mutation.value),
			revision: mutation.expectedRevision + 1,
		});
		runtime.enqueueInbox = async (received, source) => ({
			item: {
				...(await runtime.listInbox(received))[0]!,
				queueId: "queue-user",
				sourceEventId: source.sourceEventId,
				sourceType: source.sourceType,
				sourceBody: source.body,
				deliveryPayload: source.body,
			},
			created: true,
		});
		expect(await client.request("session.context", target)).toMatchObject({
			attemptId: "attempt-a",
			context: { usedTokens: 42 },
		});
		expect(await client.request("session.usage", target)).toMatchObject({
			provider: { status: "unavailable", reason: "provider_usage_not_supported" },
		});
		expect(await client.request("inbox.list", target)).toMatchObject({
			items: [{ queueId: "queue-a", sourceType: "user", deliveryPayload: "edited" }],
		});
		expect(
			await client.request("inbox.enqueue", {
				...target,
				sourceEventId: "user-message-a",
				sourceType: "user",
				body: "queued while running",
				createdAt: 10,
			}),
		).toMatchObject({
			created: true,
			item: { queueId: "queue-user", sourceType: "user", deliveryPayload: "queued while running" },
		});
		expect(
			await client.request("inbox.mutate", {
				...target,
				mutationId: "mutation-a",
				queueId: "queue-a",
				expectedRevision: 2,
				op: "edit",
				value: "new delivery",
			}),
		).toMatchObject({ queueId: "queue-a", deliveryPayload: "new delivery", revision: 3 });
		await expect(
			client.request("inbox.mutate", {
				...target,
				mutationId: "mutation-invalid",
				queueId: "queue-a",
				expectedRevision: 2,
				op: "erase",
			}),
		).rejects.toMatchObject({ code: "invalid_request" });

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
		runtime.compact = async received => ({
			schema: "grimoire.engine.session_compaction.v1",
			attemptId: received.attemptId,
			tokensBefore: 42,
			tokensAfter: 12,
		});
		const compactCommand: EngineCommandEnvelope = {
			...command,
			commandId: "compact-a",
			op: "compact",
			deviceId: "device-a",
			engineId: "engine-a",
			runtimeBindingId: target.bindingId,
			bindingGeneration: target.bindingGeneration,
			executionId: target.executionId,
			attemptId: target.attemptId,
			issuedAt: Date.now(),
			payload: {},
		};
		expect(await client.request("command", { command: compactCommand })).toMatchObject({
			outcome: "applied",
			detail: { attemptId: "attempt-a", tokensBefore: 42, tokensAfter: 12 },
		});
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
		const requestCli = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../src/cli.ts"),
				"engine",
				"request",
				"--runtime-dir",
				tempDir,
				"--method",
				"session.context",
				"--params",
				JSON.stringify(target),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await requestCli.exited).toBe(0);
		expect(JSON.parse(await new Response(requestCli.stdout).text())).toMatchObject({ attemptId: "attempt-a" });
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
