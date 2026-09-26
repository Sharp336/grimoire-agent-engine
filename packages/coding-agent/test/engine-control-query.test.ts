import { afterEach, describe, expect, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
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
import type { EngineBindingSnapshot } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import type { EngineCommandEnvelope } from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import type { EngineTransitionEvent } from "@oh-my-pi/pi-coding-agent/engine/store";
import { runtimeLimits, runtimeRemainingWork } from "@oh-my-pi/pi-coding-agent/engine/runtime-protocol";
import { coreMcpUrl, engineServiceStatus } from "@oh-my-pi/pi-coding-agent/engine/service";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { bindTestsToStorageWorker, storageWorkerUnavailable } from "./helpers/storage-worker-fixture";

describe.skipIf(storageWorkerUnavailable)("Engine Control + Query", () => {
	bindTestsToStorageWorker();
	let tempDir: string | undefined;

	/** Complete a running Attempt on a durable native transcript: the owner settles completion only with one. */
	async function completeNative(runtime: EngineRuntime, binding: EngineBindingSnapshot, event: EngineTransitionEvent) {
		const familyId = `family-${binding.attemptId}`;
		const client = runtime.store.storageClient;
		await client.write({
			operationId: `transcript-${binding.attemptId}`,
			familyId,
			generationId: "main",
			firstSeq: 1,
			entries: [
				{
					entryId: "leaf",
					parentId: null,
					kind: "message",
					payload: { type: "message", message: { role: "assistant", content: "done" } },
				},
			],
			durability: "required",
			dependencies: [],
		});
		await runtime.store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [event], {
			transcriptCheckpoint: {
				sessionId: familyId,
				sessionPath: `native:${familyId}/main`,
				leafEntryId: "leaf",
				byteBoundary: 0,
				native: { familyId, generationId: "main", throughSeq: 1, incarnation: client.incarnation },
			},
		});
	}

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("stages and removes message-owned attachment chunks through the authenticated native transport", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-upload-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		const server = await startEngineControlQueryServer({
			runtimeDir: tempDir,
			runtime,
			deviceId: "test-device",
			engineId: "test-engine",
			resolveLaunchProfile: async () => {
				throw new Error("Uploads must not launch a model");
			},
		});
		const client = new EngineControlQueryClient(tempDir);
		const bytes = Buffer.from("partial");
		const request = {
			principalId: "alice",
			uploadId: "wire-upload",
			clientMessageId: "message-a",
			name: "file.txt",
			mediaType: "text/plain",
			bytes: 100,
			contentHash: `sha256:${"0".repeat(64)}`,
			offset: 0,
			contentBase64: bytes.toString("base64"),
		};
		try {
			expect(await client.request("attachments.stage", request)).toMatchObject({
				complete: false,
				nextOffset: bytes.length,
			});
			expect(await client.request("attachments.stage", request)).toMatchObject({
				complete: false,
				nextOffset: bytes.length,
			});
			// Bun 1.4 Windows crashes in rejects.toThrow on this native transport path.
			await assert.rejects(client.request("attachments.stage", { ...request, principalId: "" }), /Invalid runtime/);
			await assert.rejects(
				client.request("attachments.stage", { ...request, sourcePath: "C:/private.txt" }),
				/Invalid runtime/,
			);
			expect(
				await client.request("attachments.remove", { principalId: "alice", uploadId: request.uploadId }),
			).toEqual({ removed: true });
			// Removal discards the staged bytes: the upload can only start over at offset zero.
			await assert.rejects(
				client.request("attachments.stage", { ...request, offset: bytes.length }),
				/offset zero/,
			);
			expect(await client.request("snapshots.list")).toMatchObject({ items: [] });
		} finally {
			await server.close();
			await runtime.dispose();
		}
	});

	it("serves authenticated durable commands and restart-safe oldest-first queries", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-control-query-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		// The owner projects Attempt events only for AgentInstances with a canonical ref, as every launch carries.
		for (const id of ["agent-a", "agent-b", "agent-failed", "agent-cancelled"])
			await runtime.store.registerAgent({
				agentInstanceId: id,
				agentInstanceRef: `grimoire://tasks/grimoire/control-query/agents/${id}`,
				authorityGeneration: 2,
			});
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
		await runtime.store.commitAttemptTransition(binding, "running", [], { requireNew: true });
		await runtime.store.appendEvent({
			...binding,
			causationCommandId: "trace-a",
			kind: "trace_reasoning",
			payload: { state: "completed", reasoning: "must-not-leak" },
		});
		const full = "x".repeat(ENGINE_CONTROL_QUERY_MAX_RESULT_CHARS + 20);
		await completeNative(runtime, binding, {
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
		await runtime.store.commitAttemptTransition(secondBinding, "running", [], { requireNew: true });
		await completeNative(runtime, secondBinding, {
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
			inputModalities: ["text", "image"],
		});
		expect(await client.request("models.reference", { modelIdentityId: "private-provider/custom-model" })).toEqual({
			status: "unknown",
			modelIdentityId: "private-provider/custom-model",
		});
		// Consumers must get the model's effort ladder, not just a saved profile's default.
		expect(
			await client.request("models.reference", {
				modelIds: ["gpt-5.6-sol", "deepseek-v4-flash", "private/custom", "gemini-3.1-pro-preview"],
			}),
		).toMatchObject({
			models: [
				{
					status: "resolved",
					reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
					inputModalities: ["text", "image"],
					reasoningOffApis: expect.arrayContaining([
						"openai-completions",
						"openai-responses",
						"openai-codex-responses",
					]),
				},
				{ status: "resolved", reasoningEfforts: ["low", "high", "max"] },
				{ status: "unknown", modelIdentityId: "private/custom" },
				{ status: "resolved", reasoningOffApis: [] },
			],
		});
		await expect(client.request("models.reference", { modelIds: Array(65).fill("gpt-5.6-sol") })).rejects.toThrow();
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
		// Archive, restore and reclaim routes stay addressable and refuse in native storage.
		for (const method of [
			"session.archive",
			"session.archive.verify",
			"session.archive.retire",
			"session.archive.restore",
			"session.restore.stage",
			"session.restore.history",
			"storage.reclaim",
		] as const) {
			expect(
				await client.request(method, { ...target, contentHash: `sha256:${"a".repeat(64)}` }).then(
					() => null,
					(error: unknown) => error,
				),
			).toMatchObject({ code: "invalid_request" });
		}
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
	}, 30_000);

	it("durably rejects an over-budget native branch control without applying partial intent or effects", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-control-budget-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		const agentInstanceRef = "grimoire://tasks/grimoire/control-budget/agents/root";
		await runtime.store.registerAgent({
			agentInstanceId: "budget-root",
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		const binding = {
			agentInstanceId: "budget-root",
			attemptId: "budget-attempt",
			executionId: "budget-execution",
			bindingId: "budget-binding",
			commandId: "budget-start",
			engineAgentId: "Engine-budget",
			profileDigest: "profile",
			state: "running" as const,
			engineGeneration: runtime.engineGeneration,
			authorityGeneration: 1,
			bindingGeneration: 1,
		};
		await runtime.store.commitAttemptTransition(binding, "running", [{ kind: "running" }]);
		for (let n = 1; n <= runtimeLimits.branchControlRecords; n++)
			await runtime.store.registerAgent({
				agentInstanceId: `budget-child-${n}`,
				agentInstanceRef: `grimoire://tasks/grimoire/control-budget/agents/child-${n}`,
				parentAgentInstanceId: "budget-root",
				principalId: "owner",
				authorityGeneration: 1,
			});
		let profileCalls = 0;
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir: tempDir,
			deviceId: "device",
			engineId: "engine",
			resolveLaunchProfile: async () => {
				profileCalls++;
				return { spawns: "", profileDigest: "profile" };
			},
		});
		try {
			const client = new EngineControlQueryClient(tempDir);
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: "pause-over-budget",
				op: "pause",
				deviceId: "device",
				engineId: "engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId: binding.agentInstanceId,
				agentInstanceRef,
				principalId: "owner",
				authorityGeneration: 1,
				runtimeBindingId: binding.bindingId,
				bindingGeneration: 1,
				attemptId: binding.attemptId,
				executionId: binding.executionId,
				issuedAt: Date.now(),
				payload: { expectedIntentRevision: 0, initiator: { kind: "human" } },
				browserPayloadHash: `sha256:${"a".repeat(64)}`,
				browserTarget: { agentInstanceRef, attemptId: binding.attemptId, executionId: binding.executionId },
			};
			const denied = await client.request("command", { command }).then(
				() => null,
				(error: unknown) => error,
			);
			expect(denied).toMatchObject({ code: "restore_budget" });
			expect(
				await client.request("runtime.command.get", { principalId: "owner", commandId: command.commandId }),
			).toMatchObject({
				stage: "rejected",
				lookup: "known",
				target: command.browserTarget,
				error: { code: "restore_budget" },
			});
			expect(await runtime.store.intent(binding.agentInstanceId)).toMatchObject({ intentRevision: 0 });
			expect(await runtime.store.intent("budget-child-1")).toMatchObject({ intentRevision: 0, holds: [] });
			expect(
				(await runtime.store.pendingEvents(1000)).filter(event => event.kind === "holds_changed"),
			).toHaveLength(0);
			expect(profileCalls).toBe(0);
			// A retry replays the durable rejection instead of applying the command.
			const retried = await client.request("command", { command }).then(
				() => null,
				(error: unknown) => error,
			);
			expect(retried).toMatchObject({ message: (denied as Error).message });
			expect(
				await client.request("runtime.command.get", { principalId: "owner", commandId: command.commandId }),
			).toMatchObject({ stage: "rejected", error: { code: "restore_budget" } });
			expect(await runtime.store.intent(binding.agentInstanceId)).toMatchObject({ intentRevision: 0 });
		} finally {
			await server.close();
			await runtime.dispose();
		}
	}, 120_000);
	it("serves an exact paused tool baseline through the native request validator", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-control-tools-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		const agentInstanceRef = "grimoire://tasks/grimoire/control-tools/agents/agent";
		await runtime.store.registerAgent({
			agentInstanceId: "control-tools",
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		const target = {
			agentInstanceId: "control-tools",
			attemptId: "tools-attempt",
			executionId: "tools-execution",
			bindingId: "tools-binding",
			commandId: "tools-start",
			engineAgentId: "Engine-tools",
			profileDigest: "profile",
			state: "running" as const,
			engineGeneration: runtime.engineGeneration,
			authorityGeneration: 1,
			bindingGeneration: 1,
		};
		await runtime.store.commitAttemptTransition(target, "paused", [{ kind: "paused" }]);
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir: tempDir,
			deviceId: "device",
			engineId: "engine",
			resolveLaunchProfile: async () => ({ spawns: "", profileDigest: "profile" }),
		});
		try {
			const client = new EngineControlQueryClient(tempDir);
			const request = { agentInstanceRef, attemptId: target.attemptId, principalId: "owner", limit: 16 };
			expect(await client.request("runtime.tools", request)).toMatchObject({
				version: "1.0",
				agentInstanceRef,
				attemptId: target.attemptId,
				revision: 0,
				items: [],
				nextCursor: null,
			});
			await runtime.store.startToolEffect(target, {
				effectId: "ipc-effect",
				toolCallId: "ipc-tool",
				toolName: "read",
				policy: "tracked",
				inputHash: "sha256:private",
			});
			expect(await client.request("runtime.tools", request)).toMatchObject({
				items: [{ toolCallId: "ipc-tool", phase: "started" }],
				nextCursor: null,
			});
			const denied = await client.request("runtime.tools", { ...request, principalId: "foreign" }).then(
				() => undefined,
				error => error,
			);
			expect(denied).toMatchObject({ code: "agent_not_found" });
		} finally {
			await server.close();
			await runtime.dispose();
		}
	});
	it("survives a native client disconnect while its durable response is ready to write", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-control-cancel-${Snowflake.next()}-`));
		const runtime = await EngineRuntime.create({ databasePath: path.join(tempDir, "engine.sqlite") });
		const agentInstanceRef = "grimoire://tasks/grimoire/control-cancel/agents/agent";
		await runtime.store.registerAgent({
			agentInstanceId: "control-cancel",
			agentInstanceRef,
			principalId: "owner",
			authorityGeneration: 1,
		});
		const server = await startEngineControlQueryServer({
			runtime,
			runtimeDir: tempDir,
			deviceId: "device",
			engineId: "engine",
			resolveLaunchProfile: async () => ({ spawns: "", profileDigest: "profile" }),
		});
		const token = fs.readFileSync(path.join(tempDir, "control-query.token"), "utf8").trim();
		const readSummary = runtime.store.runtimeSummary.bind(runtime.store);
		const client = new EngineControlQueryClient(tempDir);
		try {
			for (let round = 0; round < 12; round++) {
				const ready = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const query = spyOn(runtime.store, "runtimeSummary").mockImplementation(async request => {
					const result = await readSummary(request);
					ready.resolve();
					await release.promise;
					return result;
				});
				const socket = net.createConnection(server.endpoint);
				const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
				socket.on("error", () => socket.destroy());
				socket.once("connect", () => {
					socket.write(
						`${JSON.stringify({
							schema: "grimoire.engine.control_query.request.v1",
							version: "1.0",
							requestId: `cancel-${round}`,
							token,
							method: "runtime.summary",
							params: { agentInstanceRef, principalId: "owner" },
						})}\n`,
					);
				});
				try {
					await ready.promise;
					// The server has not seen the peer close yet when the read resumes.
					socket.destroy();
					release.resolve();
					await closed;
				} finally {
					release.resolve();
					socket.destroy();
					query.mockRestore();
				}
				expect(await client.request("runtime.summary", { agentInstanceRef, principalId: "owner" })).toMatchObject({
					summary: { agentInstanceRef },
				});
			}
			const snapshot = (await client.request("runtime.snapshot", {
				scope: { kind: "catalog" },
				principalId: "owner",
			})) as {
				epoch: string;
				watermark: number;
			};
			const waiting = Promise.withResolvers<void>();
			const waitEvents = runtime.store.waitRuntimeEvents.bind(runtime.store);
			const wait = spyOn(runtime.store, "waitRuntimeEvents").mockImplementation(async (request, signal) => {
				waiting.resolve();
				return await waitEvents(request, signal);
			});
			const observer = net.createConnection(server.endpoint);
			const closed = new Promise<void>(resolve => observer.once("close", () => resolve()));
			observer.on("error", () => observer.destroy());
			observer.once("connect", () =>
				observer.write(
					`${JSON.stringify({
						schema: "grimoire.engine.control_query.request.v1",
						version: "1.0",
						requestId: "pending-observer",
						token,
						method: "runtime.events.wait",
						params: {
							scope: { kind: "catalog" },
							principalId: "owner",
							epoch: snapshot.epoch,
							afterCursor: snapshot.watermark,
							timeoutMs: 25000,
							limit: 100,
							maxBytes: 61440,
							remainingWork: runtimeRemainingWork(),
						},
					})}\n`,
				),
			);
			try {
				await waiting.promise;
				const began = performance.now();
				await server.close();
				await closed;
				expect(performance.now() - began).toBeLessThan(1000);
			} finally {
				observer.destroy();
				wait.mockRestore();
			}
		} finally {
			await server.close();
			await runtime.dispose();
		}
	});

	it("publishes retention config and resolves the core endpoint", async () => {
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
