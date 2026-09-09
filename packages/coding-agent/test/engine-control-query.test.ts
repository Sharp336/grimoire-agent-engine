import { Database } from "bun:sqlite";
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
import { archiveChildHistory, coreMcpUrl, engineServiceStatus } from "@oh-my-pi/pi-coding-agent/engine/service";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("Engine Control + Query", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("reclaims actual database bytes and resyncs snapshot cursors without losing events or retained history", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-reclaim-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const runtime = await EngineRuntime.create({ databasePath });
		const server = await startEngineControlQueryServer({
			runtimeDir: tempDir,
			runtime,
			deviceId: "test-device",
			engineId: "test-engine",
			resolveLaunchProfile: async () => {
				throw new Error("No model launches in storage test");
			},
		});
		const client = new EngineControlQueryClient(tempDir);
		const kept = path.join(tempDir, "kept.jsonl");
		const removed = path.join(tempDir, "removed.jsonl");
		const content = `${JSON.stringify({ type: "session", id: "kept", version: 3 })}\n`;
		try {
			for (const id of ["a", "b"]) {
				const binding = {
					bindingId: `binding-${id}`,
					commandId: `start-${id}`,
					agentInstanceId: `agent-${id}`,
					executionId: `execution-${id}`,
					attemptId: `attempt-${id}`,
					engineAgentId: `Engine-${id}`,
					profileDigest: "test-profile",
					state: "idle" as const,
					engineGeneration: runtime.engineGeneration,
					bindingGeneration: 1,
					authorityGeneration: 1,
				};
				await runtime.store.putBinding(binding);
				await runtime.store.putAttempt(binding, "completed");
				await runtime.store.appendEvent({ ...binding, causationCommandId: `complete-${id}`, kind: "completed" });
			}
			await runtime.store.sessionStorage.writeTextAtomic(kept, content);
			await runtime.store.sessionStorage.writeTextAtomic(removed, content + "x".repeat(4 * 1024 * 1024));
			await runtime.store.sessionStorage.unlink(removed);
			await runtime.store.drain();
			const fileBytes = () =>
				fs.statSync(databasePath).size +
				(fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0);
			const before = fileBytes();
			const page = (await client.request("snapshots.list", { limit: 1 })) as { nextCursor: string };
			const events = (await client.request("events.list", { attemptId: "attempt-a" })) as { nextCursor: string };
			const identity = await runtime.store.getStoreEpoch();
			const result = await client.request("storage.reclaim");
			const after = fileBytes();
			expect(result).toEqual({
				schema: "grimoire.engine.storage_reclaim.v1",
				scope: "engine_database",
				status: "completed",
				beforeBytes: before,
				afterBytes: after,
				freedBytes: before - after,
			});
			expect(before - after).toBeGreaterThan(4 * 1024 * 1024);
			expect(await runtime.store.getStoreEpoch()).toBe(identity);
			expect(await runtime.store.sessionStorage.readText(kept)).toBe(content);
			expect(await client.request("snapshots.list", { cursor: page.nextCursor })).toMatchObject({
				resyncRequired: true,
				items: [],
			});
			expect(await client.request("snapshots.list")).toMatchObject({
				resyncRequired: false,
				items: [{ attemptId: "attempt-a" }, { attemptId: "attempt-b" }],
			});
			expect(
				await client.request("events.list", { attemptId: "attempt-a", cursor: events.nextCursor }),
			).toMatchObject({ resyncRequired: false });
			expect((await runtime.store.pendingEvents()).map(event => event.attemptId)).toEqual([
				"attempt-a",
				"attempt-b",
			]);
			const database = new Database(databasePath, { readonly: true });
			try {
				expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
			} finally {
				database.close();
			}
		} finally {
			await server.close();
			await runtime.dispose();
		}
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
		const secondBinding = {
			...binding,
			bindingId: "binding-b",
			commandId: "start-b",
			agentInstanceId: "agent-b",
			executionId: "execution-b",
			attemptId: "attempt-b",
			engineAgentId: "Engine-b",
			profileDigest: "profile-b",
		};
		await runtime.store.putBinding(secondBinding);
		await runtime.store.putAttempt(secondBinding, "completed");
		await runtime.store.appendEvent({
			...secondBinding,
			causationCommandId: "complete-b",
			kind: "completed",
			payload: { assistantFinal: "second" },
		});
		const failedBinding = {
			...binding,
			bindingId: "binding-failed",
			commandId: "start-failed",
			agentInstanceId: "agent-failed",
			executionId: "execution-failed",
			attemptId: "attempt-failed",
			engineAgentId: "Engine-11111111111111111111111111111111",
			profileDigest: "profile-failed",
		};
		await runtime.store.putBinding(failedBinding);
		await runtime.store.putAttempt(failedBinding, "running");
		const retryFailure =
			"Retry budget exhausted after 3 retries: Thinking loop detected: the model repeated near-identical content";
		await runtime.store.commitAttemptTransition(
			failedBinding,
			"failed",
			[{ kind: "failed", payload: { error: retryFailure } }],
			{
				cause: retryFailure,
				expectedStates: ["running"],
				transcriptCheckpoint: {
					sessionId: "session-failed",
					sessionPath: path.join(tempDir, "failed.jsonl"),
					leafEntryId: "leaf-failed",
					byteBoundary: 64,
				},
			},
		);
		const cancelledBinding = {
			...binding,
			bindingId: "binding-cancelled",
			commandId: "start-cancelled",
			agentInstanceId: "agent-cancelled",
			executionId: "execution-cancelled",
			attemptId: "attempt-cancelled",
			engineAgentId: "Engine-22222222222222222222222222222222",
			profileDigest: "profile-cancelled",
		};
		await runtime.store.putBinding(cancelledBinding);
		await runtime.store.putAttempt(cancelledBinding, "running");
		await runtime.store.commitAttemptTransition(
			cancelledBinding,
			"cancelled",
			[{ kind: "cancelled", payload: { reason: "user stop" } }],
			{
				cause: "user stop",
				expectedStates: ["running"],
				transcriptCheckpoint: {
					sessionId: "session-cancelled",
					sessionPath: path.join(tempDir, "cancelled.jsonl"),
					leafEntryId: "leaf-cancelled",
					byteBoundary: 32,
				},
			},
		);

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
				"models.reference",
				"session.context",
				"session.history",
				"session.restore.stage",
				"session.usage",
				"inbox.list",
				"inbox.enqueue",
				"inbox.mutate",
			]),
		});
		expect(await client.request("models.reference", { modelIdentityId: "gpt-5.6-terra" })).toMatchObject({
			status: "resolved",
			modelIdentityId: "gpt-5.6-terra",
			contextWindow: 1_050_000,
			maxOutputTokens: 128_000,
		});
		expect(await client.request("models.reference", { modelIdentityId: "private-provider/custom-model" })).toEqual({
			status: "unknown",
			modelIdentityId: "private-provider/custom-model",
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
		expect(await client.request("events.list", { attemptId: "attempt-b" })).toMatchObject({
			events: [{ attemptId: "attempt-b", kind: "completed" }],
			resyncRequired: false,
		});
		expect(await client.request("events.list", { attemptId: "attempt-b", cursor: first.nextCursor })).toMatchObject({
			resyncRequired: true,
			snapshot: { attemptId: "attempt-b", manualHold: false, intentRevision: 0 },
		});

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
		expect(await client.request("snapshots.get", { attemptId: "attempt-failed" })).toMatchObject({
			state: "failed",
			transcriptRef: "history://Engine-11111111111111111111111111111111",
		});
		expect(await client.request("result.get", { attemptId: "attempt-failed" })).toMatchObject({
			state: "failed",
			error: retryFailure,
			transcriptRef: "history://Engine-11111111111111111111111111111111",
		});
		expect(await client.request("result.get", { attemptId: "attempt-cancelled" })).toMatchObject({
			state: "cancelled",
			error: "attempt_cancelled",
			transcriptRef: "history://Engine-22222222222222222222222222222222",
		});

		await runtime.store.appendEvent({
			...binding,
			causationCommandId: "tool-trace-a",
			kind: "trace_tool",
			payload: {
				tool: {
					callId: "call-a",
					name: "bash",
					outcome: "ok",
					took: 45,
					args: "must-not-leak",
					output: "private-output",
				},
			},
		});
		const toolEvents = (await client.request("events.list", { attemptId: "attempt-a" })) as {
			events: Array<{ kind: string; payload: unknown }>;
		};
		expect(toolEvents.events.find(event => event.kind === "trace_tool")?.payload).toEqual({
			tool: { callId: "call-a", name: "bash", outcome: "ok", took: 45 },
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
		runtime.sessionHistory = async agentInstanceId => ({
			sessionId: `session-${agentInstanceId}`,
			leafEntryId: "entry-assistant",
			sessionLeafEntryId: "entry-hidden-canonical",
			entries: [
				{
					entryId: "entry-user",
					parentEntryId: null,
					role: "user",
					text: "question",
					createdAt: "2026-09-03T10:00:00Z",
					textTruncated: false,
				},
				{
					entryId: "entry-assistant",
					parentEntryId: "entry-user",
					role: "assistant",
					text: "answer",
					createdAt: "2026-09-03T10:01:00Z",
					textTruncated: false,
				},
			],
			activityCompleteness: "legacy_messages_only" as const,
		});
		runtime.sessionArchive = async (agentInstanceId, expectedContentHash, offset = 0, limit = 24_000) => ({
			schema: "grimoire.engine.session_archive.v1",
			agentInstanceId,
			sessionId: `session-${agentInstanceId}`,
			payloadSchema: "grimoire.engine.native_session_checkpoint.v1",
			contentHash: expectedContentHash ?? `sha256:${"a".repeat(64)}`,
			byteLength: 4,
			offset,
			nextOffset: null,
			contentBase64: Buffer.from("test")
				.subarray(offset, offset + limit)
				.toString("base64"),
		});
		let replaceRetainedBinding: boolean | undefined;
		runtime.sessionArchiveVerify = async (received, contentHash) => {
			expect(received).toEqual(target);
			expect(contentHash).toBe(`sha256:${"a".repeat(64)}`);
			return {
				schema: "grimoire.engine.session_archive_verification.v1",
				agentInstanceId: received.agentInstanceId,
				sessionId: "session-a",
				contentHash,
				byteLength: 4,
				sourceBytes: 3,
				sourceRetired: false,
				freedBytes: 0,
			};
		};
		runtime.sessionRestoreStage = async request => {
			replaceRetainedBinding = request.replaceRetainedBinding;
			return {
				restoreId: "b".repeat(64),
				contentHash: request.contentHash,
				totalBytes: request.totalBytes,
				nextOffset: request.offset + Buffer.from(request.contentBase64, "base64").byteLength,
				complete: true,
			};
		};
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
		let enqueuedCreatedAt: number | undefined;
		runtime.enqueueInbox = async (received, source) => {
			enqueuedCreatedAt = source.createdAt;
			return {
				item: {
					...(await runtime.listInbox(received))[0]!,
					queueId: "queue-user",
					sourceEventId: source.sourceEventId,
					sourceType: source.sourceType,
					sourceBody: source.body,
					deliveryPayload: source.body,
				},
				created: true,
			};
		};
		expect(await client.request("session.context", target)).toMatchObject({
			attemptId: "attempt-a",
			context: { usedTokens: 42 },
		});
		expect(await client.request("session.usage", target)).toMatchObject({
			provider: { status: "unavailable", reason: "provider_usage_not_supported" },
		});
		expect(
			await client.request("session.archive", {
				agentInstanceId: "agent-a",
				expectedContentHash: `sha256:${"a".repeat(64)}`,
				offset: 1,
				limit: 2,
			}),
		).toMatchObject({
			schema: "grimoire.engine.session_archive.v1",
			agentInstanceId: "agent-a",
			contentBase64: Buffer.from("es").toString("base64"),
		});
		expect(
			await client.request("session.restore.stage", {
				agentInstanceId: "agent-restored",
				agentInstanceRef: "grimoire://tasks/project/task/agents/agent-restored",
				authorityGeneration: 4,
				contentHash: `sha256:${"b".repeat(64)}`,
				totalBytes: 4,
				offset: 0,
				contentBase64: Buffer.from("test").toString("base64"),
				replaceRetainedBinding: true,
			}),
		).toMatchObject({ restoreId: "b".repeat(64), nextOffset: 4, complete: true });
		expect(replaceRetainedBinding).toBe(true);
		expect(
			await client.request("session.archive.verify", { ...target, contentHash: `sha256:${"a".repeat(64)}` }),
		).toMatchObject({ sourceBytes: 3, sourceRetired: false, freedBytes: 0 });
		await expect(
			client.request("session.archive.verify", {
				agentInstanceId: "agent-a",
				contentHash: `sha256:${"a".repeat(64)}`,
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		const restoreSelection = {
			agentInstanceId: "agent-restored",
			agentInstanceRef: "grimoire://tasks/project/task/agents/agent-restored",
			authorityGeneration: 4,
			restoreId: "b".repeat(64),
			contentHash: `sha256:${"b".repeat(64)}`,
			limit: 1,
		};
		const restoredPage = (await client.request("session.restore.history", restoreSelection)) as {
			previousCursor: string;
		};
		expect(restoredPage).toMatchObject({ entries: [{ entryId: "entry-assistant" }], hasMore: true });
		expect(
			await client.request("session.restore.history", {
				...restoreSelection,
				cursor: restoredPage.previousCursor,
			}),
		).toMatchObject({ entries: [{ entryId: "entry-user" }], hasMore: false });
		expect(
			await client.request("session.restore.history", {
				...restoreSelection,
				authorityGeneration: 5,
				cursor: restoredPage.previousCursor,
			}),
		).toMatchObject({ entries: [], resyncRequired: true });
		expect(
			await client.request("session.restore.history", {
				...restoreSelection,
				contentHash: `sha256:${"c".repeat(64)}`,
				cursor: restoredPage.previousCursor,
			}),
		).toMatchObject({ entries: [], resyncRequired: true });
		const newestHistory = (await client.request("session.history", {
			agentInstanceId: "agent-a",
			limit: 1,
		})) as {
			entries: Array<{ entryId: string }>;
			previousCursor: string;
			hasMore: boolean;
			sessionLeafEntryId: string;
		};
		expect(newestHistory).toMatchObject({
			entries: [{ entryId: "entry-assistant" }],
			leafEntryId: "entry-assistant",
			sessionLeafEntryId: "entry-hidden-canonical",
			hasMore: true,
			resyncRequired: false,
			activityCompleteness: "legacy_messages_only",
		});
		expect(
			await client.request("session.history", {
				agentInstanceId: "agent-a",
				cursor: newestHistory.previousCursor,
				limit: 1,
			}),
		).toMatchObject({
			entries: [{ entryId: "entry-user" }],
			sessionLeafEntryId: "entry-hidden-canonical",
			hasMore: false,
			resyncRequired: false,
		});
		expect(
			await client.request("session.history", {
				agentInstanceId: "agent-b",
				cursor: newestHistory.previousCursor,
			}),
		).toMatchObject({
			entries: [],
			sessionLeafEntryId: "entry-hidden-canonical",
			resyncRequired: true,
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
			}),
		).toMatchObject({
			created: true,
			item: { queueId: "queue-user", sourceType: "user", deliveryPayload: "queued while running" },
		});
		expect(enqueuedCreatedAt).toBeUndefined();
		expect(
			await client.request("inbox.enqueue", {
				...target,
				sourceEventId: "user-message-with-time",
				sourceType: "user",
				body: "queued with an explicit source time",
				createdAt: 10,
			}),
		).toMatchObject({ created: true });
		expect(enqueuedCreatedAt).toBe(10);
		// Settle named-pipe errors before Bun matchers can enter a nested event-loop poll.
		expect(
			await client
				.request("inbox.enqueue", {
					...target,
					sourceEventId: "user-message-invalid-time",
					sourceType: "user",
					body: "invalid enqueue time",
					createdAt: -1,
				})
				.then(
					() => null,
					(error: unknown) => error,
				),
		).toMatchObject({ code: "invalid_request" });
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
		expect(
			await client
				.request("inbox.mutate", {
					...target,
					mutationId: "mutation-invalid",
					queueId: "queue-a",
					expectedRevision: 2,
					op: "erase",
				})
				.then(
					() => null,
					(error: unknown) => error,
				),
		).toMatchObject({ code: "invalid_request" });

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
		expect(
			await client.request("command", { command: { ...command, payload: { changed: true } } }).then(
				() => null,
				(error: unknown) => error,
			),
		).toMatchObject({
			code: "command_id_conflict",
		});

		await server.close();
		await runtime.dispose();
	});

	it("publishes retention config and streams a temporary compressed archive through the core endpoint", async () => {
		for (const input of [
			"https://grimoire.example",
			"https://grimoire.example/mcp",
			"https://grimoire.example/mcp/client_agents",
			"https://grimoire.example/mcp/core",
		]) {
			expect(new URL(coreMcpUrl(input)).pathname).toBe("/mcp/core");
		}
		expect(
			engineServiceStatus(
				{
					deviceId: "device-a",
					engineId: "engine-a",
					runtimeDir: "C:\\runtime",
					databasePath: "C:\\runtime\\engine.sqlite",
					natsServerPath: "C:\\runtime\\nats-server.exe",
				},
				{ status: "running" },
			),
		).toMatchObject({ childHistoryTtlMinutes: 60, childHistoryRetention: "local" });
		expect(
			engineServiceStatus(
				{
					deviceId: "device-a",
					engineId: "engine-a",
					runtimeDir: "C:\\runtime",
					databasePath: "C:\\runtime\\engine.sqlite",
					natsServerPath: "C:\\runtime\\nats-server.exe",
					childHistoryTtlMinutes: 90,
					childHistoryRetention: "grimoire",
				},
				{ status: "running" },
			),
		).toMatchObject({ childHistoryTtlMinutes: 90, childHistoryRetention: "grimoire" });

		const content = '{"type":"session","id":"session-a"}\n';
		let imported: Record<string, unknown> | undefined;
		let sourcePath: string | undefined;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-history-archive-${Snowflake.next()}-`));
		const rpc = {
			call: async (method: string, params: Record<string, unknown>) => {
				expect(method).toBe("grimoire_artifact_import");
				imported = params;
				sourcePath = String(params.source_path);
				const bytes = fs.readFileSync(sourcePath);
				expect(Buffer.from(Bun.gunzipSync(bytes)).toString("utf8")).toBe(content);
				return {
					artifact: {
						artifact_ref: "gctx:archive",
						content_hash: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
						size_bytes: bytes.byteLength,
					},
				};
			},
		};
		await archiveChildHistory(rpc as never, tempDir, {
			agentInstanceId: "child-a",
			agentInstanceRef: "grimoire://tasks/grimoire/task-a/agents/child-a",
			attemptId: "attempt-a",
			terminalAt: Date.now(),
			content,
		});
		expect(imported?.content_base64).toBeUndefined();
		expect(sourcePath).toBeDefined();
		expect(fs.existsSync(sourcePath!)).toBeFalse();
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
