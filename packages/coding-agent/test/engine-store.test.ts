import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import {
	EngineAttemptConflictError,
	EngineCommandConflictError,
	type EngineCommandIdentity,
	EngineEffectConflictError,
	EngineInboxConflictError,
	EngineStore,
} from "@oh-my-pi/pi-coding-agent/engine/store";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

describe("EngineStore", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = undefined;
	});

	it("persists route state with the full Attempt fence and never lends it to another Attempt", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-route-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const binding = {
			bindingId: "binding-route",
			commandId: "command-route",
			agentInstanceId: "agent-route",
			executionId: "execution-route",
			attemptId: "attempt-route",
			engineAgentId: "Engine-route",
			profileDigest: "profile-route",
			state: "running" as const,
			engineGeneration: 1,
			bindingGeneration: 2,
			authorityGeneration: 3,
		};
		const state = {
			profileRef: "gctx:2222222222222222",
			primaryRouteRef: "gctx:3333333333333333",
			routeRef: "gctx:4444444444444444",
			fallback: true,
			phase: "active" as const,
		};
		try {
			await store.putBinding(binding);
			await store.putAttempt(binding, "running");
			for (const mismatch of [
				{ attemptId: "wrong" },
				{ agentInstanceId: "wrong" },
				{ executionId: "wrong" },
				{ bindingId: "wrong" },
				{ engineGeneration: 9 },
				{ bindingGeneration: 9 },
				{ authorityGeneration: 9 },
			]) {
				expect(await store.commitAttemptProfileRoute({ ...binding, ...mismatch }, state)).toBeUndefined();
			}
			expect(await store.pendingEvents()).toEqual([]);
			expect(await store.commitAttemptProfileRoute(binding, state)).toMatchObject({
				kind: "profile_route_changed",
				attemptId: binding.attemptId,
				payload: { profileRoute: state },
			});
			await store.putAttempt(binding, "completed");
			expect(await store.commitAttemptProfileRoute(binding, { ...state, phase: "exhausted" })).toBeUndefined();
			await store.putAttempt({ ...binding, attemptId: "next-attempt", executionId: "next-execution" }, "accepted");
			expect((await store.getAttempt("next-attempt"))?.profile_route_state).toBeNull();
		} finally {
			await store.close();
		}
		const reopened = await EngineStore.open(databasePath);
		try {
			expect(JSON.parse((await reopened.getAttempt(binding.attemptId))!.profile_route_state!)).toEqual(state);
			expect(
				(await reopened.listAttempts()).find(attempt => attempt.attempt_id === binding.attemptId)
					?.profile_route_state,
			).toBe(JSON.stringify(state));
			expect((await reopened.pendingEvents()).filter(event => event.kind === "profile_route_changed")).toHaveLength(
				1,
			);
		} finally {
			await reopened.close();
		}
	});

	it("reconciles unfinished attempts from an earlier engine generation", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const first = await EngineStore.open(databasePath);
		const generation = await first.nextEngineGeneration();
		const binding = {
			bindingId: "binding-1",
			commandId: "command-1",
			agentInstanceId: "agent-1",
			executionId: "execution-1",
			attemptId: "attempt-1",
			engineAgentId: "Engine-1",
			profileDigest: "profile-1",
			state: "running" as const,
			engineGeneration: generation,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await first.putBinding(binding);
		await first.putAttempt(binding, "running");
		const retry = {
			attempt: 2,
			maxAttempts: 3,
			route: "anthropic/claude-test",
			delayMs: 15_000,
			scheduledAt: Date.now() + 15_000,
			outcome: "waiting" as const,
			error: "503 overloaded",
		};
		await first.commitAttemptRetry(binding, retry, { kind: "retry_scheduled", payload: { retry } });
		await first.startToolEffect(binding, {
			effectId: "effect-a-started",
			toolCallId: "tool-a-started",
			toolName: "write",
			policy: "unrestricted",
			inputHash: "sha256:started",
		});
		await first.requestToolApproval(binding, {
			effectId: "effect-b-pending",
			toolCallId: "tool-b-pending",
			toolName: "bash",
			policy: "permit",
			inputHash: "sha256:pending",
		});
		await first.startModelEffect(binding, {
			effectId: "effect-c-model",
			modelCallId: "model-1",
			inputHash: "sha256:model",
		});
		await first.close();

		const runtime = await EngineRuntime.create({ databasePath });
		expect(runtime.engineGeneration).toBe(generation + 1);
		expect((await runtime.store.getBinding("agent-1"))?.state).toBe("released");
		const events = await runtime.store.pendingEvents();
		expect(events.map(event => event.kind)).toEqual([
			"retry_scheduled",
			"tool_started",
			"tool_approval_requested",
			"model_started",
			"tool_settled",
			"tool_approval_resolved",
			"tool_settled",
			"model_settled",
			"interrupted",
		]);
		expect(events.at(-1)?.engineGeneration).toBe(runtime.engineGeneration);
		expect(events.at(-1)?.payload).toEqual({
			cause: "engine_lost",
			error: "engine_lost",
			lostEngineGeneration: generation,
		});
		expect(await runtime.store.getAttempt("attempt-1")).toMatchObject({
			retry_attempt: 2,
			retry_max_attempts: 3,
			retry_route: "anthropic/claude-test",
			retry_delay_ms: 15_000,
			retry_outcome: "interrupted",
			retry_error: "503 overloaded",
		});
		expect(await runtime.store.getEffect("effect-a-started")).toMatchObject({
			state: "unknown",
			outcome: "unknown",
		});
		expect(await runtime.store.getEffect("effect-b-pending")).toMatchObject({
			state: "settled",
			outcome: "cancelled",
		});
		expect(await runtime.store.getApproval("effect-b-pending")).toMatchObject({
			state: "resolved",
			decision: "cancelled",
		});
		expect(await runtime.store.getEffect("effect-c-model")).toMatchObject({
			effect_kind: "model",
			state: "unknown",
			outcome: "unknown",
		});
		await runtime.dispose();

		const restarted = await EngineRuntime.create({ databasePath });
		expect(restarted.engineGeneration).toBe(generation + 2);
		expect((await restarted.store.pendingEvents()).map(event => event.eventId)).toEqual(
			events.map(event => event.eventId),
		);
		await restarted.dispose();
	});

	it("upgrades a legacy Engine database once and rejects changed migration history", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-migrate-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const legacy = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await legacy.unsafe(`CREATE TABLE engine_runtime_bindings (
			binding_id TEXT PRIMARY KEY,
			agent_instance_id TEXT NOT NULL UNIQUE,
			execution_id TEXT NOT NULL,
			attempt_id TEXT NOT NULL,
			engine_agent_id TEXT NOT NULL,
			session_file TEXT,
			profile_digest TEXT NOT NULL,
			state TEXT NOT NULL,
			engine_generation INTEGER NOT NULL,
			binding_generation INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		await legacy.unsafe(
			"CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL)",
		);
		await legacy.unsafe("INSERT INTO omp_session_files(path, content, mtime_ms) VALUES (?, ?, ?)", [
			"legacy-session.jsonl",
			'{"type":"session"}\n',
			1,
		]);
		await legacy.end();

		const store = await EngineStore.open(databasePath);
		expect(await store.sessionStorage.readText("legacy-session.jsonl")).toBe('{"type":"session"}\n');
		await store.putBinding({
			bindingId: "binding-migrated",
			commandId: "command-migrated",
			agentInstanceId: "agent-migrated",
			executionId: "execution-migrated",
			attemptId: "attempt-migrated",
			engineAgentId: "Engine-migrated",
			profileDigest: "profile-migrated",
			state: "running",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 7,
			manualHold: true,
			intentRevision: 4,
			intentCommandId: "pause-before-migration-reopen",
		});
		expect(await store.getBinding("agent-migrated")).toMatchObject({
			commandId: "command-migrated",
			authorityGeneration: 7,
			manualHold: true,
			intentRevision: 4,
			intentCommandId: "pause-before-migration-reopen",
		});
		await store.close();
		const reopened = await EngineStore.open(databasePath);
		expect(await reopened.getBinding("agent-migrated")).toMatchObject({
			attemptId: "attempt-migrated",
			manualHold: true,
			intentRevision: 4,
		});
		await reopened.close();

		const tamper = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await tamper.unsafe("UPDATE engine_schema_migrations SET checksum='changed' WHERE version=1");
		await tamper.end();
		await expect(EngineStore.open(databasePath)).rejects.toThrow("migration 1 checksum does not match");
	});

	it("upgrades the exact schema v10 migration prefix without rewriting its checksums", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-v10-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const fixture = new Database(databasePath, { create: true });
		fixture.exec(fs.readFileSync(path.join(import.meta.dir, "fixtures", "engine-schema-v10.sql"), "utf8"));
		const prefix = fixture
			.query("SELECT version, checksum FROM engine_schema_migrations ORDER BY version")
			.all() as Array<{ version: number; checksum: string }>;
		expect(prefix).toHaveLength(10);
		expect(
			fixture
				.query("SELECT name FROM pragma_table_info('engine_runtime_bindings') WHERE name=?")
				.get("conversation_identity_digest"),
		).toBeNull();
		fixture.close();

		const upgraded = await EngineStore.open(databasePath);
		await upgraded.close();
		const inspect = new Database(databasePath, { readonly: true });
		expect(
			inspect
				.query("SELECT version, checksum FROM engine_schema_migrations WHERE version<=10 ORDER BY version")
				.all(),
		).toEqual(prefix);
		expect(inspect.query("SELECT version FROM engine_schema_migrations WHERE version=11").get()).toEqual({
			version: 11,
		});
		expect(inspect.query("SELECT version FROM engine_schema_migrations WHERE version=12").get()).toEqual({
			version: 12,
		});
		expect(
			inspect.query("SELECT name FROM pragma_table_info('engine_attempts') WHERE name=?").get("profile_route_state"),
		).toEqual({ name: "profile_route_state" });
		expect(
			inspect
				.query("SELECT name FROM pragma_table_info('engine_runtime_bindings') WHERE name=?")
				.get("conversation_identity_digest"),
		).toEqual({ name: "conversation_identity_digest" });
		inspect.close();
	});

	it("rejects a database created by a newer Engine schema", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-newer-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const newer = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await newer.unsafe(
			"CREATE TABLE engine_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
		);
		await newer.unsafe(
			"INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (999, 'future', ?)",
			[Date.now()],
		);
		await newer.end();
		await expect(EngineStore.open(databasePath)).rejects.toThrow("schema is newer than this binary");
	});

	it("rolls back a migration that cannot apply cleanly", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-rollback-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const incompatible = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await incompatible.unsafe("CREATE VIEW engine_attempts AS SELECT 1 AS incompatible");
		await incompatible.end();

		await expect(EngineStore.open(databasePath)).rejects.toThrow();
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		const rows = (await inspect.unsafe(
			"SELECT name FROM sqlite_master WHERE name IN ('engine_schema_migrations', 'engine_metadata') ORDER BY name",
		)) as Array<{ name: string }>;
		await inspect.end();
		expect(rows).toEqual([]);
	});

	it("persists command receipts and rejects command ID reuse with different content", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-command-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const command: EngineCommandIdentity = {
			commandId: "command-1",
			operation: "steer",
			deviceId: "device-1",
			engineId: "engine-1",
			engineGeneration: 1,
			agentInstanceId: "agent-1",
			bindingId: "binding-1",
			bindingGeneration: 1,
			executionId: "execution-1",
			attemptId: "attempt-1",
			authorityGeneration: 1,
			payloadHash: "sha256:payload-1",
			canonicalHash: "sha256:canonical-1",
		};
		const store = await EngineStore.open(databasePath);
		expect(await store.admitCommand(command, 1)).toEqual({ status: "claimed" });
		expect(await store.admitCommand(command, 1)).toEqual({ status: "in_progress" });
		await store.releaseCommand(command.commandId, command.canonicalHash, 1);
		expect(await store.admitCommand(command, 1)).toEqual({ status: "claimed" });
		await store.settleCommand(command.commandId, command.canonicalHash, {
			outcome: "applied",
			detail: { eventId: "17" },
		});
		await store.close();

		const reopened = await EngineStore.open(databasePath);
		expect(await reopened.admitCommand(command, 2)).toEqual({
			status: "replay",
			receipt: { outcome: "applied", detail: { eventId: "17" } },
		});
		const pending = { ...command, commandId: "command-pending", canonicalHash: "sha256:pending" };
		expect(await reopened.admitCommand(pending, 1)).toEqual({ status: "claimed" });
		await reopened.close();

		const restarted = await EngineStore.open(databasePath);
		expect(await restarted.admitCommand(pending, 2)).toEqual({ status: "claimed" });
		await expect(
			restarted.admitCommand(
				{ ...command, payloadHash: "sha256:payload-2", canonicalHash: "sha256:canonical-2" },
				2,
			),
		).rejects.toBeInstanceOf(EngineCommandConflictError);
		await restarted.close();
	});

	it("keeps immutable inbox facts and fenced mutable order across restart", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-inbox-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const target = {
			sessionId: "session-inbox",
			bindingId: "binding-inbox",
			agentInstanceId: "agent-inbox",
			executionId: "execution-inbox",
			attemptId: "attempt-inbox",
			authorityGeneration: 4,
			engineGeneration: 7,
			bindingGeneration: 2,
		};
		const firstSource = {
			sourceEventId: "message-1",
			sourceType: "agent" as const,
			sender: "agent-sender",
			body: "original immutable body",
		};
		const concurrent = await Promise.all(
			Array.from({ length: 8 }, () => store.enqueueInboxItem(target, firstSource)),
		);
		expect(concurrent.filter(result => result.created)).toHaveLength(1);
		const first = concurrent.find(result => result.created)!;
		expect(first).toMatchObject({ item: { queueId: "message-1", revision: 1 } });
		expect(new Set(concurrent.map(result => result.item.createdAt))).toEqual(new Set([first.item.createdAt]));
		expect(await store.enqueueInboxItem(target, firstSource)).toMatchObject({
			created: false,
			item: { createdAt: first.item.createdAt },
		});
		await expect(store.enqueueInboxItem(target, { ...firstSource, body: "changed source" })).rejects.toBeInstanceOf(
			EngineInboxConflictError,
		);
		await expect(
			store.enqueueInboxItem(target, { ...firstSource, createdAt: Date.now() + 60_000 }),
		).rejects.toBeInstanceOf(EngineInboxConflictError);
		await expect(store.enqueueInboxItem(target, { ...firstSource, createdAt: -1 })).rejects.toBeInstanceOf(
			EngineInboxConflictError,
		);
		await expect(
			store.enqueueInboxItem({ ...target, authorityGeneration: target.authorityGeneration + 1 }, firstSource),
		).rejects.toBeInstanceOf(EngineInboxConflictError);

		const edited = await store.mutateInboxItem(target, {
			mutationId: "edit-1",
			queueId: "message-1",
			expectedRevision: 1,
			op: "edit",
			value: "edited delivery only",
		});
		expect(edited).toMatchObject({
			sourceBody: "original immutable body",
			deliveryPayload: "edited delivery only",
			revision: 2,
		});
		expect(
			await store.mutateInboxItem(target, {
				mutationId: "edit-retry",
				queueId: "message-1",
				expectedRevision: 1,
				op: "edit",
				value: "edited delivery only",
			}),
		).toMatchObject({ revision: 2 });
		const annotated = await store.mutateInboxItem(target, {
			mutationId: "annotate-1",
			queueId: "message-1",
			expectedRevision: 2,
			op: "annotate",
			value: "review after tests",
		});
		const deferred = await store.mutateInboxItem(target, {
			mutationId: "defer-1",
			queueId: "message-1",
			expectedRevision: annotated.revision,
			op: "defer",
			value: 500,
		});
		expect(deferred).toMatchObject({ annotation: "review after tests", deliverAt: 500, revision: 4 });

		await store.enqueueInboxItem(target, {
			sourceEventId: "message-2",
			sourceType: "user",
			body: "second body",
			createdAt: 200,
		});
		const reordered = await store.reorderInboxItems(
			target,
			"reorder-1",
			["message-1", "message-2"],
			["message-2", "message-1"],
		);
		expect(reordered.map(item => item.queueId)).toEqual(["message-2", "message-1"]);
		expect(
			(
				await store.reorderInboxItems(
					target,
					"reorder-retry",
					["message-1", "message-2"],
					["message-2", "message-1"],
				)
			).map(item => item.queueId),
		).toEqual(["message-2", "message-1"]);
		await expect(
			store.mutateInboxItem(
				{ ...target, authorityGeneration: 5 },
				{
					mutationId: "stale-authority",
					queueId: "message-1",
					expectedRevision: reordered[1]!.revision,
					op: "drop",
				},
			),
		).rejects.toBeInstanceOf(EngineInboxConflictError);

		await store.mutateInboxItem(target, {
			mutationId: "ack-2",
			queueId: "message-2",
			expectedRevision: reordered[0]!.revision,
			op: "acknowledge",
		});
		await store.mutateInboxItem(target, {
			mutationId: "drop-1",
			queueId: "message-1",
			expectedRevision: reordered[1]!.revision,
			op: "drop",
		});
		expect(await store.listInboxItems(target.sessionId)).toEqual([]);
		expect(await store.listInboxItems("sibling-session", true)).toEqual([]);
		expect((await store.listInboxItems(target.sessionId, true)).map(item => item.sourceBody)).toEqual([
			"second body",
			"original immutable body",
		]);
		await store.close();

		const reopened = await EngineStore.open(databasePath);
		expect(await reopened.enqueueInboxItem(target, firstSource)).toMatchObject({
			created: false,
			item: { createdAt: first.item.createdAt, disposition: "dropped" },
		});
		expect((await reopened.listInboxItems(target.sessionId, true)).map(item => item.disposition)).toEqual([
			"acknowledged",
			"dropped",
		]);
		expect(
			(await reopened.eventsAfter(target.attemptId)).filter(event => event.kind === "inbox_changed"),
		).toHaveLength(8);
		await reopened.close();
	});

	it("rolls back event sequence allocation when event insertion fails", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-event-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await inspect.unsafe(`CREATE TRIGGER reject_failed_event
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='failed'
			BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
		const event = {
			causationCommandId: "command-1",
			agentInstanceId: "agent-1",
			executionId: "execution-1",
			attemptId: "attempt-1",
			bindingId: "binding-1",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await expect(store.appendEvent({ ...event, kind: "failed" })).rejects.toThrow("injected event failure");
		await inspect.unsafe("DROP TRIGGER reject_failed_event");
		const first = await store.appendEvent({ ...event, kind: "accepted" });
		expect(first.seq).toBe(1);
		const concurrent = await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				store.appendEvent({ ...event, causationCommandId: `command-${index + 2}`, kind: "steered" }),
			),
		);
		expect(concurrent.map(candidate => candidate.seq).sort((left, right) => left - right)).toEqual(
			Array.from({ length: 16 }, (_, index) => index + 2),
		);
		await inspect.end();
		await store.close();
	});

	it("tracks delivery independently for each event sink", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-delivery-${Snowflake.next()}-`));
		const store = await EngineStore.open(path.join(tempDir, "engine.sqlite"));
		const event = await store.appendEvent({
			causationCommandId: "command-delivery",
			agentInstanceId: "agent-delivery",
			executionId: "execution-delivery",
			attemptId: "attempt-delivery",
			bindingId: "binding-delivery",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
			kind: "accepted",
		});
		expect((await store.pendingEventsForSink("nats:a")).map(candidate => candidate.eventId)).toEqual([event.eventId]);
		expect((await store.pendingEventsForSink("query:a")).map(candidate => candidate.eventId)).toEqual([
			event.eventId,
		]);
		await store.markEventDelivered(event.eventId, "nats:a");
		expect(await store.pendingEventsForSink("nats:a")).toEqual([]);
		expect((await store.pendingEventsForSink("query:a")).map(candidate => candidate.eventId)).toEqual([
			event.eventId,
		]);
		await store.markEventDeliveryFailed(event.eventId, "query:a", "temporary failure");
		expect((await store.pendingEventsForSink("query:a")).map(candidate => candidate.eventId)).toEqual([
			event.eventId,
		]);
		await store.markEventDelivered(event.eventId, "query:a");
		expect(await store.pendingEventsForSink("query:a")).toEqual([]);
		expect((await store.pendingEvents()).map(candidate => candidate.eventId)).toEqual([event.eventId]);
		await store.close();
	});

	it("commits tool effect and approval state with their events atomically", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-effect-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const target = {
			bindingId: "binding-effect",
			commandId: "command-effect",
			agentInstanceId: "agent-effect",
			executionId: "execution-effect",
			attemptId: "attempt-effect",
			engineAgentId: "Engine-effect",
			profileDigest: "profile-effect",
			state: "running" as const,
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		const effect = {
			effectId: "effect-atomic",
			toolCallId: "tool-atomic",
			toolName: "write",
			policy: "unrestricted" as const,
			inputHash: "sha256:atomic",
		};
		await store.putAttempt(target, "running");
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await inspect.unsafe(`CREATE TRIGGER reject_tool_started
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='tool_started'
			BEGIN SELECT RAISE(ABORT, 'injected tool start failure'); END`);
		await expect(store.startToolEffect(target, effect)).rejects.toThrow("injected tool start failure");
		expect(await store.getEffect(effect.effectId)).toBeUndefined();
		expect(await store.pendingEvents()).toEqual([]);

		await inspect.unsafe("DROP TRIGGER reject_tool_started");
		await store.startToolEffect(target, effect);
		await inspect.unsafe(`CREATE TRIGGER reject_tool_settled
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='tool_settled'
			BEGIN SELECT RAISE(ABORT, 'injected tool settlement failure'); END`);
		await expect(store.settleToolEffect(target, effect.effectId, "completed")).rejects.toThrow(
			"injected tool settlement failure",
		);
		expect(await store.getEffect(effect.effectId)).toMatchObject({ state: "started", outcome: null });
		expect((await store.pendingEvents()).map(event => event.kind)).toEqual(["tool_started"]);

		await inspect.unsafe("DROP TRIGGER reject_tool_settled");
		await store.settleToolEffect(target, effect.effectId, "completed");
		expect(await store.getEffect(effect.effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		expect((await store.pendingEvents()).map(event => event.kind)).toEqual(["tool_started", "tool_settled"]);

		const permitted = { ...effect, effectId: "effect-permit", toolCallId: "tool-permit", policy: "permit" as const };
		await store.requestToolApproval(target, permitted);
		await inspect.unsafe(`CREATE TRIGGER reject_approved_tool_start
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='tool_started'
			BEGIN SELECT RAISE(ABORT, 'injected approval failure'); END`);
		await expect(store.resolveToolApproval(target, permitted.effectId, "approve")).rejects.toThrow(
			"injected approval failure",
		);
		expect(await store.getEffect(permitted.effectId)).toMatchObject({ state: "planned", outcome: null });
		expect(await store.getApproval(permitted.effectId)).toMatchObject({ state: "pending", decision: null });
		await inspect.unsafe("DROP TRIGGER reject_approved_tool_start");
		await store.resolveToolApproval(target, permitted.effectId, "approve");
		expect(await store.getEffect(permitted.effectId)).toMatchObject({ state: "started", outcome: null });
		expect(await store.getApproval(permitted.effectId)).toMatchObject({ state: "resolved", decision: "approve" });
		await expect(
			store.commitAttemptTransition(target, "completed", [{ kind: "completed" }], { expectedStates: ["running"] }),
		).rejects.toBeInstanceOf(EngineEffectConflictError);
		expect((await store.getAttempt(target.attemptId))?.state).toBe("running");
		await inspect.end();
		await store.close();
	});

	it("commits Binding, Attempt, command receipt and events as one transition", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-transition-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const command: EngineCommandIdentity = {
			commandId: "command-transition",
			operation: "start",
			deviceId: "device-1",
			engineId: "engine-1",
			engineGeneration: 1,
			agentInstanceId: "agent-transition",
			executionId: "execution-transition",
			attemptId: "attempt-transition",
			authorityGeneration: 1,
			payloadHash: "sha256:payload-transition",
			canonicalHash: "sha256:canonical-transition",
		};
		const binding = {
			bindingId: "binding-transition",
			commandId: command.commandId,
			agentInstanceId: command.agentInstanceId,
			executionId: "execution-transition",
			attemptId: "attempt-transition",
			engineAgentId: "Engine-transition",
			profileDigest: "profile-transition",
			state: "running" as const,
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		expect(await store.admitCommand(command, 1)).toEqual({ status: "claimed" });
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await inspect.unsafe(`CREATE TRIGGER reject_running_transition
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='running'
			BEGIN SELECT RAISE(ABORT, 'injected transition failure'); END`);
		await expect(
			store.commitAttemptTransition(binding, "running", [{ kind: "accepted" }, { kind: "running" }], {
				settleCommandId: command.commandId,
				transcriptCheckpoint: {
					sessionId: "session-transition",
					sessionPath: "sessions/transition.jsonl",
					leafEntryId: "leaf-transition",
					byteBoundary: 123,
				},
			}),
		).rejects.toThrow("injected transition failure");
		expect(await store.getBinding(command.agentInstanceId)).toBeUndefined();
		expect(await store.getAttempt("attempt-transition")).toBeUndefined();
		expect(await store.pendingEvents()).toEqual([]);
		expect(await store.admitCommand(command, 1)).toEqual({ status: "in_progress" });

		await inspect.unsafe("DROP TRIGGER reject_running_transition");
		const events = await store.commitAttemptTransition(
			binding,
			"running",
			[{ kind: "accepted" }, { kind: "running" }],
			{ settleCommandId: command.commandId },
		);
		expect(events.map(event => [event.kind, event.seq])).toEqual([
			["accepted", 1],
			["running", 2],
		]);
		expect((await store.getBinding(command.agentInstanceId))?.state).toBe("running");
		expect((await store.getAttempt("attempt-transition"))?.state).toBe("running");
		const checkpoint = {
			sessionId: "session-transition",
			sessionPath: "sessions/transition.jsonl",
			leafEntryId: "leaf-transition",
			byteBoundary: 456,
		};
		const [paused] = await store.commitAttemptTransition(binding, "paused", [{ kind: "paused" }], {
			expectedStates: ["running"],
			transcriptCheckpoint: checkpoint,
		});
		expect(paused?.payload).toEqual({ transcriptCheckpoint: { ...checkpoint, revision: 1 } });
		expect(await store.getAttempt("attempt-transition")).toMatchObject({
			state: "paused",
			transcript_session_id: checkpoint.sessionId,
			transcript_path: checkpoint.sessionPath,
			transcript_leaf_entry_id: checkpoint.leafEntryId,
			transcript_byte_boundary: checkpoint.byteBoundary,
			transcript_revision: 1,
		});
		const queued = await store.enqueueInboxItem(
			{ ...binding, sessionId: "session-transition" },
			{
				sourceEventId: "queue-transition",
				sourceType: "user",
				body: "steer now",
				createdAt: Date.now(),
			},
		);
		const steerCommand: EngineCommandIdentity = {
			...command,
			commandId: "command-steer-transition",
			operation: "steer",
			payloadHash: "sha256:payload-steer-transition",
			canonicalHash: "sha256:canonical-steer-transition",
		};
		const consumedReceipt = {
			outcome: "applied" as const,
			detail: {
				phase: "consumed",
				queueId: queued.item.queueId,
				queueRevision: 2,
				sourceEventId: "queue-transition",
				manualHold: false,
				intentRevision: 2,
			},
		};
		expect(await store.admitCommand(steerCommand, 1)).toEqual({ status: "claimed" });
		await inspect.unsafe(`CREATE TRIGGER reject_inbox_consumption
			BEFORE UPDATE ON engine_inbox_items WHEN NEW.disposition='acknowledged'
			BEGIN SELECT RAISE(ABORT, 'injected inbox consumption failure'); END`);
		await expect(
			store.commitAttemptTransition(
				{
					...binding,
					manualHold: false,
					intentRevision: 2,
					intentCommandId: steerCommand.commandId,
				},
				"running",
				[{ kind: "resumed" }, { kind: "steered" }],
				{
					expectedStates: ["paused"],
					settleCommandId: steerCommand.commandId,
					settleCommandReceipt: consumedReceipt,
					inboxSessionId: "session-transition",
					inboxMutation: {
						mutationId: "consume-transition",
						queueId: queued.item.queueId,
						expectedRevision: queued.item.revision,
						op: "acknowledge",
					},
				},
			),
		).rejects.toThrow("injected inbox consumption failure");
		expect((await store.getAttempt(binding.attemptId))?.state).toBe("paused");
		expect(await store.getInboxItem("session-transition", queued.item.queueId)).toMatchObject({
			disposition: "pending",
			revision: 1,
		});
		expect(await store.admitCommand(steerCommand, 1)).toEqual({ status: "in_progress" });
		await inspect.unsafe("DROP TRIGGER reject_inbox_consumption");
		await store.commitAttemptTransition(
			{
				...binding,
				manualHold: false,
				intentRevision: 2,
				intentCommandId: steerCommand.commandId,
			},
			"running",
			[{ kind: "resumed" }, { kind: "steered" }],
			{
				expectedStates: ["paused"],
				settleCommandId: steerCommand.commandId,
				settleCommandReceipt: consumedReceipt,
				inboxSessionId: "session-transition",
				inboxMutation: {
					mutationId: "consume-transition",
					queueId: queued.item.queueId,
					expectedRevision: queued.item.revision,
					op: "acknowledge",
				},
			},
		);
		expect(await store.getInboxItem("session-transition", queued.item.queueId)).toMatchObject({
			disposition: "acknowledged",
			revision: 2,
		});
		expect(await store.admitCommand(steerCommand, 1)).toEqual({ status: "replay", receipt: consumedReceipt });
		await expect(
			store.commitAttemptTransition(binding, "completed", [{ kind: "completed" }], {
				expectedStates: ["completed"],
			}),
		).rejects.toBeInstanceOf(EngineAttemptConflictError);
		expect((await store.getAttempt("attempt-transition"))?.state).toBe("running");
		expect((await store.pendingEvents()).map(event => event.kind)).toEqual([
			"accepted",
			"running",
			"paused",
			"inbox_changed",
			"inbox_changed",
			"resumed",
			"steered",
		]);
		expect(await store.admitCommand(command, 1)).toEqual({
			status: "replay",
			receipt: { outcome: "applied" },
		});
		await inspect.end();
		await store.close();
	});

	it("atomically rebinds only pending inbox items for a history edit", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-history-inbox-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const sourceBinding = {
			bindingId: "binding-history-source",
			commandId: "command-history-source",
			agentInstanceId: "agent-history-inbox",
			executionId: "execution-history-source",
			attemptId: "attempt-history-source",
			engineAgentId: "Engine-history-inbox",
			profileDigest: "profile-history-inbox",
			state: "released" as const,
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await store.putBinding(sourceBinding);
		const sourceTarget = { ...sourceBinding, sessionId: "session-history-source" };
		const first = await store.enqueueInboxItem(sourceTarget, {
			sourceEventId: "history-pending-first",
			sourceType: "user",
			body: "first pending body",
			createdAt: 1,
		});
		const second = await store.enqueueInboxItem(sourceTarget, {
			sourceEventId: "history-pending-second",
			sourceType: "user",
			body: "second pending body",
			createdAt: 2,
		});
		const terminal = await store.enqueueInboxItem(sourceTarget, {
			sourceEventId: "history-terminal",
			sourceType: "user",
			body: "terminal body",
			createdAt: 3,
		});
		await store.mutateInboxItem(sourceTarget, {
			mutationId: "history-terminal-drop",
			queueId: terminal.item.queueId,
			expectedRevision: terminal.item.revision,
			op: "drop",
		});
		await store.reorderInboxItems(
			sourceTarget,
			"history-pending-reorder",
			[first.item.queueId, second.item.queueId],
			[second.item.queueId, first.item.queueId],
		);
		const expectedPending = await store.listInboxItems(sourceTarget.sessionId);
		const editedBinding = {
			...sourceBinding,
			bindingId: "binding-history-edited",
			commandId: "command-history-edit",
			executionId: "execution-history-edited",
			attemptId: "attempt-history-edited",
			bindingGeneration: 2,
			state: "running" as const,
			manualHold: true,
			intentRevision: 1,
			intentCommandId: "command-history-edit",
		};
		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await inspect.unsafe(`CREATE TRIGGER reject_history_inbox_rebind
			BEFORE INSERT ON engine_event_outbox WHEN NEW.kind='running'
			BEGIN SELECT RAISE(ABORT, 'injected history rebind failure'); END`);
		await expect(
			store.commitAttemptTransition(editedBinding, "running", [{ kind: "running" }], {
				requireNew: true,
				inboxSessionId: "session-history-edited",
				pendingInboxSourceSessionId: sourceTarget.sessionId,
			}),
		).rejects.toThrow("injected history rebind failure");
		expect(await store.listInboxItems(sourceTarget.sessionId)).toEqual(expectedPending);
		expect(await store.listInboxItems("session-history-edited", true)).toEqual([]);
		expect(await store.getAttempt(editedBinding.attemptId)).toBeUndefined();

		await inspect.unsafe("DROP TRIGGER reject_history_inbox_rebind");
		await store.commitAttemptTransition(editedBinding, "running", [{ kind: "running" }], {
			requireNew: true,
			inboxSessionId: "session-history-edited",
			pendingInboxSourceSessionId: sourceTarget.sessionId,
		});
		const rebound = await store.listInboxItems("session-history-edited");
		expect(rebound.map(item => [item.queueId, item.sourceBody, item.position, item.revision])).toEqual(
			expectedPending.map(item => [item.queueId, item.sourceBody, item.position, item.revision]),
		);
		expect(await store.listInboxItems(sourceTarget.sessionId)).toEqual([]);
		expect(await store.listInboxItems(sourceTarget.sessionId, true)).toContainEqual(
			expect.objectContaining({ queueId: terminal.item.queueId, disposition: "dropped" }),
		);
		await expect(
			store.commitAttemptTransition(editedBinding, "running", [{ kind: "running" }], {
				requireNew: true,
				inboxSessionId: "session-history-edited",
				pendingInboxSourceSessionId: sourceTarget.sessionId,
			}),
		).rejects.toBeInstanceOf(EngineAttemptConflictError);
		expect((await store.listInboxItems("session-history-edited")).map(item => item.queueId)).toEqual(
			rebound.map(item => item.queueId),
		);
		await inspect.end();
		await store.close();

		const reopened = await EngineStore.open(databasePath);
		expect(await reopened.getBinding(sourceBinding.agentInstanceId)).toMatchObject({
			bindingId: editedBinding.bindingId,
			manualHold: true,
		});
		expect((await reopened.listInboxItems("session-history-edited")).map(item => item.queueId)).toEqual(
			rebound.map(item => item.queueId),
		);
		await reopened.close();
	});

	it("rejects a corrupt database instead of recreating authority", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-corrupt-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		fs.writeFileSync(databasePath, "not a sqlite database");
		await expect(EngineStore.open(databasePath)).rejects.toThrow();
		expect(fs.readFileSync(databasePath, "utf8")).toBe("not a sqlite database");
	});

	it("keeps a large transcript and 10k authoritative events within the bounded SQLite profile", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-scale-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const store = await EngineStore.open(databasePath);
		const startedAt = performance.now();
		const transcript = "x".repeat(8 * 1024 * 1024);
		await store.sessionStorage.writeText("sessions/large.jsonl", transcript);
		await store.sessionStorage.drain();
		const [head, tail] = await store.sessionStorage.readTextSlices("sessions/large.jsonl", 4_096, 4_096);
		expect([head.length, tail.length]).toEqual([4_096, 4_096]);

		let firstEventId = 0;
		for (let index = 0; index < 10_000; index++) {
			const event = await store.appendEvent({
				causationCommandId: `command-scale-${index}`,
				agentInstanceId: `agent-scale-${index % 2}`,
				executionId: "execution-scale",
				attemptId: "attempt-scale",
				bindingId: "binding-scale",
				engineGeneration: 1,
				bindingGeneration: 1,
				authorityGeneration: 1,
				kind: "reconciled",
			});
			if (index === 0) firstEventId = event.eventId;
		}
		await store.markEventPublished(firstEventId);
		expect(performance.now() - startedAt).toBeLessThan(60_000);
		const walPath = `${databasePath}-wal`;
		const liveBytes = fs.statSync(databasePath).size + (fs.existsSync(walPath) ? fs.statSync(walPath).size : 0);
		expect(liveBytes).toBeLessThan(64 * 1024 * 1024);
		await store.close();

		const inspect = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		const integrity = (await inspect.unsafe("PRAGMA integrity_check")) as Array<{ integrity_check: string }>;
		const events = (await inspect.unsafe("SELECT COUNT(*) AS count FROM engine_event_outbox")) as Array<{
			count: number;
		}>;
		const sessions = (await inspect.unsafe(
			"SELECT length(cast(content AS blob)) AS bytes FROM omp_session_files WHERE path='sessions/large.jsonl'",
		)) as Array<{ bytes: number }>;
		const journal = (await inspect.unsafe("PRAGMA journal_mode")) as Array<{ journal_mode: string }>;
		await inspect.end();
		expect(integrity[0]?.integrity_check).toBe("ok");
		expect(Number(events[0]?.count)).toBe(10_000);
		expect(Number(sessions[0]?.bytes)).toBe(transcript.length);
		expect(journal[0]?.journal_mode).toBe("wal");
	}, 90_000);
});
