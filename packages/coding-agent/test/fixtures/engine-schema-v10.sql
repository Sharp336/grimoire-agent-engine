-- Frozen Engine schema v10 fixture generated from commit 93da62e72785023370206f43df4084a93dc46f91.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE engine_agent_seq (
		agent_instance_id TEXT PRIMARY KEY,
		seq INTEGER NOT NULL
	);
CREATE TABLE engine_approvals (
		approval_id TEXT PRIMARY KEY,
		effect_id TEXT NOT NULL UNIQUE REFERENCES engine_effects(effect_id),
		request_command_id TEXT NOT NULL,
		resolved_command_id TEXT,
		state TEXT NOT NULL CHECK(state IN ('pending', 'resolved')),
		decision TEXT CHECK(decision IN ('approve', 'deny', 'cancelled')),
		reason TEXT,
		requested_at INTEGER NOT NULL,
		resolved_at INTEGER,
		updated_at INTEGER NOT NULL
	);
CREATE TABLE engine_attempts (
		attempt_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		state TEXT NOT NULL,
		cause TEXT,
		updated_at INTEGER NOT NULL
	, transcript_session_id TEXT, transcript_path TEXT, transcript_leaf_entry_id TEXT, transcript_byte_boundary INTEGER, transcript_revision INTEGER NOT NULL DEFAULT 0, retry_attempt INTEGER NOT NULL DEFAULT 0, retry_max_attempts INTEGER NOT NULL DEFAULT 0, retry_route TEXT, retry_delay_ms INTEGER, retry_scheduled_at INTEGER, retry_outcome TEXT, retry_error TEXT);
CREATE TABLE engine_commands (
		command_id TEXT PRIMARY KEY,
		operation TEXT NOT NULL,
		device_id TEXT NOT NULL,
		engine_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		agent_instance_id TEXT NOT NULL,
		agent_instance_ref TEXT,
		parent_agent_instance_id TEXT,
		binding_id TEXT,
		binding_generation INTEGER,
		execution_id TEXT,
		attempt_id TEXT,
		authority_generation INTEGER NOT NULL,
		payload_hash TEXT NOT NULL,
		canonical_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('received', 'settled')),
		processor_generation INTEGER,
		outcome TEXT CHECK(outcome IN ('applied', 'rejected')),
		receipt TEXT,
		received_at INTEGER NOT NULL,
		settled_at INTEGER,
		updated_at INTEGER NOT NULL
	);
CREATE TABLE engine_effects (
		effect_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		tool_call_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		policy TEXT NOT NULL CHECK(policy IN ('unrestricted', 'tracked', 'permit')),
		input_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('planned', 'started', 'settled', 'unknown')),
		outcome TEXT CHECK(outcome IN ('completed', 'failed', 'cancelled', 'denied', 'unknown')),
		error TEXT,
		job_ids TEXT,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		settled_at INTEGER,
		updated_at INTEGER NOT NULL, effect_kind TEXT NOT NULL DEFAULT 'tool' CHECK(effect_kind IN ('tool', 'model')),
		UNIQUE(attempt_id, tool_call_id)
	);
CREATE TABLE engine_event_deliveries (
		event_id INTEGER NOT NULL REFERENCES engine_event_outbox(event_id),
		sink_id TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('pending', 'delivered')),
		attempts INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		delivered_at INTEGER,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY(event_id, sink_id)
	);
CREATE TABLE engine_event_outbox (
		event_id INTEGER PRIMARY KEY AUTOINCREMENT,
		seq INTEGER NOT NULL,
		causation_command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT,
		created_at INTEGER NOT NULL,
		published_at INTEGER,
		UNIQUE(agent_instance_id, seq)
	);
CREATE TABLE engine_inbox_items (
		queue_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		binding_id TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		source_event_id TEXT NOT NULL UNIQUE REFERENCES engine_inbox_sources(source_event_id),
		delivery_payload TEXT NOT NULL,
		annotation TEXT,
		deliver_at INTEGER,
		wake_intent INTEGER NOT NULL CHECK(wake_intent IN (0, 1)),
		wake_delivered_at INTEGER,
		position INTEGER NOT NULL,
		disposition TEXT NOT NULL CHECK(disposition IN ('pending', 'acknowledged', 'dropped')),
		revision INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
CREATE TABLE engine_inbox_sources (
		source_event_id TEXT PRIMARY KEY,
		source_type TEXT NOT NULL CHECK(source_type IN ('user', 'agent', 'runtime')),
		sender TEXT,
		body TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
CREATE TABLE engine_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE engine_runtime_bindings (
		binding_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL,
		agent_instance_id TEXT NOT NULL UNIQUE,
		execution_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		engine_agent_id TEXT NOT NULL,
		session_file TEXT,
		profile_digest TEXT NOT NULL,
		state TEXT NOT NULL,
		engine_generation INTEGER NOT NULL,
		binding_generation INTEGER NOT NULL,
		authority_generation INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	, manual_hold INTEGER NOT NULL DEFAULT 0 CHECK(manual_hold IN (0, 1)), intent_revision INTEGER NOT NULL DEFAULT 0, intent_command_id TEXT);
CREATE TABLE engine_schema_migrations (
				version INTEGER PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			);
CREATE TABLE omp_session_files (
		path TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		mtime_ms INTEGER NOT NULL,
		title TEXT,
		title_source TEXT,
		title_updated_at TEXT
	);
CREATE INDEX engine_approvals_state_idx ON engine_approvals(state, updated_at);
CREATE INDEX engine_attempt_state_idx ON engine_attempts(state, engine_generation);
CREATE INDEX engine_commands_state_idx ON engine_commands(state, processor_generation, updated_at);
CREATE INDEX engine_effects_recovery_idx ON engine_effects(engine_generation, state);
CREATE INDEX engine_event_deliveries_pending_idx ON engine_event_deliveries(sink_id, state, event_id);
CREATE INDEX engine_inbox_session_idx
	 ON engine_inbox_items(session_id, disposition, deliver_at, position, queue_id);
CREATE INDEX engine_outbox_pending_idx ON engine_event_outbox(published_at, event_id);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (1, '5e41a24f074178d36404428270605009c3738a59c8e6ce36fc02eeca13c4ec6f', 1);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (2, '3995387e4e4d3de36e0f22df42e5a10ce44815fdb14a4b44e683a7edaf923021', 2);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (3, '4c326841de3d0c75acd5e7310899442ccb324d61f4cbc5c9d50584e134dc8285', 3);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (4, 'bcbd88223ed575fef4b4d2b629d899a0c7889b31e622110b9fb036123f393e06', 4);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (5, 'c8970ec790f8ba404f386094c884a1544bbf207c2d6f68ba3e4d91917a39a25a', 5);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (6, 'da0c5842ace4d8f9ad49a0dd1df72b6955f9296bc4d7b447d3e83bb3e589b776', 6);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (7, '7209b058ef082a752e1cda4283c421fe6c3c9a3a4b69a596c9a6a9d2e5235c4a', 7);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (8, '861a85a4c30ee6564e0aa68c5990d6e94def78e5c89744651348fd2256f6e672', 8);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (9, 'f919ae99980a7ba110f18ca9c68969869abad98b510ea9b488cec00c0839cc89', 9);
INSERT INTO engine_schema_migrations(version, checksum, applied_at) VALUES (10, '8e7edb9362663898c16894c6d758278abcf511a7edd0d8a64f3b7ce5609aee06', 10);
COMMIT;
