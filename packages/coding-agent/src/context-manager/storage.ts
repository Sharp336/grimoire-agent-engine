import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@oh-my-pi/pi-utils";
import type {
	ContextCompartmentInput,
	ContextCompartmentRecord,
	ContextDropInput,
	ContextDropRecord,
	ContextEmbeddingRecord,
	ContextGitCommitInput,
	ContextGitCommitRecord,
	ContextJobInput,
	ContextJobKind,
	ContextJobRecord,
	ContextJobStatus,
	ContextNoteInput,
	ContextNoteRecord,
	ContextOnWireStats,
	ContextProjectIdentity,
	ContextSearchDocumentInput,
	ContextSearchDocumentRecord,
	ContextSearchDocumentSource,
	ContextSearchFtsRecord,
	ContextSessionFactInput,
	ContextSessionFactRecord,
	ContextSessionInput,
	ContextSessionRecord,
	ContextSessionRuntimeRecord,
	ContextSourceContentRecord,
	ContextStoreDiagnostics,
	MessageTagRecord,
	StoredContextProject,
} from "./types";

export const CONTEXT_STORE_SCHEMA_VERSION = 5;

export interface ContextStoreOpenOptions {
	readonly path?: string | ":memory:";
	readonly cacheSizeMb?: number;
	readonly mmapSizeMb?: number;
}

export interface ReconcileMessageTagInput {
	readonly sessionId: string;
	readonly entryId?: string;
	readonly preferredTagOrdinal?: number;
	readonly contentHash: string;
	readonly role: string;
	readonly turnIndex: number;
	readonly tokenCount: number;
}

export interface ContextBranchCopyResult {
	readonly copied: boolean;
	readonly tags: number;
	readonly drops: number;
	readonly compartments: number;
	readonly generation: number;
}

export interface ContextSessionRuntimeInput extends ContextOnWireStats {
	readonly sessionId: string;
	readonly modelKey: string;
	readonly contextLimit: number;
	readonly pressurePercent: number;
	readonly executeThresholdTokens: number;
	readonly cacheTtlMs: number;
}

interface ProjectRow {
	id: string;
	kind: "git" | "directory";
	canonical_identity: string;
	last_known_root: string;

	primary_root: string | null;
	root_commit: string | null;
	remote_identity: string | null;
	created_at: number;
	updated_at: number;
}

interface SessionRow {
	id: string;
	project_id: string;
	session_file: string | null;
	mode: "primary" | "child";
	current_leaf_entry_id: string | null;
	active_generation: number;
	schema_version: number;
	historian_version: number;
	last_seen_at: number;
}

interface MessageTagRow {
	session_id: string;
	tag_ordinal: number;
	entry_id: string | null;
	content_hash: string;
	role: string;
	turn_index: number;
	token_count: number;
	created_at: number;
	superseded_at: number | null;
	auto_search_hint: string | null;
	search_generation: number | null;
}

interface DropOpRow {
	id: number;
	session_id: string;
	target_tag: number;
	expanded_tags_json: string;
	reason: string | null;
	source: ContextDropRecord["source"];
	scope_leaf_entry_id: string;
	replacement_text: string | null;
	clear_reasoning: number;
	status: ContextDropRecord["status"];
	eligible_at: number;
	generation: number;
	created_at: number;
}

interface SourceContentRow {
	session_id: string;
	tag_ordinal: number;
	content_hash: string;
	session_entry_id: string | null;
	placeholder: string | null;
	created_at: number;
}

interface CompartmentRow {
	id: string;
	session_id: string;
	scope_leaf_entry_id: string;
	start_tag: number;
	end_tag: number;
	tag_ordinals_json: string;
	title: string;
	p1: string;
	p2: string;
	p3: string;
	start_date: string | null;
	end_date: string | null;
	p1_tokens: number;
	p2_tokens: number;
	p3_tokens: number;
	source_hash: string;
	historian_version: number;
	generation: number;
	active: number;
	materialized: number;
	created_at: number;
}

interface SessionFactRow {
	id: string;
	session_id: string;
	project_id: string;
	generation: number;
	text: string;
	category: ContextSessionFactRecord["category"];
	confidence: number;
	scope: ContextSessionFactRecord["scope"];
	start_tag: number;
	end_tag: number;
	source_tags_json: string;
	promotion_evidence_json: string;
	canonical_memory_id: string | null;
	retrieval_count: number;
	created_at: number;
	updated_at: number;
}

interface StagedSessionFactRow {
	request_id: string;
	id: string;
	session_id: string;
	project_id: string;
	generation: number;
	text: string;
	category: ContextSessionFactRecord["category"];
	confidence: number;
	scope: ContextSessionFactRecord["scope"];
	start_tag: number;
	end_tag: number;
	source_tags_json: string;
	staged_at: number;
}

interface PublishedCompartmentRow extends CompartmentRow {
	request_id: string;
}

interface NextTagOrdinalRow {
	next_ordinal: number;
}

interface SessionRuntimeRow {
	session_id: string;
	model_key: string;
	context_limit: number;
	conversation_tokens: number;
	tool_call_tokens: number;
	non_message_tokens: number;
	total_tokens: number;
	pressure_percent: number;
	execute_threshold_tokens: number;
	cache_ttl_ms: number;
	pending_since: number | null;
	last_materialized_at: number | null;
	cleanup_watermark_tag: number;
	updated_at: number;
}

interface CountRow {
	count: number;
}

interface GenerationRow {
	active_generation: number;
}

interface JobRow {
	id: string;
	project_id: string;
	session_id: string | null;
	kind: ContextJobKind;
	task: string | null;
	payload_json: string | null;
	status: ContextJobStatus;
	next_due_at: number | null;
	lease_owner: string | null;
	lease_until: number | null;
	heartbeat_at: number | null;
	attempt: number;
	last_error: string | null;
	progress: number;
	created_at: number;
	updated_at: number;
}

interface SearchDocumentRow {
	id: string;
	project_id: string;
	session_id: string | null;
	source: ContextSearchDocumentSource;
	source_id: string;
	canonical_id: string | null;
	content_hash: string;
	title: string;
	text: string;
	start_tag: number | null;
	end_tag: number | null;
	generation: number;
	active: number;
	created_at: number;
	updated_at: number;
}

interface SearchFtsRow extends SearchDocumentRow {
	rank: number;
}

interface EmbeddingRow {
	document_id: string;
	provider: string;
	model: string;
	dimension: number;
	vector: Uint8Array;
	content_hash: string;
	created_at: number;
}

interface EmbeddedSearchRow extends SearchDocumentRow {
	embedding_document_id: string;
	embedding_provider: string;
	embedding_model: string;
	embedding_dimension: number;
	embedding_vector: Uint8Array;
	embedding_content_hash: string;
	embedding_created_at: number;
}

interface NoteRow {
	id: string;
	project_id: string;
	session_id: string | null;
	scope: ContextNoteRecord["scope"];
	category: string;
	content: string;
	surface_condition: string | null;
	status: ContextNoteRecord["status"];
	created_at: number;
	updated_at: number;
}

interface GitCommitRow {
	project_id: string;
	sha: string;
	subject: string;
	body: string;
	author: string;
	committed_at: number;
	indexed_at: number;
}

interface UserVersionRow {
	user_version: number;
}

interface TableInfoRow {
	name: string;
}

interface JournalModeRow {
	journal_mode: string;
}

const SESSION_RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_runtime (
	session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
	model_key TEXT NOT NULL,
	context_limit INTEGER NOT NULL,
	conversation_tokens INTEGER NOT NULL,
	tool_call_tokens INTEGER NOT NULL,
	non_message_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	pressure_percent REAL NOT NULL,
	execute_threshold_tokens INTEGER NOT NULL,
	cache_ttl_ms INTEGER NOT NULL,
	pending_since INTEGER,
	last_materialized_at INTEGER,
	cleanup_watermark_tag INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);
`;

const HISTORIAN_STAGING_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_fact_staging (
	request_id TEXT NOT NULL,
	id TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	text TEXT NOT NULL,
	category TEXT NOT NULL,
	confidence REAL NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('session', 'project', 'user')),
	start_tag INTEGER NOT NULL,
	end_tag INTEGER NOT NULL,
	source_tags_json TEXT NOT NULL,
	staged_at INTEGER NOT NULL,
	PRIMARY KEY (request_id, id),
	CHECK (start_tag <= end_tag)
);
CREATE INDEX IF NOT EXISTS session_fact_staging_session_idx
	ON session_fact_staging(session_id, request_id, start_tag);
`;

const JOB_DOMAIN_LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS job_domain_leases (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	domain TEXT NOT NULL,
	lease_owner TEXT NOT NULL,
	lease_until INTEGER NOT NULL,
	heartbeat_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, domain)
);
CREATE INDEX IF NOT EXISTS job_domain_leases_expiry_idx ON job_domain_leases(lease_until);
`;

const INITIAL_SCHEMA = `
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('git', 'directory')),
	canonical_identity TEXT NOT NULL UNIQUE,
	last_known_root TEXT NOT NULL,
	primary_root TEXT,
	root_commit TEXT,
	remote_identity TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	session_file TEXT,
	mode TEXT NOT NULL CHECK (mode IN ('primary', 'child')),
	current_leaf_entry_id TEXT,
	active_generation INTEGER NOT NULL DEFAULT 0,
	schema_version INTEGER NOT NULL DEFAULT 1,
	historian_version INTEGER NOT NULL DEFAULT 1,
	last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_project_seen_idx ON sessions(project_id, last_seen_at DESC);
${SESSION_RUNTIME_SCHEMA}

CREATE TABLE message_tags (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	tag_ordinal INTEGER NOT NULL,
	entry_id TEXT,
	content_hash TEXT NOT NULL,
	role TEXT NOT NULL,
	turn_index INTEGER NOT NULL,
	token_count INTEGER NOT NULL DEFAULT 0,
	auto_search_hint TEXT,
	search_generation INTEGER,
	created_at INTEGER NOT NULL,
	superseded_at INTEGER,
	PRIMARY KEY (session_id, tag_ordinal),
	UNIQUE (session_id, entry_id, content_hash)
);
CREATE INDEX message_tags_entry_idx ON message_tags(session_id, entry_id);

CREATE TABLE drop_ops (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	target_tag INTEGER NOT NULL,
	expanded_tags_json TEXT NOT NULL,
	reason TEXT,
	source TEXT NOT NULL,
	scope_leaf_entry_id TEXT NOT NULL,
	replacement_text TEXT,
	clear_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (clear_reasoning IN (0, 1)),
	status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'superseded')),
	eligible_at INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX drop_ops_active_idx ON drop_ops(session_id, generation, status, eligible_at);

CREATE TABLE source_contents (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	tag_ordinal INTEGER NOT NULL,
	content_hash TEXT NOT NULL,
	session_entry_id TEXT,
	placeholder TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, tag_ordinal, content_hash)
);

CREATE TABLE compartments (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	scope_leaf_entry_id TEXT NOT NULL,
	start_tag INTEGER NOT NULL,
	end_tag INTEGER NOT NULL,
	tag_ordinals_json TEXT NOT NULL DEFAULT '[]',
	title TEXT NOT NULL,
	p1 TEXT NOT NULL,
	p2 TEXT NOT NULL,
	p3 TEXT NOT NULL,
	start_date TEXT,
	end_date TEXT,
	p1_tokens INTEGER NOT NULL,
	p2_tokens INTEGER NOT NULL,
	p3_tokens INTEGER NOT NULL,
	source_hash TEXT NOT NULL,
	historian_version INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
	materialized INTEGER NOT NULL DEFAULT 1 CHECK (materialized IN (0, 1)),
	created_at INTEGER NOT NULL,
	CHECK (start_tag <= end_tag)
);
CREATE INDEX compartments_active_idx ON compartments(session_id, generation, active, materialized, start_tag);

CREATE TABLE compartment_staging (
	request_id TEXT NOT NULL,
	id TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	scope_leaf_entry_id TEXT NOT NULL,
	start_tag INTEGER NOT NULL,
	end_tag INTEGER NOT NULL,
	tag_ordinals_json TEXT NOT NULL DEFAULT '[]',
	title TEXT NOT NULL,
	p1 TEXT NOT NULL,
	p2 TEXT NOT NULL,
	p3 TEXT NOT NULL,
	start_date TEXT,
	end_date TEXT,
	p1_tokens INTEGER NOT NULL,
	p2_tokens INTEGER NOT NULL,
	p3_tokens INTEGER NOT NULL,
	source_hash TEXT NOT NULL,
	historian_version INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	staged_at INTEGER NOT NULL,
	PRIMARY KEY (request_id, id),
	CHECK (start_tag <= end_tag)
);
CREATE INDEX compartment_staging_session_idx ON compartment_staging(session_id, request_id, start_tag);

CREATE TABLE session_facts (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	text TEXT NOT NULL,
	category TEXT NOT NULL,
	confidence REAL NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('session', 'project', 'user')),
	start_tag INTEGER NOT NULL,
	end_tag INTEGER NOT NULL,
	source_tags_json TEXT NOT NULL DEFAULT '[]',
	promotion_evidence_json TEXT NOT NULL DEFAULT '[]',
	canonical_memory_id TEXT,
	retrieval_count INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK (start_tag <= end_tag)
);
CREATE INDEX session_facts_project_idx ON session_facts(project_id, canonical_memory_id, updated_at DESC);

CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	scope TEXT NOT NULL CHECK (scope IN ('project', 'session')),
	category TEXT NOT NULL,
	content TEXT NOT NULL,
	surface_condition TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'dismissed')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX notes_surface_idx ON notes(project_id, status, updated_at DESC);

CREATE TABLE search_documents (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	source TEXT NOT NULL CHECK (source IN ('compartment', 'session_fact', 'note', 'git_commit')),
	source_id TEXT NOT NULL,
	canonical_id TEXT,
	content_hash TEXT NOT NULL,
	title TEXT NOT NULL,
	text TEXT NOT NULL,
	start_tag INTEGER,
	end_tag INTEGER,
	generation INTEGER NOT NULL,
	active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (source, source_id, generation)
);
CREATE INDEX search_documents_scope_idx ON search_documents(project_id, session_id, source, active);
CREATE VIRTUAL TABLE search_fts USING fts5(document_id UNINDEXED, title, text, tokenize='unicode61');
CREATE TRIGGER search_documents_ai AFTER INSERT ON search_documents BEGIN
	INSERT INTO search_fts(document_id, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER search_documents_ad AFTER DELETE ON search_documents BEGIN
	DELETE FROM search_fts WHERE document_id = old.id;
END;
CREATE TRIGGER search_documents_au AFTER UPDATE OF title, text ON search_documents BEGIN
	DELETE FROM search_fts WHERE document_id = old.id;
	INSERT INTO search_fts(document_id, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TABLE embeddings (
	document_id TEXT NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	dimension INTEGER NOT NULL,
	vector BLOB NOT NULL,
	content_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (document_id, provider, model)
);

CREATE TABLE git_commits (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	sha TEXT NOT NULL,
	subject TEXT NOT NULL,
	body TEXT NOT NULL,
	author TEXT NOT NULL,
	committed_at INTEGER NOT NULL,
	indexed_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, sha)
);
CREATE INDEX git_commits_time_idx ON git_commits(project_id, committed_at DESC);

CREATE TABLE jobs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	task TEXT,
	payload_json TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
	next_due_at INTEGER,
	lease_owner TEXT,
	lease_until INTEGER,
	heartbeat_at INTEGER,
	attempt INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	progress REAL NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_due_idx ON jobs(status, next_due_at, lease_until);
CREATE INDEX jobs_scope_idx ON jobs(project_id, session_id, kind, task, updated_at DESC);
${JOB_DOMAIN_LEASE_SCHEMA}

CREATE TABLE project_bank_bindings (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	bank_id TEXT NOT NULL UNIQUE,
	legacy_identity TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

export function getDefaultContextStorePath(): string {
	return path.join(getConfigRootDir(), "context", "context.db");
}

function migrate(db: Database): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()?.user_version ?? 0;
		if (version > CONTEXT_STORE_SCHEMA_VERSION) {
			throw new Error(
				`Context database schema ${version} is newer than supported schema ${CONTEXT_STORE_SCHEMA_VERSION}`,
			);
		}
		if (version < 1) db.exec(INITIAL_SCHEMA);
		if (version < 2) {
			db.exec(SESSION_RUNTIME_SCHEMA);
			if (version >= 1) {
				const dropColumns = new Set(
					db
						.query<TableInfoRow, []>("PRAGMA table_info(drop_ops)")
						.all()
						.map(row => row.name),
				);
				if (!dropColumns.has("replacement_text")) {
					db.exec("ALTER TABLE drop_ops ADD COLUMN replacement_text TEXT");
				}
				if (!dropColumns.has("clear_reasoning")) {
					db.exec(
						"ALTER TABLE drop_ops ADD COLUMN clear_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (clear_reasoning IN (0, 1))",
					);
				}
			}
		}
		if (version < 3) {
			const compartmentColumns = new Set(
				db
					.query<TableInfoRow, []>("PRAGMA table_info(compartments)")
					.all()
					.map(row => row.name),
			);
			if (!compartmentColumns.has("tag_ordinals_json")) {
				db.exec("ALTER TABLE compartments ADD COLUMN tag_ordinals_json TEXT NOT NULL DEFAULT '[]'");
			}
			if (!compartmentColumns.has("materialized")) {
				db.exec(
					"ALTER TABLE compartments ADD COLUMN materialized INTEGER NOT NULL DEFAULT 1 CHECK (materialized IN (0, 1))",
				);
			}
			const stagingColumns = new Set(
				db
					.query<TableInfoRow, []>("PRAGMA table_info(compartment_staging)")
					.all()
					.map(row => row.name),
			);
			if (!stagingColumns.has("tag_ordinals_json")) {
				db.exec("ALTER TABLE compartment_staging ADD COLUMN tag_ordinals_json TEXT NOT NULL DEFAULT '[]'");
			}
			const factColumns = new Set(
				db
					.query<TableInfoRow, []>("PRAGMA table_info(session_facts)")
					.all()
					.map(row => row.name),
			);
			if (!factColumns.has("source_tags_json")) {
				db.exec("ALTER TABLE session_facts ADD COLUMN source_tags_json TEXT NOT NULL DEFAULT '[]'");
			}
			db.exec(HISTORIAN_STAGING_SCHEMA);
			db.exec("DROP INDEX IF EXISTS compartments_active_idx");
			db.exec(
				"CREATE INDEX compartments_active_idx ON compartments(session_id, generation, active, materialized, start_tag)",
			);
		}
		if (version < 4) {
			const searchColumns = new Set(
				db
					.query<TableInfoRow, []>("PRAGMA table_info(search_documents)")
					.all()
					.map(row => row.name),
			);
			if (!searchColumns.has("canonical_id")) {
				db.exec("ALTER TABLE search_documents ADD COLUMN canonical_id TEXT");
			}
			if (!searchColumns.has("start_tag")) {
				db.exec("ALTER TABLE search_documents ADD COLUMN start_tag INTEGER");
			}
			if (!searchColumns.has("end_tag")) {
				db.exec("ALTER TABLE search_documents ADD COLUMN end_tag INTEGER");
			}
		}
		if (version < 5) db.exec(JOB_DOMAIN_LEASE_SCHEMA);
		if (version < CONTEXT_STORE_SCHEMA_VERSION) {
			db.exec(`PRAGMA user_version = ${CONTEXT_STORE_SCHEMA_VERSION}`);
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the migration error if SQLite already rolled the transaction back.
		}
		throw error;
	}
}

function parsePayload(value: string | null): unknown {
	if (value === null) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parseTagOrdinals(value: string): number[] {
	const parsed = parsePayload(value);
	return Array.isArray(parsed) ? parsed.filter((tag): tag is number => Number.isSafeInteger(tag)) : [];
}

function projectFromRow(row: ProjectRow): StoredContextProject {
	return {
		id: row.id,
		kind: row.kind,
		canonicalIdentity: row.canonical_identity,
		cwd: row.last_known_root,
		root: row.last_known_root,
		primaryRoot: row.primary_root ?? undefined,
		rootCommit: row.root_commit ?? undefined,
		remoteIdentity: row.remote_identity ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function sessionFromRow(row: SessionRow): ContextSessionRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionFile: row.session_file ?? undefined,
		mode: row.mode,
		currentLeafEntryId: row.current_leaf_entry_id ?? undefined,
		activeGeneration: row.active_generation,
		schemaVersion: row.schema_version,
		historianVersion: row.historian_version,
		lastSeenAt: row.last_seen_at,
	};
}

function sessionRuntimeFromRow(row: SessionRuntimeRow): ContextSessionRuntimeRecord {
	return {
		sessionId: row.session_id,
		modelKey: row.model_key,
		contextLimit: row.context_limit,
		conversationTokens: row.conversation_tokens,
		toolCallTokens: row.tool_call_tokens,
		nonMessageTokens: row.non_message_tokens,
		totalTokens: row.total_tokens,
		pressurePercent: row.pressure_percent,
		executeThresholdTokens: row.execute_threshold_tokens,
		cacheTtlMs: row.cache_ttl_ms,
		pendingSince: row.pending_since ?? undefined,
		lastMaterializedAt: row.last_materialized_at ?? undefined,
		cleanupWatermarkTag: row.cleanup_watermark_tag,
		updatedAt: row.updated_at,
	};
}

function messageTagFromRow(row: MessageTagRow): MessageTagRecord {
	return {
		sessionId: row.session_id,
		entryId: row.entry_id ?? undefined,
		tagOrdinal: row.tag_ordinal,
		contentHash: row.content_hash,
		role: row.role,
		turnIndex: row.turn_index,
		tokenCount: row.token_count,
		createdAt: row.created_at,
		supersededAt: row.superseded_at ?? undefined,
	};
}

function dropOpFromRow(row: DropOpRow): ContextDropRecord {
	const parsedTags = parsePayload(row.expanded_tags_json);
	const expandedTags = Array.isArray(parsedTags)
		? parsedTags.filter((tag): tag is number => Number.isSafeInteger(tag))
		: [];
	return {
		id: row.id,
		sessionId: row.session_id,
		targetTag: row.target_tag,
		expandedTags,
		reason: row.reason ?? undefined,
		source: row.source,
		scopeLeafEntryId: row.scope_leaf_entry_id,
		replacementText: row.replacement_text ?? undefined,
		clearReasoning: row.clear_reasoning === 1,
		status: row.status,
		eligibleAt: row.eligible_at,
		generation: row.generation,
		createdAt: row.created_at,
	};
}

function compartmentFromRow(row: CompartmentRow): ContextCompartmentRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		scopeLeafEntryId: row.scope_leaf_entry_id,
		startTag: row.start_tag,
		endTag: row.end_tag,
		tagOrdinals: parseTagOrdinals(row.tag_ordinals_json),
		title: row.title,
		p1: row.p1,
		p2: row.p2,
		p3: row.p3,
		startDate: row.start_date ?? undefined,
		endDate: row.end_date ?? undefined,
		p1Tokens: row.p1_tokens,
		p2Tokens: row.p2_tokens,
		p3Tokens: row.p3_tokens,
		sourceHash: row.source_hash,
		historianVersion: row.historian_version,
		generation: row.generation,
		active: row.active === 1,
		createdAt: row.created_at,
	};
}

function sessionFactFromRow(row: SessionFactRow): ContextSessionFactRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		projectId: row.project_id,
		generation: row.generation,
		text: row.text,
		category: row.category,
		confidence: row.confidence,
		scope: row.scope,
		startTag: row.start_tag,
		endTag: row.end_tag,
		sourceTags: parseTagOrdinals(row.source_tags_json),
		canonicalMemoryId: row.canonical_memory_id ?? undefined,
		retrievalCount: row.retrieval_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function sourceContentFromRow(row: SourceContentRow): ContextSourceContentRecord {
	return {
		sessionId: row.session_id,
		tagOrdinal: row.tag_ordinal,
		contentHash: row.content_hash,
		sessionEntryId: row.session_entry_id ?? undefined,
		placeholder: row.placeholder ?? undefined,
		createdAt: row.created_at,
	};
}

function jobFromRow(row: JobRow): ContextJobRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id ?? undefined,
		kind: row.kind,
		task: row.task ?? undefined,
		payload: parsePayload(row.payload_json),
		status: row.status,
		nextDueAt: row.next_due_at ?? undefined,
		leaseOwner: row.lease_owner ?? undefined,
		leaseUntil: row.lease_until ?? undefined,
		heartbeatAt: row.heartbeat_at ?? undefined,
		attempt: row.attempt,
		lastError: row.last_error ?? undefined,
		progress: row.progress,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function hashSearchText(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function searchDocumentId(source: ContextSearchDocumentSource, sourceId: string, generation: number): string {
	return new Bun.CryptoHasher("sha256").update(`${source}\0${sourceId}\0${generation}`).digest("hex");
}

function searchDocumentFromRow(row: SearchDocumentRow): ContextSearchDocumentRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id ?? undefined,
		source: row.source,
		sourceId: row.source_id,
		canonicalId: row.canonical_id ?? undefined,
		contentHash: row.content_hash,
		title: row.title,
		text: row.text,
		startTag: row.start_tag ?? undefined,
		endTag: row.end_tag ?? undefined,
		generation: row.generation,
		active: row.active === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function embeddingFromRow(row: EmbeddingRow): ContextEmbeddingRecord {
	const bytes = row.vector;
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	return {
		documentId: row.document_id,
		provider: row.provider,
		model: row.model,
		dimension: row.dimension,
		vector: new Float32Array(buffer),
		contentHash: row.content_hash,
		createdAt: row.created_at,
	};
}

function noteFromRow(row: NoteRow): ContextNoteRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id ?? undefined,
		scope: row.scope,
		category: row.category,
		content: row.content,
		surfaceCondition: row.surface_condition ?? undefined,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function gitCommitFromRow(row: GitCommitRow): ContextGitCommitRecord {
	return {
		projectId: row.project_id,
		sha: row.sha,
		subject: row.subject,
		body: row.body,
		author: row.author,
		committedAt: row.committed_at,
		indexedAt: row.indexed_at,
	};
}

export class ContextStore {
	readonly path: string | ":memory:";
	#db: Database;
	#transactionDepth = 0;
	#closed = false;

	private constructor(db: Database, dbPath: string | ":memory:") {
		this.#db = db;
		this.path = dbPath;
	}

	static async open(options: ContextStoreOpenOptions = {}): Promise<ContextStore> {
		const dbPath = options.path ?? getDefaultContextStorePath();
		if (dbPath !== ":memory:") {
			const directory = path.dirname(dbPath);
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await fs.chmod(directory, 0o700);
		}

		const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			db.exec("PRAGMA foreign_keys = ON");
			const configuredCacheSizeMb = options.cacheSizeMb;
			const cacheSizeMb =
				typeof configuredCacheSizeMb === "number" && Number.isFinite(configuredCacheSizeMb)
					? Math.min(2048, Math.max(2, Math.floor(configuredCacheSizeMb)))
					: 64;
			db.exec(`PRAGMA cache_size = -${cacheSizeMb * 1024}`);
			const configuredMmapSizeMb = options.mmapSizeMb;
			const mmapSizeMb =
				typeof configuredMmapSizeMb === "number" && Number.isFinite(configuredMmapSizeMb)
					? Math.min(
							Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024)),
							Math.max(0, Math.floor(configuredMmapSizeMb)),
						)
					: 0;
			if (mmapSizeMb > 0) db.exec(`PRAGMA mmap_size = ${mmapSizeMb * 1024 * 1024}`);
			migrate(db);
			const store = new ContextStore(db, dbPath);
			await store.ensureFilePermissions();
			return store;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	get closed(): boolean {
		return this.#closed;
	}

	transaction<T>(body: (db: Database) => T, mode: "deferred" | "immediate" = "immediate"): T {
		this.#assertOpen();
		if (this.#transactionDepth > 0) return body(this.#db);
		this.#db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
		this.#transactionDepth++;
		try {
			const result = body(this.#db);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.#db.exec("ROLLBACK");
			} catch {
				// Preserve the original transaction error.
			}
			throw error;
		} finally {
			this.#transactionDepth--;
		}
	}

	registerProject(identity: ContextProjectIdentity, now = Date.now()): StoredContextProject {
		this.#assertOpen();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO projects (
	id, kind, canonical_identity, last_known_root, primary_root, root_commit, remote_identity, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	kind = excluded.kind,
	canonical_identity = excluded.canonical_identity,
	last_known_root = excluded.last_known_root,
	primary_root = excluded.primary_root,
	root_commit = excluded.root_commit,
	remote_identity = excluded.remote_identity,
	updated_at = excluded.updated_at
`)
			.run(
				identity.id,
				identity.kind,
				identity.canonicalIdentity,
				identity.root,
				identity.primaryRoot ?? null,
				identity.rootCommit ?? null,
				identity.remoteIdentity ?? null,
				now,
				now,
			);
		const project = this.getProject(identity.id);
		if (!project) throw new Error(`Failed to register context project ${identity.id}`);
		return project;
	}

	getProject(projectId: string): StoredContextProject | undefined {
		this.#assertOpen();
		const row = this.#db.prepare<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
		return row ? projectFromRow(row) : undefined;
	}

	upsertSession(input: ContextSessionInput, now = Date.now()): ContextSessionRecord {
		this.#assertOpen();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO sessions (
	id, project_id, session_file, mode, current_leaf_entry_id, active_generation, schema_version,
	historian_version, last_seen_at
) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	project_id = excluded.project_id,
	session_file = excluded.session_file,
	mode = excluded.mode,
	current_leaf_entry_id = excluded.current_leaf_entry_id,
	historian_version = excluded.historian_version,
	last_seen_at = excluded.last_seen_at
`)
			.run(
				input.id,
				input.projectId,
				input.sessionFile ?? null,
				input.mode,
				input.currentLeafEntryId ?? null,
				CONTEXT_STORE_SCHEMA_VERSION,
				input.historianVersion ?? 1,
				now,
			);
		const session = this.getSession(input.id);
		if (!session) throw new Error(`Failed to register context session ${input.id}`);
		return session;
	}

	getSession(sessionId: string): ContextSessionRecord | undefined {
		this.#assertOpen();
		const row = this.#db.prepare<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
		return row ? sessionFromRow(row) : undefined;
	}

	getSessionRuntime(sessionId: string): ContextSessionRuntimeRecord | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<SessionRuntimeRow, [string]>("SELECT * FROM session_runtime WHERE session_id = ?")
			.get(sessionId);
		return row ? sessionRuntimeFromRow(row) : undefined;
	}

	updateSessionRuntime(input: ContextSessionRuntimeInput, now = Date.now()): ContextSessionRuntimeRecord {
		this.#assertOpen();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO session_runtime (
	session_id, model_key, context_limit, conversation_tokens, tool_call_tokens,
	non_message_tokens, total_tokens, pressure_percent, execute_threshold_tokens, cache_ttl_ms, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	model_key = excluded.model_key,
	context_limit = excluded.context_limit,
	conversation_tokens = excluded.conversation_tokens,
	tool_call_tokens = excluded.tool_call_tokens,
	non_message_tokens = excluded.non_message_tokens,
	total_tokens = excluded.total_tokens,
	pressure_percent = excluded.pressure_percent,
	execute_threshold_tokens = excluded.execute_threshold_tokens,
	cache_ttl_ms = excluded.cache_ttl_ms,
	updated_at = excluded.updated_at
`)
			.run(
				input.sessionId,
				input.modelKey,
				Math.max(0, Math.floor(input.contextLimit)),
				Math.max(0, Math.floor(input.conversationTokens)),
				Math.max(0, Math.floor(input.toolCallTokens)),
				Math.max(0, Math.floor(input.nonMessageTokens)),
				Math.max(0, Math.floor(input.totalTokens)),
				Number.isFinite(input.pressurePercent) ? Math.max(0, input.pressurePercent) : 0,
				Math.max(0, Math.floor(input.executeThresholdTokens)),
				Math.max(0, Math.floor(input.cacheTtlMs)),
				now,
			);
		const runtime = this.getSessionRuntime(input.sessionId);
		if (!runtime) throw new Error(`Failed to update runtime metrics for context session ${input.sessionId}`);
		return runtime;
	}

	markSessionMaterializationPending(sessionId: string, now = Date.now()): void {
		this.#assertOpen();
		this.#db
			.prepare<never, [number, number, string]>(
				"UPDATE session_runtime SET pending_since = COALESCE(pending_since, ?), updated_at = ? WHERE session_id = ?",
			)
			.run(now, now, sessionId);
	}

	markSessionMaterialized(sessionId: string, now = Date.now(), preservePending = false): void {
		this.#assertOpen();
		const sql = preservePending
			? "UPDATE session_runtime SET last_materialized_at = ?, updated_at = ? WHERE session_id = ?"
			: "UPDATE session_runtime SET pending_since = NULL, last_materialized_at = ?, updated_at = ? WHERE session_id = ?";
		this.#db.prepare<never, [number, number, string]>(sql).run(now, now, sessionId);
	}
	markAutomaticCleanupScanned(sessionId: string, tagOrdinal: number, now = Date.now()): void {
		this.#assertOpen();
		this.#db
			.prepare<never, [number, number, string]>(`
UPDATE session_runtime
SET cleanup_watermark_tag = MAX(cleanup_watermark_tag, ?), updated_at = ?
WHERE session_id = ?
`)
			.run(tagOrdinal, now, sessionId);
	}

	getMessageTag(sessionId: string, tagOrdinal: number): MessageTagRecord | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<MessageTagRow, [string, number]>(
				"SELECT * FROM message_tags WHERE session_id = ? AND tag_ordinal = ?",
			)
			.get(sessionId, tagOrdinal);
		return row ? messageTagFromRow(row) : undefined;
	}

	getMessageTagByEntry(sessionId: string, entryId: string, contentHash: string): MessageTagRecord | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<MessageTagRow, [string, string, string]>(
				"SELECT * FROM message_tags WHERE session_id = ? AND entry_id = ? AND content_hash = ?",
			)
			.get(sessionId, entryId, contentHash);
		return row ? messageTagFromRow(row) : undefined;
	}

	listMessageTags(sessionId: string): MessageTagRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<MessageTagRow, [string]>("SELECT * FROM message_tags WHERE session_id = ? ORDER BY tag_ordinal")
			.all(sessionId)
			.map(messageTagFromRow);
	}

	reconcileMessageTag(input: ReconcileMessageTagInput, now = Date.now()): MessageTagRecord {
		return this.transaction(db => {
			if (input.entryId) {
				const existing = db
					.prepare<MessageTagRow, [string, string, string]>(
						"SELECT * FROM message_tags WHERE session_id = ? AND entry_id = ? AND content_hash = ?",
					)
					.get(input.sessionId, input.entryId, input.contentHash);
				if (existing) return messageTagFromRow(existing);
			}

			if (input.preferredTagOrdinal !== undefined) {
				const preferred = db
					.prepare<MessageTagRow, [string, number]>(
						"SELECT * FROM message_tags WHERE session_id = ? AND tag_ordinal = ?",
					)
					.get(input.sessionId, input.preferredTagOrdinal);
				const canReuse =
					preferred?.content_hash === input.contentHash &&
					(input.entryId === undefined || preferred.entry_id === null || preferred.entry_id === input.entryId);
				if (preferred && canReuse) {
					if (input.entryId && preferred.entry_id === null) {
						db.prepare<never, [string, string, number]>(
							"UPDATE message_tags SET entry_id = ? WHERE session_id = ? AND tag_ordinal = ?",
						).run(input.entryId, input.sessionId, input.preferredTagOrdinal);
						preferred.entry_id = input.entryId;
					}
					return messageTagFromRow(preferred);
				}
			}

			if (input.entryId) {
				db.prepare<never, [number, string, string, string]>(`
UPDATE message_tags SET superseded_at = ?
WHERE session_id = ? AND entry_id = ? AND content_hash <> ? AND superseded_at IS NULL
`).run(now, input.sessionId, input.entryId, input.contentHash);
			}

			const nextOrdinal =
				db
					.prepare<NextTagOrdinalRow, [string]>(
						"SELECT COALESCE(MAX(tag_ordinal), 0) + 1 AS next_ordinal FROM message_tags WHERE session_id = ?",
					)
					.get(input.sessionId)?.next_ordinal ?? 1;
			db.prepare<never, SQLQueryBindings[]>(`
INSERT INTO message_tags (
	session_id, tag_ordinal, entry_id, content_hash, role, turn_index, token_count, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
				input.sessionId,
				nextOrdinal,
				input.entryId ?? null,
				input.contentHash,
				input.role,
				input.turnIndex,
				input.tokenCount,
				now,
			);
			const inserted = db
				.prepare<MessageTagRow, [string, number]>(
					"SELECT * FROM message_tags WHERE session_id = ? AND tag_ordinal = ?",
				)
				.get(input.sessionId, nextOrdinal);
			if (!inserted) throw new Error(`Failed to allocate context tag ${nextOrdinal} for ${input.sessionId}`);
			return messageTagFromRow(inserted);
		});
	}

	recordSourceContent(
		tag: MessageTagRecord,
		sessionEntryId: string | undefined,
		placeholder: string | undefined,
		now = Date.now(),
	): ContextSourceContentRecord {
		this.#assertOpen();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO source_contents (
	session_id, tag_ordinal, content_hash, session_entry_id, placeholder, created_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, tag_ordinal, content_hash) DO UPDATE SET
	session_entry_id = COALESCE(excluded.session_entry_id, source_contents.session_entry_id),
	placeholder = COALESCE(excluded.placeholder, source_contents.placeholder)
`)
			.run(tag.sessionId, tag.tagOrdinal, tag.contentHash, sessionEntryId ?? null, placeholder ?? null, now);
		const content = this.getSourceContent(tag.sessionId, tag.tagOrdinal, tag.contentHash);
		if (!content) throw new Error(`Failed to record source content for §${tag.tagOrdinal}§`);
		return content;
	}

	getSourceContent(
		sessionId: string,
		tagOrdinal: number,
		contentHash: string,
	): ContextSourceContentRecord | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<SourceContentRow, [string, number, string]>(`
SELECT * FROM source_contents WHERE session_id = ? AND tag_ordinal = ? AND content_hash = ?
`)
			.get(sessionId, tagOrdinal, contentHash);
		return row ? sourceContentFromRow(row) : undefined;
	}

	insertDrop(input: ContextDropInput, now = Date.now()): ContextDropRecord {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO drop_ops (
	session_id, target_tag, expanded_tags_json, reason, source, scope_leaf_entry_id,
	replacement_text, clear_reasoning, status, eligible_at, generation, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
			.run(
				input.sessionId,
				input.targetTag,
				JSON.stringify(input.expandedTags),
				input.reason ?? null,
				input.source,
				input.scopeLeafEntryId,
				input.replacementText ?? null,
				input.clearReasoning ? 1 : 0,
				input.status,
				input.eligibleAt,
				input.generation,
				now,
			);
		const drop = this.getDrop(Number(result.lastInsertRowid));
		if (!drop) throw new Error(`Failed to record context drop for §${input.targetTag}§`);
		return drop;
	}

	getDrop(id: number): ContextDropRecord | undefined {
		this.#assertOpen();
		const row = this.#db.prepare<DropOpRow, [number]>("SELECT * FROM drop_ops WHERE id = ?").get(id);
		return row ? dropOpFromRow(row) : undefined;
	}
	listDrops(sessionId: string, generation: number): ContextDropRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<DropOpRow, [string, number]>(`
SELECT * FROM drop_ops
WHERE session_id = ? AND generation = ? AND status <> 'superseded'
ORDER BY id
`)
			.all(sessionId, generation)
			.map(dropOpFromRow);
	}

	listActiveDrops(sessionId: string, generation: number, visibleEntryIds: ReadonlySet<string>): ContextDropRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<DropOpRow, [string, number]>(
				"SELECT * FROM drop_ops WHERE session_id = ? AND generation = ? AND status = 'active' ORDER BY id",
			)
			.all(sessionId, generation)
			.filter(row => visibleEntryIds.has(row.scope_leaf_entry_id))
			.map(dropOpFromRow);
	}

	activateEligibleDrops(
		sessionId: string,
		generation: number,
		visibleEntryIds: ReadonlySet<string>,
		now = Date.now(),
		force = false,
	): number {
		return this.transaction(db => {
			const rows = db
				.prepare<DropOpRow, [string, number]>(`
SELECT * FROM drop_ops
WHERE session_id = ? AND generation = ? AND status = 'queued'
ORDER BY id
`)
				.all(sessionId, generation);
			const update = db.prepare<never, [number]>("UPDATE drop_ops SET status = 'active' WHERE id = ?");
			let activated = 0;
			for (const row of rows) {
				if (!force && row.eligible_at > now) continue;
				if (!visibleEntryIds.has(row.scope_leaf_entry_id)) continue;
				update.run(row.id);
				activated++;
			}
			return activated;
		});
	}

	cancelDropsForTags(sessionId: string, tagOrdinals: ReadonlySet<number>): number {
		return this.transaction(db => {
			const rows = db
				.prepare<DropOpRow, [string]>(
					"SELECT * FROM drop_ops WHERE session_id = ? AND status <> 'superseded' ORDER BY id",
				)
				.all(sessionId);
			const update = db.prepare<never, [number]>("UPDATE drop_ops SET status = 'superseded' WHERE id = ?");
			let cancelled = 0;
			for (const row of rows) {
				const drop = dropOpFromRow(row);
				if (!drop.expandedTags.some(tag => tagOrdinals.has(tag))) continue;
				update.run(row.id);
				cancelled++;
			}
			return cancelled;
		});
	}

	stageHistorianResult(
		requestId: string,
		compartments: readonly ContextCompartmentInput[],
		facts: readonly ContextSessionFactInput[],
		append = false,
		now = Date.now(),
	): { readonly compartmentIds: readonly string[]; readonly factIds: readonly string[] } {
		if (compartments.length === 0) throw new Error("Cannot stage an empty historian result");
		return this.transaction(db => {
			if (!append) {
				db.prepare<never, [string]>("DELETE FROM compartment_staging WHERE request_id = ?").run(requestId);
				db.prepare<never, [string]>("DELETE FROM session_fact_staging WHERE request_id = ?").run(requestId);
			}
			const insertCompartment = db.prepare<never, SQLQueryBindings[]>(`
INSERT INTO compartment_staging (
	request_id, id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json,
	title, p1, p2, p3, start_date, end_date, p1_tokens, p2_tokens, p3_tokens,
	source_hash, historian_version, generation, staged_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
			const compartmentIds: string[] = [];
			for (const compartment of compartments) {
				const id = compartment.id ?? Bun.randomUUIDv7();
				compartmentIds.push(id);
				insertCompartment.run(
					requestId,
					id,
					compartment.sessionId,
					compartment.scopeLeafEntryId,
					compartment.startTag,
					compartment.endTag,
					JSON.stringify(compartment.tagOrdinals),
					compartment.title,
					compartment.p1,
					compartment.p2,
					compartment.p3,
					compartment.startDate ?? null,
					compartment.endDate ?? null,
					compartment.p1Tokens,
					compartment.p2Tokens,
					compartment.p3Tokens,
					compartment.sourceHash,
					compartment.historianVersion,
					compartment.generation,
					now,
				);
			}
			const insertFact = db.prepare<never, SQLQueryBindings[]>(`
INSERT INTO session_fact_staging (
	request_id, id, session_id, project_id, generation, text, category, confidence,
	scope, start_tag, end_tag, source_tags_json, staged_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
			const factIds: string[] = [];
			for (const fact of facts) {
				const id = fact.id ?? Bun.randomUUIDv7();
				factIds.push(id);
				insertFact.run(
					requestId,
					id,
					fact.sessionId,
					fact.projectId,
					fact.generation,
					fact.text,
					fact.category,
					fact.confidence,
					fact.scope,
					fact.startTag,
					fact.endTag,
					JSON.stringify(fact.sourceTags),
					now,
				);
			}
			return { compartmentIds, factIds };
		});
	}

	publishHistorianResult(
		requestId: string,
		sessionId: string,
		generation: number,
		now = Date.now(),
	): { readonly compartments: number; readonly facts: number } {
		return this.transaction(db => {
			const activeGeneration = db
				.prepare<GenerationRow, [string]>("SELECT active_generation FROM sessions WHERE id = ?")
				.get(sessionId)?.active_generation;
			if (activeGeneration !== generation) {
				throw new Error(
					`Historian staging generation ${generation} is stale; active generation is ${activeGeneration}`,
				);
			}
			const staged = db
				.prepare<CompartmentRow & { request_id: string }, [string, string, number]>(`
SELECT request_id, id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json,
	title, p1, p2, p3, start_date, end_date, p1_tokens, p2_tokens, p3_tokens,
	source_hash, historian_version, generation, 1 AS active, 0 AS materialized, staged_at AS created_at
FROM compartment_staging
WHERE request_id = ? AND session_id = ? AND generation = ?
ORDER BY start_tag, id
`)
				.all(requestId, sessionId, generation);
			if (staged.length === 0) throw new Error(`Historian staging request ${requestId} is empty or stale`);
			const otherPending = db
				.prepare<CountRow, [string, number, string]>(`
SELECT COUNT(*) AS count
FROM compartments
WHERE session_id = ? AND generation = ? AND active = 1 AND materialized = 0
	AND id NOT IN (SELECT id FROM compartment_staging WHERE request_id = ?)
`)
				.get(sessionId, generation, requestId)?.count;
			if ((otherPending ?? 0) > 0) {
				throw new Error(`Another historian publication is pending for session ${sessionId}`);
			}
			const insertCompartment = db.prepare<never, [string]>(`
INSERT OR IGNORE INTO compartments (
	id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json,
	title, p1, p2, p3, start_date, end_date, p1_tokens, p2_tokens, p3_tokens,
	source_hash, historian_version, generation, active, materialized, created_at
)
SELECT id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json,
	title, p1, p2, p3, start_date, end_date, p1_tokens, p2_tokens, p3_tokens,
	source_hash, historian_version, generation, 1, 0, staged_at
FROM compartment_staging WHERE request_id = ?
`);
			insertCompartment.run(requestId);
			const existingDrop = db.prepare<CountRow, [string, number, string]>(
				"SELECT COUNT(*) AS count FROM drop_ops WHERE session_id = ? AND generation = ? AND reason = ?",
			);
			const insertDrop = db.prepare<never, SQLQueryBindings[]>(`
INSERT INTO drop_ops (
	session_id, target_tag, expanded_tags_json, reason, source, scope_leaf_entry_id,
	replacement_text, clear_reasoning, status, eligible_at, generation, created_at
) VALUES (?, ?, ?, ?, 'compartment', ?, NULL, 0, 'queued', ?, ?, ?)
`);
			for (const compartment of staged) {
				const reason = `historian:${requestId}:${compartment.id}`;
				if ((existingDrop.get(sessionId, generation, reason)?.count ?? 0) > 0) continue;
				insertDrop.run(
					sessionId,
					compartment.start_tag,
					compartment.tag_ordinals_json,
					reason,
					compartment.scope_leaf_entry_id,
					now,
					generation,
					now,
				);
			}
			db.prepare<never, [number, number, string]>(
				"UPDATE session_runtime SET pending_since = COALESCE(pending_since, ?), updated_at = ? WHERE session_id = ?",
			).run(now, now, sessionId);
			const factCount = db
				.prepare<CountRow, [string]>("SELECT COUNT(*) AS count FROM session_fact_staging WHERE request_id = ?")
				.get(requestId)?.count;
			return { compartments: staged.length, facts: factCount ?? 0 };
		});
	}

	materializePendingCompartments(
		sessionId: string,
		generation: number,
		visibleEntryIds: ReadonlySet<string>,
		now = Date.now(),
	): { readonly compartments: number; readonly facts: number } {
		return this.transaction(db => {
			const published = db
				.prepare<PublishedCompartmentRow, [string, number]>(`
SELECT staging.request_id, compartment.*
FROM compartments AS compartment
INNER JOIN compartment_staging AS staging ON staging.id = compartment.id
WHERE compartment.session_id = ? AND compartment.generation = ?
	AND compartment.active = 1 AND compartment.materialized = 0
ORDER BY compartment.created_at, staging.request_id, compartment.start_tag
`)
				.all(sessionId, generation);
			const byRequest = new Map<string, PublishedCompartmentRow[]>();
			for (const row of published) {
				const rows = byRequest.get(row.request_id) ?? [];
				rows.push(row);
				byRequest.set(row.request_id, rows);
			}
			let materializedCompartments = 0;
			let materializedFacts = 0;
			const activeDropsForRequest = db.prepare<CountRow, [string, number, string]>(`
SELECT COUNT(*) AS count FROM drop_ops
WHERE session_id = ? AND generation = ? AND status = 'active' AND reason LIKE ?
`);
			const existingCompartments = db.prepare<CompartmentRow, [string, number]>(`
SELECT * FROM compartments
WHERE session_id = ? AND generation = ? AND active = 1 AND materialized = 1
ORDER BY start_tag, id
`);
			const deactivateCompartment = db.prepare<never, [string]>("UPDATE compartments SET active = 0 WHERE id = ?");
			const materializeCompartment = db.prepare<never, [string]>(
				"UPDATE compartments SET materialized = 1 WHERE id = ? AND active = 1",
			);
			const deleteFact = db.prepare<never, [string]>("DELETE FROM session_facts WHERE id = ?");
			const insertFact = db.prepare<never, SQLQueryBindings[]>(`
INSERT OR REPLACE INTO session_facts (
	id, session_id, project_id, generation, text, category, confidence, scope,
	start_tag, end_tag, source_tags_json, promotion_evidence_json,
	canonical_memory_id, retrieval_count, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 0, ?, ?)
`);
			for (const [requestId, rows] of byRequest) {
				if (rows.some(row => !visibleEntryIds.has(row.scope_leaf_entry_id))) continue;
				const activeDropCount =
					activeDropsForRequest.get(sessionId, generation, `historian:${requestId}:%`)?.count ?? 0;
				if (activeDropCount < rows.length) continue;
				const startTag = Math.min(...rows.map(row => row.start_tag));
				const endTag = Math.max(...rows.map(row => row.end_tag));
				const newIds = new Set(rows.map(row => row.id));
				for (const existing of existingCompartments.all(sessionId, generation)) {
					if (newIds.has(existing.id)) continue;
					if (existing.end_tag < startTag || existing.start_tag > endTag) continue;
					deactivateCompartment.run(existing.id);
				}
				for (const row of rows) {
					materializeCompartment.run(row.id);
					materializedCompartments++;
				}
				const oldFacts = db
					.prepare<SessionFactRow, [string, number, number, number]>(`
SELECT * FROM session_facts
WHERE session_id = ? AND generation = ? AND end_tag >= ? AND start_tag <= ?
`)
					.all(sessionId, generation, startTag, endTag);
				for (const fact of oldFacts) deleteFact.run(fact.id);
				const stagedFacts = db
					.prepare<StagedSessionFactRow, [string]>(
						"SELECT * FROM session_fact_staging WHERE request_id = ? ORDER BY start_tag, id",
					)
					.all(requestId);
				for (const fact of stagedFacts) {
					insertFact.run(
						fact.id,
						fact.session_id,
						fact.project_id,
						fact.generation,
						fact.text,
						fact.category,
						fact.confidence,
						fact.scope,
						fact.start_tag,
						fact.end_tag,
						fact.source_tags_json,
						now,
						now,
					);
					materializedFacts++;
				}
				db.prepare<never, [string]>("DELETE FROM session_fact_staging WHERE request_id = ?").run(requestId);
				db.prepare<never, [string]>("DELETE FROM compartment_staging WHERE request_id = ?").run(requestId);
			}
			return { compartments: materializedCompartments, facts: materializedFacts };
		});
	}

	listActiveCompartments(
		sessionId: string,
		generation: number,
		visibleEntryIds: ReadonlySet<string>,
	): ContextCompartmentRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<CompartmentRow, [string, number]>(`
SELECT * FROM compartments
WHERE session_id = ? AND generation = ? AND active = 1 AND materialized = 1
ORDER BY start_tag, id
`)
			.all(sessionId, generation)
			.filter(row => visibleEntryIds.has(row.scope_leaf_entry_id))
			.map(compartmentFromRow);
	}

	listSessionFacts(sessionId: string, generation: number): ContextSessionFactRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<SessionFactRow, [string, number]>(
				"SELECT * FROM session_facts WHERE session_id = ? AND generation = ? ORDER BY start_tag, id",
			)
			.all(sessionId, generation)
			.map(sessionFactFromRow);
	}
	listUnpromotedUserFacts(limit = 500): ContextSessionFactRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<SessionFactRow, [number]>(`
SELECT f.*
FROM session_facts AS f
JOIN sessions AS s ON s.id = f.session_id AND s.active_generation = f.generation
WHERE f.scope = 'user' AND f.canonical_memory_id IS NULL
ORDER BY f.updated_at DESC, f.id
LIMIT ?
`)
			.all(Math.max(1, Math.floor(limit)))
			.map(sessionFactFromRow);
	}

	markSessionFactPromoted(
		factId: string,
		canonicalMemoryId: string,
		evidence: readonly Readonly<Record<string, unknown>>[],
		now = Date.now(),
	): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [string, string, number, string]>(`
UPDATE session_facts
SET canonical_memory_id = ?, promotion_evidence_json = ?, updated_at = ?
WHERE id = ? AND canonical_memory_id IS NULL
`)
			.run(canonicalMemoryId, JSON.stringify(evidence), now, factId);
		return Number(result.changes) === 1;
	}

	hasPendingHistorianPublication(sessionId: string, generation: number): boolean {
		this.#assertOpen();
		return (
			(this.#db
				.prepare<CountRow, [string, number]>(`
SELECT COUNT(*) AS count FROM compartments
WHERE session_id = ? AND generation = ? AND active = 1 AND materialized = 0
`)
				.get(sessionId, generation)?.count ?? 0) > 0
		);
	}

	listStagedCompartments(requestId: string): ContextCompartmentRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<CompartmentRow, [string]>(`
SELECT id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json,
	title, p1, p2, p3, start_date, end_date, p1_tokens, p2_tokens, p3_tokens,
	source_hash, historian_version, generation, 0 AS active, 0 AS materialized, staged_at AS created_at
FROM compartment_staging WHERE request_id = ? ORDER BY start_tag, id
`)
			.all(requestId)
			.map(compartmentFromRow);
	}

	listHistorianStagingRequests(sessionId: string): string[] {
		this.#assertOpen();
		return this.#db
			.prepare<{ request_id: string }, [string]>(
				"SELECT DISTINCT request_id FROM compartment_staging WHERE session_id = ? ORDER BY request_id",
			)
			.all(sessionId)
			.map(row => row.request_id);
	}

	discardHistorianStaging(requestId: string): void {
		this.transaction(db => {
			db.prepare<never, [string]>("DELETE FROM session_fact_staging WHERE request_id = ?").run(requestId);
			db.prepare<never, [string]>("DELETE FROM compartment_staging WHERE request_id = ?").run(requestId);
		});
	}

	copySessionStateForBranch(
		sourceSessionId: string,
		targetSessionId: string,
		visibleEntryIds: ReadonlySet<string>,
	): ContextBranchCopyResult {
		this.#assertOpen();
		if (sourceSessionId === targetSessionId || visibleEntryIds.size === 0) {
			return { copied: false, tags: 0, drops: 0, compartments: 0, generation: 0 };
		}
		return this.transaction(db => {
			const existingTags = db
				.prepare<CountRow, [string]>("SELECT COUNT(*) AS count FROM message_tags WHERE session_id = ?")
				.get(targetSessionId)?.count;
			if (existingTags) {
				const generation =
					db
						.prepare<GenerationRow, [string]>("SELECT active_generation FROM sessions WHERE id = ?")
						.get(targetSessionId)?.active_generation ?? 0;
				return { copied: false, tags: existingTags, drops: 0, compartments: 0, generation };
			}

			db.exec("CREATE TEMP TABLE IF NOT EXISTS context_branch_entries (entry_id TEXT PRIMARY KEY)");
			db.exec("DELETE FROM context_branch_entries");
			const insertEntry = db.prepare<never, [string]>(
				"INSERT OR IGNORE INTO context_branch_entries (entry_id) VALUES (?)",
			);
			for (const entryId of visibleEntryIds) insertEntry.run(entryId);

			const generation =
				db
					.prepare<GenerationRow, [string]>("SELECT active_generation FROM sessions WHERE id = ?")
					.get(sourceSessionId)?.active_generation ?? 0;
			const visibleTagCount =
				db
					.prepare<CountRow, [string]>(`
SELECT COUNT(*) AS count FROM message_tags
WHERE session_id = ? AND entry_id IN (SELECT entry_id FROM context_branch_entries)
`)
					.get(sourceSessionId)?.count ?? 0;
			if (visibleTagCount === 0) {
				db.exec("DELETE FROM context_branch_entries");
				return { copied: false, tags: 0, drops: 0, compartments: 0, generation: 0 };
			}

			db.prepare<never, [number, string]>("UPDATE sessions SET active_generation = ? WHERE id = ?").run(
				generation,
				targetSessionId,
			);
			db.prepare<never, [string, string]>(`
INSERT INTO session_runtime (
	session_id, model_key, context_limit, conversation_tokens, tool_call_tokens,
	non_message_tokens, total_tokens, pressure_percent, execute_threshold_tokens, cache_ttl_ms,
	pending_since, last_materialized_at, cleanup_watermark_tag, updated_at
)
SELECT ?, model_key, context_limit, conversation_tokens, tool_call_tokens,
	non_message_tokens, total_tokens, pressure_percent, execute_threshold_tokens, cache_ttl_ms,
	pending_since, last_materialized_at, cleanup_watermark_tag, updated_at
FROM session_runtime WHERE session_id = ?
ON CONFLICT(session_id) DO NOTHING
`).run(targetSessionId, sourceSessionId);
			const tagInsert = db
				.prepare<never, [string, string]>(`
INSERT INTO message_tags (
	session_id, tag_ordinal, entry_id, content_hash, role, turn_index, token_count,
	auto_search_hint, search_generation, created_at, superseded_at
)
SELECT ?, tag_ordinal, entry_id, content_hash, role, turn_index, token_count,
	auto_search_hint, search_generation, created_at, superseded_at
FROM message_tags
WHERE session_id = ? AND entry_id IN (SELECT entry_id FROM context_branch_entries)
`)
				.run(targetSessionId, sourceSessionId);
			db.prepare<never, [string, string, string]>(`
INSERT INTO source_contents (
	session_id, tag_ordinal, content_hash, session_entry_id, placeholder, created_at
)
SELECT ?, source.tag_ordinal, source.content_hash, source.session_entry_id, source.placeholder, source.created_at
FROM source_contents AS source
INNER JOIN message_tags AS tag
	ON tag.session_id = ? AND tag.tag_ordinal = source.tag_ordinal
WHERE source.session_id = ? AND tag.entry_id IN (SELECT entry_id FROM context_branch_entries)
`).run(targetSessionId, sourceSessionId, sourceSessionId);

			const dropInsert = db
				.prepare<never, [string, string, number]>(`
INSERT INTO drop_ops (
	session_id, target_tag, expanded_tags_json, reason, source, scope_leaf_entry_id,
	replacement_text, clear_reasoning, status, eligible_at, generation, created_at
)
SELECT ?, target_tag, expanded_tags_json, reason, source, scope_leaf_entry_id,
	replacement_text, clear_reasoning, status, eligible_at, generation, created_at
FROM drop_ops
WHERE session_id = ? AND generation = ? AND status <> 'superseded'
	AND scope_leaf_entry_id IN (SELECT entry_id FROM context_branch_entries)
`)
				.run(targetSessionId, sourceSessionId, generation);
			const compartmentInsert = db
				.prepare<never, [string, string, string, number]>(`
INSERT INTO compartments (
	id, session_id, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json, title, p1, p2, p3,
	start_date, end_date, p1_tokens, p2_tokens, p3_tokens, source_hash,
	historian_version, generation, active, materialized, created_at
)
SELECT ? || ':' || id, ?, scope_leaf_entry_id, start_tag, end_tag, tag_ordinals_json, title, p1, p2, p3,
	start_date, end_date, p1_tokens, p2_tokens, p3_tokens, source_hash,
	historian_version, generation, active, materialized, created_at
FROM compartments
WHERE session_id = ? AND generation = ? AND active = 1
	AND scope_leaf_entry_id IN (SELECT entry_id FROM context_branch_entries)
`)
				.run(targetSessionId, targetSessionId, sourceSessionId, generation);
			db.exec("DELETE FROM context_branch_entries");
			return {
				copied: true,
				tags: tagInsert.changes,
				drops: dropInsert.changes,
				compartments: compartmentInsert.changes,
				generation,
			};
		});
	}

	advanceSessionGeneration(sessionId: string): number {
		return this.transaction(db => {
			db.prepare<never, [string]>("UPDATE sessions SET active_generation = active_generation + 1 WHERE id = ?").run(
				sessionId,
			);
			const generation = db
				.prepare<GenerationRow, [string]>("SELECT active_generation FROM sessions WHERE id = ?")
				.get(sessionId)?.active_generation;
			if (generation === undefined) throw new Error(`Context session ${sessionId} does not exist`);
			db.prepare<never, [string, number]>(`
UPDATE drop_ops SET status = 'superseded'
WHERE session_id = ? AND generation < ? AND status <> 'superseded'
`).run(sessionId, generation);
			db.prepare<never, [string, number]>(
				"UPDATE compartments SET active = 0 WHERE session_id = ? AND generation < ? AND active = 1",
			).run(sessionId, generation);
			db.prepare<never, [string, number]>(
				"DELETE FROM session_fact_staging WHERE session_id = ? AND generation < ?",
			).run(sessionId, generation);
			db.prepare<never, [string, number]>(
				"DELETE FROM compartment_staging WHERE session_id = ? AND generation < ?",
			).run(sessionId, generation);
			db.prepare<never, [number, string]>(
				"UPDATE session_runtime SET pending_since = NULL, updated_at = ? WHERE session_id = ?",
			).run(Date.now(), sessionId);
			return generation;
		});
	}

	getSearchGeneration(projectId: string): number {
		const value = this.getMeta(`search-generation:${projectId}`);
		const parsed = value === undefined ? 0 : Number.parseInt(value, 10);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	getAutoSearchSnapshot(
		sessionId: string,
		tagOrdinal: number,
		contentHash: string,
	): { readonly hint: string; readonly generation: number } | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<Pick<MessageTagRow, "auto_search_hint" | "search_generation">, [string, number, string]>(`
SELECT auto_search_hint, search_generation FROM message_tags
WHERE session_id = ? AND tag_ordinal = ? AND content_hash = ?
`)
			.get(sessionId, tagOrdinal, contentHash);
		if (!row || row.auto_search_hint === null || row.search_generation === null) return undefined;
		return { hint: row.auto_search_hint, generation: row.search_generation };
	}

	storeAutoSearchSnapshot(
		sessionId: string,
		tagOrdinal: number,
		contentHash: string,
		hint: string,
		generation: number,
	): { readonly hint: string; readonly generation: number } | undefined {
		this.#assertOpen();
		this.#db
			.prepare<never, [string, number, string, number, string]>(`
UPDATE message_tags
SET auto_search_hint = ?, search_generation = ?
WHERE session_id = ? AND tag_ordinal = ? AND content_hash = ? AND auto_search_hint IS NULL
`)
			.run(hint, generation, sessionId, tagOrdinal, contentHash);
		return this.getAutoSearchSnapshot(sessionId, tagOrdinal, contentHash);
	}

	syncDerivedSearchDocuments(
		sessionId: string,
		generation: number,
		visibleEntryIds: ReadonlySet<string>,
		now = Date.now(),
	): number {
		this.#assertOpen();
		const session = this.getSession(sessionId);
		if (!session) return 0;
		const visibleTags = new Set(
			this.listMessageTags(sessionId)
				.filter(tag => tag.entryId !== undefined && visibleEntryIds.has(tag.entryId))
				.map(tag => tag.tagOrdinal),
		);
		const compartments = this.listActiveCompartments(sessionId, generation, visibleEntryIds);
		const facts = this.listSessionFacts(sessionId, generation).filter(fact =>
			fact.sourceTags.every(tag => visibleTags.has(tag)),
		);
		const desired: ContextSearchDocumentInput[] = [
			...compartments.map(
				(compartment): ContextSearchDocumentInput => ({
					projectId: session.projectId,
					sessionId,
					source: "compartment",
					sourceId: compartment.id,
					contentHash: compartment.sourceHash,
					title: compartment.title,
					text: compartment.p3,
					startTag: compartment.startTag,
					endTag: compartment.endTag,
					generation,
					active: true,
				}),
			),
			...facts.map(
				(fact): ContextSearchDocumentInput => ({
					projectId: session.projectId,
					sessionId,
					source: "session_fact",
					sourceId: fact.id,
					canonicalId: fact.canonicalMemoryId,
					contentHash: hashSearchText(fact.text),
					title: fact.category,
					text: fact.text,
					startTag: fact.startTag,
					endTag: fact.endTag,
					generation,
					active: true,
				}),
			),
		];
		return this.transaction(() => {
			const existing = this.#db
				.prepare<SearchDocumentRow, [string]>(`
SELECT * FROM search_documents
WHERE session_id = ? AND source IN ('compartment', 'session_fact')
`)
				.all(sessionId);
			const desiredIds = new Set(
				desired.map(input => input.id ?? searchDocumentId(input.source, input.sourceId, input.generation)),
			);
			let changes = 0;
			const deactivate = this.#db.prepare<never, [number, string]>(
				"UPDATE search_documents SET active = 0, updated_at = ? WHERE id = ? AND active = 1",
			);
			for (const row of existing) {
				if (!desiredIds.has(row.id)) changes += Number(deactivate.run(now, row.id).changes);
			}
			for (const input of desired) {
				if (this.#upsertSearchDocument(input, now)) changes++;
			}
			if (changes > 0) this.#bumpSearchGeneration(session.projectId, now);
			return changes;
		});
	}

	upsertSearchDocument(input: ContextSearchDocumentInput, now = Date.now()): ContextSearchDocumentRecord {
		return this.transaction(() => {
			const changed = this.#upsertSearchDocument(input, now);
			if (changed) this.#bumpSearchGeneration(input.projectId, now);
			const id = input.id ?? searchDocumentId(input.source, input.sourceId, input.generation);
			const row = this.#db
				.prepare<SearchDocumentRow, [string]>("SELECT * FROM search_documents WHERE id = ?")
				.get(id);
			if (!row) throw new Error(`Failed to upsert search document ${id}`);
			return searchDocumentFromRow(row);
		});
	}

	searchFts(
		projectId: string,
		matchQuery: string,
		source: ContextSearchDocumentSource,
		limit: number,
	): ContextSearchFtsRecord[] {
		this.#assertOpen();
		if (!matchQuery || limit <= 0) return [];
		return this.#db
			.prepare<SearchFtsRow, [string, string, string, number]>(`
SELECT documents.*, bm25(search_fts, 0.0, 1.0, 1.0) AS rank
FROM search_fts
INNER JOIN search_documents AS documents ON documents.id = search_fts.document_id
WHERE search_fts MATCH ? AND documents.project_id = ? AND documents.source = ? AND documents.active = 1
ORDER BY rank
LIMIT ?
`)
			.all(matchQuery, projectId, source, Math.max(1, Math.floor(limit)))
			.map(row => ({ ...searchDocumentFromRow(row), rank: row.rank }));
	}

	listDocumentsMissingEmbedding(
		projectId: string,
		provider: string,
		model: string,
		limit: number,
	): ContextSearchDocumentRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<SearchDocumentRow, [string, string, string, number]>(`
SELECT documents.* FROM search_documents AS documents
WHERE documents.project_id = ? AND documents.active = 1
	AND NOT EXISTS (
		SELECT 1 FROM embeddings
		WHERE embeddings.document_id = documents.id
			AND embeddings.provider = ?
			AND embeddings.model = ?
			AND embeddings.content_hash = documents.content_hash
	)
ORDER BY documents.updated_at, documents.id
LIMIT ?
`)
			.all(projectId, provider, model, Math.max(1, Math.floor(limit)))
			.map(searchDocumentFromRow);
	}

	countDocumentsMissingEmbedding(projectId: string, provider: string, model: string): number {
		this.#assertOpen();
		return (
			this.#db
				.prepare<CountRow, [string, string, string]>(`
SELECT COUNT(*) AS count FROM search_documents AS documents
WHERE documents.project_id = ? AND documents.active = 1
	AND NOT EXISTS (
		SELECT 1 FROM embeddings
		WHERE embeddings.document_id = documents.id
			AND embeddings.provider = ?
			AND embeddings.model = ?
			AND embeddings.content_hash = documents.content_hash
	)
`)
				.get(projectId, provider, model)?.count ?? 0
		);
	}

	putEmbedding(
		documentId: string,
		provider: string,
		model: string,
		vector: Float32Array,
		contentHash: string,
		now = Date.now(),
	): void {
		this.#assertOpen();
		if (vector.length === 0) throw new Error("Cannot store an empty context embedding");
		const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
		this.#db
			.prepare<never, [string, string, string, number, Uint8Array, string, number]>(`
INSERT INTO embeddings (document_id, provider, model, dimension, vector, content_hash, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(document_id, provider, model) DO UPDATE SET
	dimension = excluded.dimension,
	vector = excluded.vector,
	content_hash = excluded.content_hash,
	created_at = excluded.created_at
`)
			.run(documentId, provider, model, vector.length, bytes, contentHash, now);
	}

	getEmbedding(
		documentId: string,
		provider: string,
		model: string,
		contentHash: string,
	): ContextEmbeddingRecord | undefined {
		this.#assertOpen();
		const row = this.#db
			.prepare<EmbeddingRow, [string, string, string, string]>(`
SELECT * FROM embeddings
WHERE document_id = ? AND provider = ? AND model = ? AND content_hash = ?
`)
			.get(documentId, provider, model, contentHash);
		return row ? embeddingFromRow(row) : undefined;
	}

	listEmbeddedDocuments(
		projectId: string,
		source: ContextSearchDocumentSource,
		provider: string,
		model: string,
		limit: number,
	): readonly {
		readonly document: ContextSearchDocumentRecord;
		readonly embedding: ContextEmbeddingRecord;
	}[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare<EmbeddedSearchRow, [string, string, string, string, number]>(`
SELECT
	documents.*,
	embeddings.document_id AS embedding_document_id,
	embeddings.provider AS embedding_provider,
	embeddings.model AS embedding_model,
	embeddings.dimension AS embedding_dimension,
	embeddings.vector AS embedding_vector,
	embeddings.content_hash AS embedding_content_hash,
	embeddings.created_at AS embedding_created_at
FROM search_documents AS documents
INNER JOIN embeddings ON embeddings.document_id = documents.id
	AND embeddings.provider = ?
	AND embeddings.model = ?
	AND embeddings.content_hash = documents.content_hash
WHERE documents.project_id = ? AND documents.source = ? AND documents.active = 1
ORDER BY documents.updated_at DESC, documents.id
LIMIT ?
`)
			.all(provider, model, projectId, source, Math.max(1, Math.floor(limit)));
		return rows.map(row => ({
			document: searchDocumentFromRow(row),
			embedding: embeddingFromRow({
				document_id: row.embedding_document_id,
				provider: row.embedding_provider,
				model: row.embedding_model,
				dimension: row.embedding_dimension,
				vector: row.embedding_vector,
				content_hash: row.embedding_content_hash,
				created_at: row.embedding_created_at,
			}),
		}));
	}

	upsertNote(input: ContextNoteInput, now = Date.now()): ContextNoteRecord {
		const id = input.id ?? Bun.randomUUIDv7();
		return this.transaction(() => {
			const existing = this.#db.prepare<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id);
			const createdAt = existing?.created_at ?? now;
			const status = input.status ?? existing?.status ?? "active";
			this.#db
				.prepare<never, SQLQueryBindings[]>(`
INSERT INTO notes (
	id, project_id, session_id, scope, category, content, surface_condition, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	project_id = excluded.project_id,
	session_id = excluded.session_id,
	scope = excluded.scope,
	category = excluded.category,
	content = excluded.content,
	surface_condition = excluded.surface_condition,
	status = excluded.status,
	updated_at = excluded.updated_at
`)
				.run(
					id,
					input.projectId,
					input.sessionId ?? null,
					input.scope,
					input.category,
					input.content,
					input.surfaceCondition ?? null,
					status,
					createdAt,
					now,
				);
			const text = input.surfaceCondition
				? `${input.content}\nSurface when: ${input.surfaceCondition}`
				: input.content;
			const changed = this.#upsertSearchDocument(
				{
					projectId: input.projectId,
					sessionId: input.sessionId,
					source: "note",
					sourceId: id,
					canonicalId: id,
					contentHash: hashSearchText(text),
					title: input.category,
					text,
					generation: 0,
					active: status === "active",
				},
				now,
			);
			if (changed) this.#bumpSearchGeneration(input.projectId, now);
			const row = this.#db.prepare<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id);
			if (!row) throw new Error(`Failed to upsert context note ${id}`);
			return noteFromRow(row);
		});
	}

	listNotes(projectId: string, sessionId?: string): ContextNoteRecord[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare<NoteRow, [string]>("SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC, id")
			.all(projectId);
		return rows
			.filter(row => row.scope === "project" || (sessionId !== undefined && row.session_id === sessionId))
			.map(noteFromRow);
	}

	incrementSessionFactRetrieval(factIds: readonly string[], now = Date.now()): number {
		this.#assertOpen();
		const ids = [...new Set(factIds)];
		if (ids.length === 0) return 0;
		const update = this.#db.prepare<never, [number, string]>(`
UPDATE session_facts
SET retrieval_count = retrieval_count + 1, updated_at = ?
WHERE id = ?
`);
		let changed = 0;
		this.transaction(() => {
			for (const id of ids) changed += Number(update.run(now, id).changes);
		});
		return changed;
	}

	replaceGitCommits(
		projectId: string,
		commits: readonly ContextGitCommitInput[],
		maxCommits: number,
		now = Date.now(),
	): number {
		this.#assertOpen();
		const retained = [...commits]
			.sort((left, right) => right.committedAt - left.committedAt || left.sha.localeCompare(right.sha))
			.slice(0, Math.max(0, Math.floor(maxCommits)));
		return this.transaction(() => {
			const retainedShas = new Set(retained.map(commit => commit.sha));
			const existing = this.#db
				.prepare<GitCommitRow, [string]>("SELECT * FROM git_commits WHERE project_id = ?")
				.all(projectId);
			const upsert = this.#db.prepare<never, SQLQueryBindings[]>(`
INSERT INTO git_commits (project_id, sha, subject, body, author, committed_at, indexed_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(project_id, sha) DO UPDATE SET
	subject = excluded.subject,
	body = excluded.body,
	author = excluded.author,
	committed_at = excluded.committed_at,
	indexed_at = excluded.indexed_at
WHERE subject <> excluded.subject OR body <> excluded.body OR author <> excluded.author
	OR committed_at <> excluded.committed_at
`);
			const removeCommit = this.#db.prepare<never, [string, string]>(
				"DELETE FROM git_commits WHERE project_id = ? AND sha = ?",
			);
			const deactivateDocument = this.#db.prepare<never, [number, string, string]>(`
UPDATE search_documents SET active = 0, updated_at = ?
WHERE project_id = ? AND source = 'git_commit' AND source_id = ? AND active = 1
`);
			let changes = 0;
			for (const row of existing) {
				if (retainedShas.has(row.sha)) continue;
				changes += Number(removeCommit.run(projectId, row.sha).changes);
				changes += Number(deactivateDocument.run(now, projectId, row.sha).changes);
			}
			for (const commit of retained) {
				changes += Number(
					upsert.run(projectId, commit.sha, commit.subject, commit.body, commit.author, commit.committedAt, now)
						.changes,
				);
				const text = [commit.subject, commit.body, `Author: ${commit.author}`].filter(Boolean).join("\n\n");
				if (
					this.#upsertSearchDocument(
						{
							projectId,
							source: "git_commit",
							sourceId: commit.sha,
							canonicalId: commit.sha,
							contentHash: hashSearchText(text),
							title: commit.subject,
							text,
							generation: 0,
							active: true,
						},
						now,
					)
				) {
					changes++;
				}
			}
			if (changes > 0) this.#bumpSearchGeneration(projectId, now);
			return changes;
		});
	}

	listGitCommits(projectId: string): ContextGitCommitRecord[] {
		this.#assertOpen();
		return this.#db
			.prepare<GitCommitRow, [string]>(
				"SELECT * FROM git_commits WHERE project_id = ? ORDER BY committed_at DESC, sha",
			)
			.all(projectId)
			.map(gitCommitFromRow);
	}

	setMeta(key: string, value: string, now = Date.now()): void {
		this.#assertOpen();
		this.#db
			.prepare<never, [string, string, number]>(`
INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`)
			.run(key, value, now);
	}

	getMeta(key: string): string | undefined {
		this.#assertOpen();
		return this.#db.prepare<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	}

	enqueueJob(input: ContextJobInput, now = Date.now()): ContextJobRecord {
		this.#assertOpen();
		const id = input.id ?? Bun.randomUUIDv7();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO jobs (
	id, project_id, session_id, kind, task, payload_json, status, next_due_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
`)
			.run(
				id,
				input.projectId,
				input.sessionId ?? null,
				input.kind,
				input.task ?? null,
				input.payload === undefined ? null : JSON.stringify(input.payload),
				input.nextDueAt ?? null,
				now,
				now,
			);
		const job = this.getJob(id);
		if (!job) throw new Error(`Failed to enqueue context job ${id}`);
		return job;
	}

	ensureJob(input: ContextJobInput & { readonly id: string }, now = Date.now()): ContextJobRecord {
		this.#assertOpen();
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO jobs (
	id, project_id, session_id, kind, task, payload_json, status, next_due_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	project_id = excluded.project_id,
	session_id = excluded.session_id,
	kind = excluded.kind,
	task = excluded.task,
	payload_json = excluded.payload_json,
	status = CASE
		WHEN jobs.status IN ('succeeded', 'failed', 'cancelled') THEN 'pending'
		ELSE jobs.status
	END,
	next_due_at = excluded.next_due_at,
	updated_at = excluded.updated_at
`)
			.run(
				input.id,
				input.projectId,
				input.sessionId ?? null,
				input.kind,
				input.task ?? null,
				input.payload === undefined ? null : JSON.stringify(input.payload),
				input.nextDueAt ?? null,
				now,
				now,
			);
		const job = this.getJob(input.id);
		if (!job) throw new Error(`Failed to ensure context job ${input.id}`);
		return job;
	}

	getJob(jobId: string): ContextJobRecord | undefined {
		this.#assertOpen();
		const row = this.#db.prepare<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(jobId);
		return row ? jobFromRow(row) : undefined;
	}

	listJobs(projectId: string, sessionId?: string): ContextJobRecord[] {
		this.#assertOpen();
		const rows = sessionId
			? this.#db
					.prepare<JobRow, [string, string]>(
						"SELECT * FROM jobs WHERE project_id = ? AND session_id = ? ORDER BY created_at, id",
					)
					.all(projectId, sessionId)
			: this.#db
					.prepare<JobRow, [string]>("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at, id")
					.all(projectId);
		return rows.map(jobFromRow);
	}

	tryAcquireJobDomainLease(
		projectId: string,
		domain: string,
		owner: string,
		ttlMs: number,
		now = Date.now(),
	): boolean {
		this.#assertOpen();
		const leaseUntil = now + Math.max(1, Math.floor(ttlMs));
		const result = this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO job_domain_leases (project_id, domain, lease_owner, lease_until, heartbeat_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(project_id, domain) DO UPDATE SET
	lease_owner = excluded.lease_owner,
	lease_until = excluded.lease_until,
	heartbeat_at = excluded.heartbeat_at
WHERE job_domain_leases.lease_until <= ? OR job_domain_leases.lease_owner = ?
`)
			.run(projectId, domain, owner, leaseUntil, now, now, owner);
		return Number(result.changes) === 1;
	}

	heartbeatJobDomainLease(projectId: string, domain: string, owner: string, ttlMs: number, now = Date.now()): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [number, number, string, string, string]>(`
UPDATE job_domain_leases SET lease_until = ?, heartbeat_at = ?
WHERE project_id = ? AND domain = ? AND lease_owner = ?
`)
			.run(now + Math.max(1, Math.floor(ttlMs)), now, projectId, domain, owner);
		return Number(result.changes) === 1;
	}

	releaseJobDomainLease(projectId: string, domain: string, owner: string): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [string, string, string]>(
				"DELETE FROM job_domain_leases WHERE project_id = ? AND domain = ? AND lease_owner = ?",
			)
			.run(projectId, domain, owner);
		return Number(result.changes) === 1;
	}

	tryAcquireJobLease(jobId: string, owner: string, ttlMs: number, now = Date.now()): boolean {
		const leaseUntil = now + Math.max(1, Math.floor(ttlMs));
		return this.transaction(db => {
			const result = db
				.prepare<never, SQLQueryBindings[]>(`
UPDATE jobs SET
	status = 'running',
	lease_owner = ?,
	lease_until = ?,
	heartbeat_at = ?,
	attempt = CASE WHEN lease_owner IS NULL OR lease_owner <> ? THEN attempt + 1 ELSE attempt END,
	last_error = NULL,
	updated_at = ?
WHERE id = ?
	AND status IN ('pending', 'running', 'paused', 'failed')
	AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)
`)
				.run(owner, leaseUntil, now, owner, now, jobId, now, owner);
			return Number(result.changes) === 1;
		});
	}

	heartbeatJobLease(jobId: string, owner: string, ttlMs: number, now = Date.now()): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [number, number, number, string, string]>(`
UPDATE jobs SET lease_until = ?, heartbeat_at = ?, updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ?
`)
			.run(now + Math.max(1, Math.floor(ttlMs)), now, now, jobId, owner);
		return Number(result.changes) === 1;
	}

	updateJobProgress(jobId: string, owner: string, progress: number, now = Date.now()): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [number, number, string, string]>(`
UPDATE jobs SET progress = ?, updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ?
`)
			.run(Math.max(0, Math.min(1, progress)), now, jobId, owner);
		return Number(result.changes) === 1;
	}

	finishJob(
		jobId: string,
		owner: string,
		status: Extract<ContextJobStatus, "succeeded" | "failed" | "cancelled">,
		options: { readonly error?: string; readonly progress?: number; readonly nextDueAt?: number } = {},
		now = Date.now(),
	): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, SQLQueryBindings[]>(`
UPDATE jobs SET
	status = ?,
	lease_owner = NULL,
	lease_until = NULL,
	heartbeat_at = NULL,
	last_error = ?,
	progress = ?,
	next_due_at = ?,
	updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ?
`)
			.run(
				status,
				options.error ?? null,
				options.progress ?? (status === "succeeded" ? 1 : 0),
				options.nextDueAt ?? null,
				now,
				jobId,
				owner,
			);
		return Number(result.changes) === 1;
	}

	releaseJobLease(
		jobId: string,
		owner: string,
		status: Extract<ContextJobStatus, "pending" | "paused" | "failed"> = "pending",
		nextDueAt?: number,
		now = Date.now(),
	): boolean {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, SQLQueryBindings[]>(`
UPDATE jobs SET
	status = ?,
	next_due_at = ?,
	lease_owner = NULL,
	lease_until = NULL,
	heartbeat_at = NULL,
	updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ?
`)
			.run(status, nextDueAt ?? null, now, jobId, owner);
		return Number(result.changes) === 1;
	}

	recoverExpiredJobLeases(now = Date.now()): number {
		this.#assertOpen();
		const result = this.#db
			.prepare<never, [number, number]>(`
UPDATE jobs SET
	status = 'pending',
	lease_owner = NULL,
	lease_until = NULL,
	heartbeat_at = NULL,
	updated_at = ?
WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
`)
			.run(now, now);
		this.#db.prepare<never, [number]>("DELETE FROM job_domain_leases WHERE lease_until <= ?").run(now);
		return Number(result.changes);
	}

	optimize(): void {
		this.#assertOpen();
		this.#db.exec("PRAGMA optimize");
	}

	diagnostics(): ContextStoreDiagnostics {
		this.#assertOpen();
		const schemaVersion = this.#db.query<UserVersionRow, []>("PRAGMA user_version").get()?.user_version ?? 0;
		const journalMode = this.#db.query<JournalModeRow, []>("PRAGMA journal_mode").get()?.journal_mode ?? "unknown";
		const foreignKeys =
			(this.#db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0) === 1;
		return { path: this.path, schemaVersion, journalMode, foreignKeys };
	}

	async ensureFilePermissions(): Promise<void> {
		if (this.path === ":memory:") return;
		for (const filePath of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
			try {
				await fs.chmod(filePath, 0o600);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	#upsertSearchDocument(input: ContextSearchDocumentInput, now: number): boolean {
		const id = input.id ?? searchDocumentId(input.source, input.sourceId, input.generation);
		const active = input.active === false ? 0 : 1;
		const existing = this.#db
			.prepare<SearchDocumentRow, [string]>("SELECT * FROM search_documents WHERE id = ?")
			.get(id);
		if (
			existing &&
			existing.project_id === input.projectId &&
			existing.session_id === (input.sessionId ?? null) &&
			existing.source === input.source &&
			existing.source_id === input.sourceId &&
			existing.canonical_id === (input.canonicalId ?? null) &&
			existing.content_hash === input.contentHash &&
			existing.title === input.title &&
			existing.text === input.text &&
			existing.start_tag === (input.startTag ?? null) &&
			existing.end_tag === (input.endTag ?? null) &&
			existing.generation === input.generation &&
			existing.active === active
		) {
			return false;
		}
		const createdAt = existing?.created_at ?? now;
		this.#db
			.prepare<never, SQLQueryBindings[]>(`
INSERT INTO search_documents (
	id, project_id, session_id, source, source_id, canonical_id, content_hash,
	title, text, start_tag, end_tag, generation, active, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	project_id = excluded.project_id,
	session_id = excluded.session_id,
	source = excluded.source,
	source_id = excluded.source_id,
	canonical_id = excluded.canonical_id,
	content_hash = excluded.content_hash,
	title = excluded.title,
	text = excluded.text,
	start_tag = excluded.start_tag,
	end_tag = excluded.end_tag,
	generation = excluded.generation,
	active = excluded.active,
	updated_at = excluded.updated_at
`)
			.run(
				id,
				input.projectId,
				input.sessionId ?? null,
				input.source,
				input.sourceId,
				input.canonicalId ?? null,
				input.contentHash,
				input.title,
				input.text,
				input.startTag ?? null,
				input.endTag ?? null,
				input.generation,
				active,
				createdAt,
				now,
			);
		return true;
	}

	#bumpSearchGeneration(projectId: string, now: number): number {
		const generation = this.getSearchGeneration(projectId) + 1;
		this.setMeta(`search-generation:${projectId}`, String(generation), now);
		return generation;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Context store is closed");
	}
}
