-- Captured from exact Engine aa73edfe59d8f1b4f9721df3a5f87ba5af94c31f (schema22), using native owner APIs.
BEGIN TRANSACTION;
CREATE TABLE engine_agent_identity (
			 agent_instance_id TEXT PRIMARY KEY, agent_instance_ref TEXT NOT NULL DEFAULT '',
			 parent_agent_instance_id TEXT, parent_agent_instance_ref TEXT, principal_id TEXT NOT NULL DEFAULT '',
			 authority_generation INTEGER NOT NULL DEFAULT 0, intent_revision INTEGER NOT NULL DEFAULT 0,
			 queue_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, root_agent_instance_ref TEXT NOT NULL DEFAULT '', summary_revision INTEGER NOT NULL DEFAULT 0, summary_json TEXT, membership_revision INTEGER NOT NULL DEFAULT 0, ownership_proof_command_id TEXT);
INSERT INTO "engine_agent_identity" VALUES('legacy-a','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,'legacy-owner',1,0,4,1788950703771,1788950703859,'grimoire://tasks/grimoire/migration-test/agents/legacy-a',2,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","parentAgentInstanceRef":null,"revision":2,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":true}}',1,NULL);
INSERT INTO "engine_agent_identity" VALUES('legacy-b','grimoire://tasks/grimoire/migration-test/agents/legacy-b',NULL,NULL,'legacy-owner',1,0,1,1788950703815,1788950703822,'grimoire://tasks/grimoire/migration-test/agents/legacy-b',7,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","parentAgentInstanceRef":null,"revision":7,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":true}}',6,NULL);
CREATE TABLE engine_agent_seq (
		agent_instance_id TEXT PRIMARY KEY,
		seq INTEGER NOT NULL
	);
INSERT INTO "engine_agent_seq" VALUES('legacy-a',5);
INSERT INTO "engine_agent_seq" VALUES('legacy-b',2);
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
	, transcript_session_id TEXT, transcript_path TEXT, transcript_leaf_entry_id TEXT, transcript_byte_boundary INTEGER, transcript_revision INTEGER NOT NULL DEFAULT 0, retry_attempt INTEGER NOT NULL DEFAULT 0, retry_max_attempts INTEGER NOT NULL DEFAULT 0, retry_route TEXT, retry_delay_ms INTEGER, retry_scheduled_at INTEGER, retry_outcome TEXT, retry_error TEXT, result_payload TEXT, detail_revision INTEGER NOT NULL DEFAULT 0, input_revision INTEGER NOT NULL DEFAULT 0, message_revision INTEGER NOT NULL DEFAULT 0, tool_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE engine_branch_holds (
			 source_agent_instance_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pause','stop','recovery')),
			 command_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL,
			 PRIMARY KEY(source_agent_instance_id, kind));
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
	, principal_id TEXT NOT NULL DEFAULT '', browser_payload_hash TEXT, payload_bytes INTEGER NOT NULL DEFAULT 0, serialized_command TEXT, start_applied_intent_revision INTEGER);
INSERT INTO "engine_commands" VALUES('legacy-pause','pause','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-pause','attempt-pause',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:pause','received',1,NULL,NULL,1788950703832,NULL,1788950703832,'',NULL,80,'{"commandId":"legacy-pause","operation":"pause","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-resume','resume','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-resume','attempt-resume',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:resume','received',1,NULL,NULL,1788950703836,NULL,1788950703836,'',NULL,82,'{"commandId":"legacy-resume","operation":"resume","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-cancel','cancel','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-cancel','attempt-cancel',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:cancel','received',1,NULL,NULL,1788950703839,NULL,1788950703839,'',NULL,82,'{"commandId":"legacy-cancel","operation":"cancel","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-resolve_input','resolve_input','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-resolve_input','attempt-resolve_input',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:resolve_input','received',1,NULL,NULL,1788950703843,NULL,1788950703843,'',NULL,96,'{"commandId":"legacy-resolve_input","operation":"resolve_input","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-resolve_tool_approval','resolve_tool_approval','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-resolve_tool_approval','attempt-resolve_tool_approval',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:resolve_tool_approval','received',1,NULL,NULL,1788950703849,NULL,1788950703849,'',NULL,112,'{"commandId":"legacy-resolve_tool_approval","operation":"resolve_tool_approval","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-enqueue','enqueue','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-enqueue','attempt-enqueue',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:enqueue','received',1,NULL,NULL,1788950703854,NULL,1788950703854,'',NULL,84,'{"commandId":"legacy-enqueue","operation":"enqueue","text":"Preserve frozen source"}',NULL);
INSERT INTO "engine_commands" VALUES('legacy-steer','steer','migration-device','migration-engine',1,'legacy-a',NULL,NULL,NULL,NULL,'execution-steer','attempt-steer',1,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:steer','received',1,NULL,NULL,1788950703858,NULL,1788950703858,'',NULL,80,'{"commandId":"legacy-steer","operation":"steer","text":"Preserve frozen source"}',NULL);
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
		updated_at INTEGER NOT NULL, effect_kind TEXT NOT NULL DEFAULT 'tool' CHECK(effect_kind IN ('tool', 'model')), runtime_event_id INTEGER NOT NULL DEFAULT 0,
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
		published_at INTEGER, summary_payload TEXT, membership_payload TEXT, projection_payload TEXT, detail_payload TEXT, projection_kinds INTEGER NOT NULL DEFAULT 0, projection_principal TEXT NOT NULL DEFAULT '', projection_root TEXT NOT NULL DEFAULT '', input_body TEXT, input_preview TEXT, message_content_id TEXT, message_id TEXT, message_block_id TEXT, message_stream TEXT, message_revision INTEGER, message_offset INTEGER, message_end_offset INTEGER, message_snapshot TEXT, lifecycle_summary TEXT, history_assistant_id TEXT, projection_agent_kinds INTEGER NOT NULL DEFAULT 0,
		UNIQUE(agent_instance_id, seq)
	);
INSERT INTO "engine_event_outbox" VALUES(1,1,'register:legacy-a','legacy-a','','','',1,0,0,'agent_registered','{}',1788950703772,NULL,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","parentAgentInstanceRef":null,"revision":1,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":false}}','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","parentAgentInstanceRef":null,"revision":1}','[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":1,"revision":1,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":1,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":0,"pendingCount":0,"hasMore":false},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":1,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":0,"pendingCount":0,"hasMore":false},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',4,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,4);
INSERT INTO "engine_event_outbox" VALUES(2,2,'legacy-a-pending-1','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'inbox_changed','{"action":"queued","queueId":"legacy-a-pending-1","revision":1}',1788950703784,NULL,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","parentAgentInstanceRef":null,"revision":2,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":true}}',NULL,'[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":2,"revision":2,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":2,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":1,"pendingCount":1,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}},{"kind":"invalidate","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":2,"revision":2,"value":{"resource":"queue","revision":1}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":2,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":1,"pendingCount":1,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',12,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,12);
INSERT INTO "engine_event_outbox" VALUES(3,3,'legacy-a-pending-2','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'inbox_changed','{"action":"queued","queueId":"legacy-a-pending-2","revision":1}',1788950703793,NULL,NULL,NULL,'[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":3,"revision":3,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":3,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":2,"pendingCount":2,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}},{"kind":"invalidate","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":3,"revision":3,"value":{"resource":"queue","revision":2}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":3,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":2,"pendingCount":2,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',12,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,12);
INSERT INTO "engine_event_outbox" VALUES(4,4,'legacy-a-consumed','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'inbox_changed','{"action":"queued","queueId":"legacy-a-consumed","revision":1}',1788950703798,NULL,NULL,NULL,'[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":4,"revision":4,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":4,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":3,"pendingCount":3,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}},{"kind":"invalidate","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":4,"revision":4,"value":{"resource":"queue","revision":3}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":4,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":3,"pendingCount":3,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',12,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,12);
INSERT INTO "engine_event_outbox" VALUES(5,5,'legacy-consume','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'inbox_changed','{"action":"acknowledge","queueId":"legacy-a-consumed","revision":2,"sourceEventId":"legacy-a-consumed"}',1788950703807,NULL,NULL,NULL,'[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":5,"revision":5,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":5,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":4,"pendingCount":2,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}},{"kind":"invalidate","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","cursor":5,"revision":5,"value":{"resource":"queue","revision":4}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","attemptId":null,"revision":5,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-a","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":4,"pendingCount":2,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',12,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,12);
INSERT INTO "engine_event_outbox" VALUES(6,1,'register:legacy-b','legacy-b','','','',1,0,0,'agent_registered','{}',1788950703815,NULL,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","parentAgentInstanceRef":null,"revision":6,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":false}}','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","parentAgentInstanceRef":null,"revision":6}','[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","cursor":6,"revision":6,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","attemptId":null,"revision":6,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":0,"pendingCount":0,"hasMore":false},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","attemptId":null,"revision":6,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":0,"pendingCount":0,"hasMore":false},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',4,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-b',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,4);
INSERT INTO "engine_event_outbox" VALUES(7,2,'legacy-b-pending-1','legacy-b','execution-legacy-b','attempt-legacy-b','binding-legacy-b',1,1,1,'inbox_changed','{"action":"queued","queueId":"legacy-b-pending-1","revision":1}',1788950703822,NULL,'{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","rootAgentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","parentAgentInstanceRef":null,"revision":7,"engineGeneration":1,"authorityGeneration":1,"state":"registered","target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"pendingStart":null,"outcome":null,"attention":{"held":false,"needsInput":false,"queuePending":true}}',NULL,'[{"kind":"state","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","cursor":7,"revision":7,"value":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","attemptId":null,"revision":7,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":1,"pendingCount":1,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}},{"kind":"invalidate","agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","cursor":7,"revision":7,"value":{"resource":"queue","revision":1}}]','{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","attemptId":null,"revision":7,"target":{"agentInstanceRef":"grimoire://tasks/grimoire/migration-test/agents/legacy-b","intentRevision":0,"authorityGeneration":1},"state":"registered","manualHold":false,"holds":[],"holdsHasMore":false,"queue":{"revision":1,"pendingCount":1,"hasMore":true},"pendingInputs":[],"inputsHasMore":false,"history":{"sessionId":null,"revision":null,"leafEntryId":null,"settled":false},"messages":[],"messagesHasMore":false,"tools":[],"toolsNextCursor":null}',12,'legacy-owner','grimoire://tasks/grimoire/migration-test/agents/legacy-b',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,12);
CREATE TABLE engine_history_entries(session_path TEXT NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,ordinal INTEGER NOT NULL,entry_type TEXT NOT NULL,entry_role TEXT,entry_json TEXT NOT NULL,entry_bytes INTEGER NOT NULL,tool_call_id TEXT, source_command_id TEXT, assistant_message_id TEXT,PRIMARY KEY(session_path,entry_id)) WITHOUT ROWID;
INSERT INTO "engine_history_entries" VALUES('migration-session.jsonl','migration-session',NULL,0,'session',NULL,'{"type":"session","id":"migration-session","version":3,"cwd":"fixture-workspace"}',81,NULL,NULL,NULL);
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
INSERT INTO "engine_inbox_items" VALUES('legacy-a-pending-1','session-legacy-a','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'legacy-a-pending-1','Preserve legacy-a pending-1',NULL,NULL,0,NULL,1024,'pending',1,1788950703783,1788950703783);
INSERT INTO "engine_inbox_items" VALUES('legacy-a-pending-2','session-legacy-a','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'legacy-a-pending-2','Preserve legacy-a pending-2',NULL,NULL,0,NULL,2048,'pending',1,1788950703793,1788950703793);
INSERT INTO "engine_inbox_items" VALUES('legacy-a-consumed','session-legacy-a','legacy-a','execution-legacy-a','attempt-legacy-a','binding-legacy-a',1,1,1,'legacy-a-consumed','Preserve legacy-a consumed',NULL,NULL,0,NULL,3072,'acknowledged',2,1788950703798,1788950703806);
INSERT INTO "engine_inbox_items" VALUES('legacy-b-pending-1','session-legacy-b','legacy-b','execution-legacy-b','attempt-legacy-b','binding-legacy-b',1,1,1,'legacy-b-pending-1','Preserve legacy-b pending-1',NULL,NULL,0,NULL,1024,'pending',1,1788950703822,1788950703822);
CREATE TABLE engine_inbox_sources (
		source_event_id TEXT PRIMARY KEY,
		source_type TEXT NOT NULL CHECK(source_type IN ('user', 'agent', 'runtime')),
		sender TEXT,
		body TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
INSERT INTO "engine_inbox_sources" VALUES('legacy-a-pending-1','user',NULL,'Preserve legacy-a pending-1',1788950703782);
INSERT INTO "engine_inbox_sources" VALUES('legacy-a-pending-2','user',NULL,'Preserve legacy-a pending-2',1788950703793);
INSERT INTO "engine_inbox_sources" VALUES('legacy-a-consumed','user',NULL,'Preserve legacy-a consumed',1788950703797);
INSERT INTO "engine_inbox_sources" VALUES('legacy-b-pending-1','user',NULL,'Preserve legacy-b pending-1',1788950703821);
CREATE TABLE engine_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "engine_metadata" VALUES('database_id','98f053d4-630b-4906-a0fd-234c95e4a296');
INSERT INTO "engine_metadata" VALUES('engine_generation','1');
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
	, manual_hold INTEGER NOT NULL DEFAULT 0 CHECK(manual_hold IN (0, 1)), intent_revision INTEGER NOT NULL DEFAULT 0, intent_command_id TEXT, conversation_identity_digest TEXT);
CREATE TABLE engine_runtime_inputs(attempt_id TEXT NOT NULL,input_id TEXT NOT NULL,kind TEXT NOT NULL,created_event_id INTEGER NOT NULL,resolved_event_id INTEGER,PRIMARY KEY(attempt_id,input_id));
CREATE TABLE engine_runtime_messages(attempt_id TEXT NOT NULL,message_id TEXT NOT NULL,block_id TEXT NOT NULL,stream TEXT NOT NULL,
	 agent_instance_id TEXT NOT NULL,content_id TEXT NOT NULL,revision INTEGER NOT NULL,total_bytes INTEGER NOT NULL,tail_text TEXT NOT NULL,status TEXT NOT NULL,
	 created_event_id INTEGER NOT NULL,last_event_id INTEGER NOT NULL,PRIMARY KEY(attempt_id,message_id,block_id,stream));
CREATE TABLE engine_schema_migrations (
				version INTEGER PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			);
INSERT INTO "engine_schema_migrations" VALUES(1,'5e41a24f074178d36404428270605009c3738a59c8e6ce36fc02eeca13c4ec6f',1788950703703);
INSERT INTO "engine_schema_migrations" VALUES(2,'3995387e4e4d3de36e0f22df42e5a10ce44815fdb14a4b44e683a7edaf923021',1788950703704);
INSERT INTO "engine_schema_migrations" VALUES(3,'4c326841de3d0c75acd5e7310899442ccb324d61f4cbc5c9d50584e134dc8285',1788950703704);
INSERT INTO "engine_schema_migrations" VALUES(4,'bcbd88223ed575fef4b4d2b629d899a0c7889b31e622110b9fb036123f393e06',1788950703706);
INSERT INTO "engine_schema_migrations" VALUES(5,'c8970ec790f8ba404f386094c884a1544bbf207c2d6f68ba3e4d91917a39a25a',1788950703706);
INSERT INTO "engine_schema_migrations" VALUES(6,'da0c5842ace4d8f9ad49a0dd1df72b6955f9296bc4d7b447d3e83bb3e589b776',1788950703707);
INSERT INTO "engine_schema_migrations" VALUES(7,'7209b058ef082a752e1cda4283c421fe6c3c9a3a4b69a596c9a6a9d2e5235c4a',1788950703707);
INSERT INTO "engine_schema_migrations" VALUES(8,'861a85a4c30ee6564e0aa68c5990d6e94def78e5c89744651348fd2256f6e672',1788950703708);
INSERT INTO "engine_schema_migrations" VALUES(9,'f919ae99980a7ba110f18ca9c68969869abad98b510ea9b488cec00c0839cc89',1788950703709);
INSERT INTO "engine_schema_migrations" VALUES(10,'8e7edb9362663898c16894c6d758278abcf511a7edd0d8a64f3b7ce5609aee06',1788950703712);
INSERT INTO "engine_schema_migrations" VALUES(11,'06f158eff443083af4c672f88c160e33a9485c92e27e10fa77e1048467370514',1788950703712);
INSERT INTO "engine_schema_migrations" VALUES(12,'14fa2f1d2969f00f08c820feac1deb55ecc4576c06623eb5daea3f291606f065',1788950703718);
INSERT INTO "engine_schema_migrations" VALUES(13,'c8fff6b59dd7a1a51cb0fd4da78d1ad7b6afc35e5d224700c1630a802cb9972d',1788950703731);
INSERT INTO "engine_schema_migrations" VALUES(14,'7fbc130cdd1ff8f64a08c20c44926bfb34af8c7ec21479d9adb8ec3ac88befac',1788950703739);
INSERT INTO "engine_schema_migrations" VALUES(15,'9201bb68baf396db759775bb251fe5211df862548e896882515076b49dc9c17d',1788950703740);
INSERT INTO "engine_schema_migrations" VALUES(16,'1ddaab4ca3fd881cabbf5aa41d845ee29129fc61f671340609f6aacfc2a78f2c',1788950703741);
INSERT INTO "engine_schema_migrations" VALUES(17,'4573060a7a0bb7c0128f00a4ac063b72631958170dcb0d227f9642d1047a3a48',1788950703741);
INSERT INTO "engine_schema_migrations" VALUES(18,'b4db02aa4f8612f7e6e187d96fd5ee4e6fed54e627f3830e552f808bca085d7c',1788950703742);
INSERT INTO "engine_schema_migrations" VALUES(19,'ced1e9e405f79285c720a24662364fd6230dd1a3ae18d28c535a61de350fcd37',1788950703746);
INSERT INTO "engine_schema_migrations" VALUES(20,'3d9d8dcb6c4f182a44371318c84195d21809a5b0fd8d4653a8c4fcde2c8014e5',1788950703747);
INSERT INTO "engine_schema_migrations" VALUES(21,'f78f38313afa13a4af597c3ba96a6b945bd14ed15cd9b3e3ac82be4d8cbdc2ab',1788950703749);
INSERT INTO "engine_schema_migrations" VALUES(22,'a6e5ef796577a6d842628e3df775d1414f45bc620d0101949c3afa5651b40921',1788950703751);
CREATE TABLE engine_start_cancellations(
	 start_command_id TEXT PRIMARY KEY,agent_instance_id TEXT NOT NULL,execution_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
	 authority_generation INTEGER NOT NULL,principal_id TEXT NOT NULL,expected_start_intent_revision INTEGER NOT NULL,
	 cancellation_command_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE omp_session_files (
		path TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		mtime_ms INTEGER NOT NULL,
		title TEXT,
		title_source TEXT,
		title_updated_at TEXT
	, history_lineage TEXT NOT NULL DEFAULT 'legacy');
INSERT INTO "omp_session_files" VALUES('migration-session.jsonl','{"type":"session","id":"migration-session","version":3,"cwd":"fixture-workspace"}
',1788950703861,NULL,NULL,NULL,'db9ec7c66a5073830802145bc4425529');
CREATE INDEX engine_attempt_state_idx ON engine_attempts(state, engine_generation);
CREATE INDEX engine_outbox_pending_idx ON engine_event_outbox(published_at, event_id);
CREATE INDEX engine_commands_state_idx ON engine_commands(state, processor_generation, updated_at);
CREATE INDEX engine_effects_recovery_idx ON engine_effects(engine_generation, state);
CREATE INDEX engine_approvals_state_idx ON engine_approvals(state, updated_at);
CREATE INDEX engine_event_deliveries_pending_idx ON engine_event_deliveries(sink_id, state, event_id);
CREATE INDEX engine_inbox_session_idx
	 ON engine_inbox_items(session_id, disposition, deliver_at, position, queue_id);
CREATE INDEX engine_history_page_idx ON engine_history_entries(session_path,ordinal);
CREATE INDEX engine_history_tool_idx ON engine_history_entries(session_path,tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE TRIGGER engine_history_insert AFTER INSERT ON omp_session_files WHEN NEW.path LIKE '%.jsonl' BEGIN INSERT INTO engine_history_entries(session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id)
	 SELECT NEW.path,json_extract(j.value,'$.id'),json_extract(j.value,'$.parentId'),CAST(j.key AS INTEGER)+0,json_extract(j.value,'$.type'),json_extract(j.value,'$.message.role'),j.value,length(CAST(j.value AS BLOB)),json_extract(j.value,'$.message.toolCallId')
	 FROM json_each(CASE WHEN json_valid('[' || replace(trim(NEW.content,char(10)||char(13)||' '),char(10),',') || ']') THEN '[' || replace(trim(NEW.content,char(10)||char(13)||' '),char(10),',') || ']' ELSE '[]' END) j WHERE json_type(j.value,'$.id')='text'
	 ON CONFLICT(session_path,entry_id) DO UPDATE SET parent_entry_id=excluded.parent_entry_id,ordinal=excluded.ordinal,entry_type=excluded.entry_type,entry_role=excluded.entry_role,entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes,tool_call_id=excluded.tool_call_id; END;
CREATE TRIGGER engine_history_append AFTER UPDATE OF content ON omp_session_files WHEN NEW.path LIKE '%.jsonl' AND length(NEW.content)>=length(OLD.content) AND substr(NEW.content,1,length(OLD.content))=OLD.content BEGIN INSERT INTO engine_history_entries(session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id)
	 SELECT NEW.path,json_extract(j.value,'$.id'),json_extract(j.value,'$.parentId'),CAST(j.key AS INTEGER)+(SELECT COALESCE(MAX(ordinal),-1)+1 FROM engine_history_entries WHERE session_path=NEW.path),json_extract(j.value,'$.type'),json_extract(j.value,'$.message.role'),j.value,length(CAST(j.value AS BLOB)),json_extract(j.value,'$.message.toolCallId')
	 FROM json_each(CASE WHEN json_valid('[' || replace(trim(substr(NEW.content,length(OLD.content)+1),char(10)||char(13)||' '),char(10),',') || ']') THEN '[' || replace(trim(substr(NEW.content,length(OLD.content)+1),char(10)||char(13)||' '),char(10),',') || ']' ELSE '[]' END) j WHERE json_type(j.value,'$.id')='text'
	 ON CONFLICT(session_path,entry_id) DO UPDATE SET parent_entry_id=excluded.parent_entry_id,ordinal=excluded.ordinal,entry_type=excluded.entry_type,entry_role=excluded.entry_role,entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes,tool_call_id=excluded.tool_call_id; END;
CREATE TRIGGER engine_history_replace AFTER UPDATE OF content ON omp_session_files WHEN NEW.path LIKE '%.jsonl' AND (length(NEW.content)<length(OLD.content) OR substr(NEW.content,1,length(OLD.content))<>OLD.content) BEGIN DELETE FROM engine_history_entries WHERE session_path=OLD.path; INSERT INTO engine_history_entries(session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id)
	 SELECT NEW.path,json_extract(j.value,'$.id'),json_extract(j.value,'$.parentId'),CAST(j.key AS INTEGER)+0,json_extract(j.value,'$.type'),json_extract(j.value,'$.message.role'),j.value,length(CAST(j.value AS BLOB)),json_extract(j.value,'$.message.toolCallId')
	 FROM json_each(CASE WHEN json_valid('[' || replace(trim(NEW.content,char(10)||char(13)||' '),char(10),',') || ']') THEN '[' || replace(trim(NEW.content,char(10)||char(13)||' '),char(10),',') || ']' ELSE '[]' END) j WHERE json_type(j.value,'$.id')='text'
	 ON CONFLICT(session_path,entry_id) DO UPDATE SET parent_entry_id=excluded.parent_entry_id,ordinal=excluded.ordinal,entry_type=excluded.entry_type,entry_role=excluded.entry_role,entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes,tool_call_id=excluded.tool_call_id; END;
CREATE TRIGGER engine_history_remove AFTER DELETE ON omp_session_files BEGIN DELETE FROM engine_history_entries WHERE session_path=OLD.path; END;
CREATE TRIGGER engine_history_move AFTER UPDATE OF path ON omp_session_files BEGIN UPDATE engine_history_entries SET session_path=NEW.path WHERE session_path=OLD.path; END;
CREATE INDEX engine_agent_parent_idx ON engine_agent_identity(parent_agent_instance_id);
CREATE INDEX engine_agent_principal_idx ON engine_agent_identity(principal_id, agent_instance_id);
CREATE INDEX engine_outbox_agent_idx ON engine_event_outbox(agent_instance_id,event_id);
CREATE INDEX engine_outbox_attempt_idx ON engine_event_outbox(attempt_id,event_id);
CREATE INDEX engine_runtime_summary_cursor_idx ON engine_event_outbox(projection_principal,event_id) WHERE summary_payload IS NOT NULL;
CREATE INDEX engine_runtime_summary_agent_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE summary_payload IS NOT NULL;
CREATE INDEX engine_runtime_detail_attempt_idx ON engine_event_outbox(attempt_id,event_id) WHERE detail_payload IS NOT NULL;
CREATE INDEX engine_runtime_membership_cursor_idx ON engine_event_outbox(projection_root,event_id) WHERE membership_payload IS NOT NULL;
CREATE INDEX engine_runtime_input_pending_idx ON engine_runtime_inputs(attempt_id,created_event_id) WHERE resolved_event_id IS NULL;
CREATE INDEX engine_runtime_branch_cursor_idx ON engine_event_outbox(projection_root,event_id);
CREATE INDEX engine_runtime_identity_ref_idx ON engine_agent_identity(agent_instance_ref);
CREATE INDEX engine_runtime_root_idx ON engine_agent_identity(root_agent_instance_ref,agent_instance_id);
CREATE INDEX engine_runtime_pending_start_idx ON engine_commands(agent_instance_id,received_at) WHERE operation='start' AND state='received';
CREATE INDEX engine_runtime_messages_page_idx ON engine_runtime_messages(attempt_id,created_event_id);
CREATE INDEX engine_runtime_message_range_idx ON engine_event_outbox(message_content_id,message_offset,event_id) WHERE message_content_id IS NOT NULL;
CREATE INDEX engine_runtime_message_data_idx ON engine_event_outbox(message_content_id,message_offset,event_id) WHERE message_end_offset>message_offset;
CREATE INDEX engine_runtime_message_revision_idx ON engine_event_outbox(message_content_id,message_revision) WHERE message_content_id IS NOT NULL;
CREATE INDEX engine_runtime_message_baseline_idx ON engine_event_outbox(attempt_id,message_id,message_block_id,message_stream,event_id) WHERE message_snapshot IS NOT NULL;
CREATE INDEX engine_commands_start_owner_idx ON engine_commands(agent_instance_id,device_id,engine_id,agent_instance_ref,received_at,command_id) WHERE operation='start';
CREATE INDEX engine_inbox_agent_page_idx ON engine_inbox_items(agent_instance_id,disposition,position,queue_id);
CREATE TRIGGER engine_history_lineage_insert AFTER INSERT ON omp_session_files BEGIN UPDATE omp_session_files SET history_lineage=lower(hex(randomblob(16))) WHERE path=NEW.path; END;
CREATE TRIGGER engine_history_lineage_replace AFTER UPDATE OF content ON omp_session_files WHEN length(NEW.content)<length(OLD.content) OR substr(NEW.content,1,length(OLD.content))<>OLD.content BEGIN UPDATE omp_session_files SET history_lineage=lower(hex(randomblob(16))) WHERE path=NEW.path; END;
CREATE INDEX engine_attempts_history_owner_idx ON engine_attempts(agent_instance_id,transcript_session_id);
CREATE TRIGGER engine_history_identity_insert AFTER INSERT ON engine_history_entries WHEN NEW.entry_type='message' BEGIN UPDATE engine_history_entries SET source_command_id=json_extract(NEW.entry_json,'$.sourceCommandId'),assistant_message_id=json_extract(NEW.entry_json,'$.assistantMessageId') WHERE session_path=NEW.session_path AND entry_id=NEW.entry_id; END;
CREATE TRIGGER engine_history_identity_update AFTER UPDATE OF entry_json ON engine_history_entries WHEN NEW.entry_type='message' BEGIN UPDATE engine_history_entries SET source_command_id=json_extract(NEW.entry_json,'$.sourceCommandId'),assistant_message_id=json_extract(NEW.entry_json,'$.assistantMessageId') WHERE session_path=NEW.session_path AND entry_id=NEW.entry_id; END;
CREATE INDEX engine_lifecycle_page_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE kind IN ('running','paused','resumed','input_requested','input_resolved','retry_scheduled','retry_settled','interrupted','completed','cancelled','failed','rejected');
CREATE INDEX engine_history_command_event_idx ON engine_event_outbox(agent_instance_id,causation_command_id,event_id);
CREATE INDEX engine_history_assistant_event_idx ON engine_event_outbox(agent_instance_id,history_assistant_id,event_id) WHERE history_assistant_id IS NOT NULL;
CREATE INDEX engine_history_message_owner_idx ON engine_runtime_messages(agent_instance_id,message_id);
CREATE INDEX engine_runtime_messages_unsettled_idx ON engine_runtime_messages(attempt_id,status,created_event_id);
CREATE INDEX engine_runtime_active_tool_idx ON engine_effects(attempt_id,effect_id) WHERE effect_kind='tool' AND state IN ('started','unknown');
CREATE INDEX engine_runtime_attempt_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE projection_kinds<>0;
CREATE INDEX engine_runtime_detail_agent_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE detail_payload IS NOT NULL;
CREATE INDEX engine_runtime_assistant_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 1)<>0;
CREATE INDEX engine_runtime_tool_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 2)<>0;
CREATE INDEX engine_runtime_state_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 4)<>0;
CREATE INDEX engine_runtime_queue_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 8)<>0;
CREATE INDEX engine_runtime_input_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 16)<>0;
CREATE INDEX engine_runtime_history_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 32)<>0;
CREATE INDEX engine_runtime_usage_cursor_idx ON engine_event_outbox(agent_instance_id,attempt_id,event_id) WHERE (projection_kinds & 64)<>0;
CREATE INDEX engine_runtime_agent_cursor_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE projection_agent_kinds<>0;
CREATE INDEX engine_runtime_agent_state_cursor_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE (projection_agent_kinds & 4)<>0;
CREATE INDEX engine_runtime_agent_queue_cursor_idx ON engine_event_outbox(agent_instance_id,event_id) WHERE (projection_agent_kinds & 8)<>0;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('engine_event_outbox',7);
COMMIT;
