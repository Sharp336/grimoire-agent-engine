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
	EngineStore,
} from "@oh-my-pi/pi-coding-agent/engine/store";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

describe("EngineStore", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
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
		expect(events.at(-1)?.payload).toEqual({ cause: "engine_lost", lostEngineGeneration: generation });
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
		});
		expect(await store.getBinding("agent-migrated")).toMatchObject({
			commandId: "command-migrated",
			authorityGeneration: 7,
		});
		await store.close();
		const reopened = await EngineStore.open(databasePath);
		expect((await reopened.getBinding("agent-migrated"))?.attemptId).toBe("attempt-migrated");
		await reopened.close();

		const tamper = new SQL(`sqlite:${databasePath.replaceAll("\\", "/")}`);
		await tamper.unsafe("UPDATE engine_schema_migrations SET checksum='changed' WHERE version=1");
		await tamper.end();
		await expect(EngineStore.open(databasePath)).rejects.toThrow("migration 1 checksum does not match");
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
		await expect(
			store.commitAttemptTransition(binding, "completed", [{ kind: "completed" }], {
				expectedStates: ["completed"],
			}),
		).rejects.toBeInstanceOf(EngineAttemptConflictError);
		expect((await store.getAttempt("attempt-transition"))?.state).toBe("paused");
		expect((await store.pendingEvents()).map(event => event.kind)).toEqual(["accepted", "running", "paused"]);
		expect(await store.admitCommand(command, 1)).toEqual({
			status: "replay",
			receipt: { outcome: "applied" },
		});
		await inspect.end();
		await store.close();
	});
});
