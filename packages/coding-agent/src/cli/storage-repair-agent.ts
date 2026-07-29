import { Database } from "bun:sqlite";
import { AUTH_SCHEMA_VERSION, AUTH_STORAGE_TABLES } from "@oh-my-pi/pi-ai";
import {
	initializeMemoryStorageExactPath,
	MEMORY_STORAGE_TABLES,
	validateMemoryStorageExactPath,
} from "../memories/storage";
import { AGENT_STORAGE_TABLES, AgentStorage, SCHEMA_VERSION } from "../session/agent-storage";
import {
	assertInvariant,
	canonicalSchema,
	checkpointCandidate,
	errorMessage,
	stableJson,
	verifyCommonCandidate,
} from "./storage-repair-files";
import type { CanonicalSchemaObject, FrozenSqliteSnapshot, StorageRepairObjectResult } from "./storage-repair-types";

const ROW_BATCH_SIZE = 256;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SIMPLE_TABLE_PREFIX_RE =
	/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[A-Za-z_][A-Za-z0-9_]{0,127}"|[A-Za-z_][A-Za-z0-9_]{0,127})\s*\(/iu;
const SIMPLE_VIEW_RE =
	/^CREATE\s+VIEW\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+SELECT\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?$/iu;
const SIMPLE_TRIGGER_RE =
	/^CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)\s+(BEFORE|AFTER)\s+(INSERT|DELETE|UPDATE)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s+BEGIN\s+SELECT\s+(NEW|OLD)\.([A-Za-z_][A-Za-z0-9_]*)\s*;\s*END\s*;?$/iu;
const SIMPLE_INDEX_PREFIX_RE =
	/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[A-Za-z_][A-Za-z0-9_]{0,127}"|[A-Za-z_][A-Za-z0-9_]{0,127})\s+ON\s+(?:"[A-Za-z_][A-Za-z0-9_]{0,127}"|[A-Za-z_][A-Za-z0-9_]{0,127})\s*\(/iu;

type TableDisposition = "authoritative" | "rebuildable";
type SqliteValue = string | number | bigint | Uint8Array | null;

interface TableOwner {
	owner: string;
	disposition: TableDisposition;
}

interface TableColumn {
	name: string;
	type: string;
	notnull: bigint;
	dfltValue: unknown;
	pk: bigint;
	hidden: bigint;
}

interface SchemaObjectRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

interface SqliteSequence {
	name: string;
	seq: bigint;
}

export interface AgentRepairDiagnosis {
	expectedSchema: CanonicalSchemaObject[];
	omitTables: string[];
}

function ownerTables(owner: string, tables: Readonly<Record<string, TableDisposition>>) {
	const result: Record<string, TableOwner> = {};
	for (const [name, disposition] of Object.entries(tables)) result[name] = { owner, disposition };
	return result;
}

const AGENT_TABLES: Readonly<Record<string, TableOwner>> = {
	...ownerTables("agent", AGENT_STORAGE_TABLES),
	...ownerTables("auth", AUTH_STORAGE_TABLES),
	...ownerTables("memory", MEMORY_STORAGE_TABLES),
};

function quoteIdentifier(identifier: string) {
	assertInvariant(IDENTIFIER_RE.test(identifier), `Unsafe SQLite identifier: ${identifier}`);
	return `"${identifier}"`;
}

function sqliteRows(db: Database, sql: string, ...bindings: SqliteValue[]) {
	return db.prepare(sql).all(...bindings) as Array<Record<string, unknown>>;
}

function assertSupportedVersions(db: Database) {
	const schemaRows = sqliteRows(db, "SELECT version FROM schema_version ORDER BY version");
	assertInvariant(
		schemaRows.length === 1 && schemaRows[0]?.version === BigInt(SCHEMA_VERSION),
		`Unsupported agent schema version; expected ${SCHEMA_VERSION}`,
	);
	const authRows = sqliteRows(db, "SELECT id, version FROM auth_schema_version ORDER BY id");
	assertInvariant(
		authRows.length === 1 && authRows[0]?.id === 1n && authRows[0]?.version === BigInt(AUTH_SCHEMA_VERSION),
		`Unsupported auth schema version; expected ${AUTH_SCHEMA_VERSION}`,
	);
}

function initializeCandidate(candidate: string) {
	AgentStorage.initializeExactPath(candidate);
	initializeMemoryStorageExactPath(candidate);
}

function schemaKey(object: CanonicalSchemaObject) {
	return `${object.kind}\0${object.name}`;
}

function assertBuiltInSchema(source: CanonicalSchemaObject[], expected: CanonicalSchemaObject[]) {
	const sourceByKey = new Map(source.map(object => [schemaKey(object), object]));
	const expectedKeys = new Set(expected.map(schemaKey));
	for (const object of expected) {
		const actual = sourceByKey.get(schemaKey(object));
		assertInvariant(actual, `Missing built-in schema object: ${object.name}`);
		assertInvariant(
			stableJson(actual) === stableJson(object),
			`Structural drift in built-in schema object: ${object.name}`,
		);
	}
	for (const object of source) {
		if (AGENT_TABLES[object.table] && !expectedKeys.has(schemaKey(object))) {
			throw new Error(`Unexpected object attached to built-in table ${object.table}: ${object.name}`);
		}
	}
}

function isSqliteCorruption(error: unknown) {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "SQLITE_CORRUPT" || error.code === "SQLITE_NOTADB";
}

function classifyUnreadableTables(source: Database) {
	const unreadable: string[] = [];
	for (const [table, inventory] of Object.entries(AGENT_TABLES)) {
		const columns = tableColumns(source, table);
		const writable = columns.map(column => column.name);
		const rowidAlias = selectedRowidAlias(source, table, columns);
		const statement = source.prepare(transferSql(table, writable, rowidAlias).select);
		try {
			for (const _row of statement.iterate()) {
				// Reading every record proves whether this exact table B-tree is traversable.
			}
		} catch (error) {
			if (!isSqliteCorruption(error)) throw error;
			if (inventory.disposition === "authoritative") {
				throw new Error(`Authoritative table ${table} is unreadable: ${errorMessage(error)}`, { cause: error });
			}
			unreadable.push(table);
		} finally {
			statement.finalize();
		}
	}
	return unreadable;
}

export function diagnoseAgentSnapshot(snapshot: FrozenSqliteSnapshot, expectedPath: string): AgentRepairDiagnosis {
	assertSupportedVersions(snapshot.db);
	initializeCandidate(expectedPath);
	const expectedDb = new Database(expectedPath, { readonly: true, safeIntegers: true });
	try {
		const expectedSchema = canonicalSchema(expectedDb);
		assertBuiltInSchema(snapshot.schema, expectedSchema);
		return { expectedSchema, omitTables: classifyUnreadableTables(snapshot.db) };
	} finally {
		expectedDb.close();
	}
}

function sqliteValue(value: unknown, table: string, column: string): SqliteValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint")
		return value;
	if (value instanceof Uint8Array) return value;
	throw new Error(`Unsupported SQLite storage class in ${table}.${column}`);
}

function tableColumns(db: Database, table: string): TableColumn[] {
	return sqliteRows(
		db,
		'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
		table,
	).map(row => {
		assertInvariant(
			typeof row.name === "string" &&
				typeof row.type === "string" &&
				typeof row.notnull === "bigint" &&
				typeof row.pk === "bigint" &&
				typeof row.hidden === "bigint",
			`Invalid column metadata for ${table}`,
		);
		return {
			name: row.name,
			type: row.type,
			notnull: row.notnull,
			dfltValue: row.dflt_value,
			pk: row.pk,
			hidden: row.hidden,
		};
	});
}

function tableHasRowid(db: Database, table: string) {
	const row = db.prepare("SELECT wr FROM pragma_table_list(?) WHERE name = ?").get(table, table) as {
		wr?: bigint;
	} | null;
	assertInvariant(row && typeof row.wr === "bigint", `Missing table metadata for ${table}`);
	return row.wr === 0n;
}

function declaredPrimaryKeyAliasesRowid(db: Database, table: string, columns: TableColumn[]) {
	const primaryKey = columns.filter(column => column.pk !== 0n);
	if (primaryKey.length !== 1 || primaryKey[0]?.type.trim().toUpperCase() !== "INTEGER") return false;
	const index = db.prepare("SELECT 1 FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 1").get(table);
	return index === null;
}

function selectedRowidAlias(db: Database, table: string, columns: TableColumn[]) {
	if (!tableHasRowid(db, table) || declaredPrimaryKeyAliasesRowid(db, table, columns)) return null;
	const declared = new Set(columns.map(column => column.name.toLowerCase()));
	const alias = ["rowid", "_rowid_", "oid"].find(candidate => !declared.has(candidate));
	assertInvariant(alias, `Implicit rowid is shadowed by every addressable alias in ${table}`);
	return alias;
}

function transferSql(table: string, columns: string[], rowidAlias: string | null) {
	const names = rowidAlias ? [rowidAlias, ...columns] : columns;
	assertInvariant(names.length > 0, `Table ${table} has no writable columns`);
	let rowidProjectionAlias: string | null = null;
	if (rowidAlias) {
		const declared = new Set(columns.map(column => column.toLowerCase()));
		for (let index = 0; index <= columns.length; index += 1) {
			const candidate = `__omp_salvage_rowid_${index}`;
			if (!declared.has(candidate)) {
				rowidProjectionAlias = candidate;
				break;
			}
		}
		assertInvariant(rowidProjectionAlias, `Cannot allocate an unambiguous rowid projection for ${table}`);
	}
	const projection =
		rowidAlias && rowidProjectionAlias
			? [
					`${quoteIdentifier(rowidAlias)} AS ${quoteIdentifier(rowidProjectionAlias)}`,
					...columns.map(quoteIdentifier),
				]
			: columns.map(quoteIdentifier);
	return {
		select: `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(table)}`,
		insert: `INSERT INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
		rowidProjectionAlias,
	};
}

function clearTable(db: Database, table: string) {
	db.exec(`DELETE FROM ${quoteIdentifier(table)}`);
}

function copyTableRows(source: Database, destination: Database, table: string) {
	const columns = tableColumns(source, table);
	assertInvariant(
		columns.every(column => column.hidden === 0n),
		`Generated or hidden columns are not losslessly supported in ${table}`,
	);
	const writable = columns.map(column => column.name);
	const rowidAlias = selectedRowidAlias(source, table, columns);
	const sql = transferSql(table, writable, rowidAlias);
	const select = source.prepare(sql.select);
	const insert = destination.prepare(sql.insert);
	let batch: SqliteValue[][] = [];
	const flush = destination.transaction((rows: SqliteValue[][]) => {
		for (const values of rows) insert.run(...values);
	});
	try {
		for (const raw of select.iterate() as Iterable<Record<string, unknown>>) {
			const values: SqliteValue[] = [];
			if (rowidAlias && sql.rowidProjectionAlias) {
				values.push(sqliteValue(raw[sql.rowidProjectionAlias], table, rowidAlias));
			}
			for (const column of writable) values.push(sqliteValue(raw[column], table, column));
			batch.push(values);
			if (batch.length < ROW_BATCH_SIZE) continue;
			flush(batch);
			batch = [];
		}
		if (batch.length > 0) flush(batch);
	} finally {
		select.finalize();
		insert.finalize();
	}
}

function equalSqliteValues(source: SqliteValue, candidate: SqliteValue) {
	if (source instanceof Uint8Array || candidate instanceof Uint8Array) {
		if (
			!(source instanceof Uint8Array && candidate instanceof Uint8Array) ||
			source.byteLength !== candidate.byteLength
		) {
			return false;
		}
		for (let index = 0; index < source.byteLength; index += 1) {
			if (source[index] !== candidate[index]) return false;
		}
		return true;
	}
	return source === candidate;
}

function verifyTableRows(source: Database, candidate: Database, table: string) {
	const columns = tableColumns(source, table);
	assertInvariant(
		columns.every(column => column.hidden === 0n),
		`Generated or hidden columns are not losslessly supported in ${table}`,
	);
	const writable = columns.map(column => column.name);
	const rowidAlias = selectedRowidAlias(source, table, columns);
	const sql = transferSql(table, writable, rowidAlias);
	const sourceSelect = source.prepare(sql.select);
	const candidateSelect = candidate.prepare(sql.select);
	try {
		const sourceRows = sourceSelect.iterate() as Iterator<Record<string, unknown>>;
		const candidateRows = candidateSelect.iterate() as Iterator<Record<string, unknown>>;
		for (;;) {
			const sourceRow = sourceRows.next();
			const candidateRow = candidateRows.next();
			if (sourceRow.done || candidateRow.done) {
				assertInvariant(sourceRow.done && candidateRow.done, `Candidate row count mismatch in ${table}`);
				return;
			}
			if (rowidAlias && sql.rowidProjectionAlias) {
				const expected = sqliteValue(sourceRow.value[sql.rowidProjectionAlias], table, rowidAlias);
				const actual = sqliteValue(candidateRow.value[sql.rowidProjectionAlias], table, rowidAlias);
				assertInvariant(equalSqliteValues(expected, actual), `Candidate row identity mismatch in ${table}`);
			}
			for (const column of writable) {
				const expected = sqliteValue(sourceRow.value[column], table, column);
				const actual = sqliteValue(candidateRow.value[column], table, column);
				assertInvariant(equalSqliteValues(expected, actual), `Candidate row value mismatch in ${table}.${column}`);
			}
		}
	} finally {
		sourceSelect.finalize();
		candidateSelect.finalize();
	}
}

function schemaObjects(db: Database) {
	return db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
		.all() as SchemaObjectRow[];
}

function autoincrementTables(db: Database): Set<string> {
	return new Set(
		schemaObjects(db)
			.filter(
				object =>
					object.type === "table" && typeof object.sql === "string" && /\bAUTOINCREMENT\b/iu.test(object.sql),
			)
			.map(object => object.name),
	);
}

function sqliteSequenceRows(db: Database): SqliteSequence[] {
	if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").get()) return [];
	return sqliteRows(db, "SELECT name, seq FROM sqlite_sequence ORDER BY name").map(row => {
		assertInvariant(typeof row.name === "string" && typeof row.seq === "bigint", "Invalid sqlite_sequence row");
		return { name: row.name, seq: row.seq };
	});
}

function preservedAutoincrementTables(destination: Database, omitted: readonly string[]): Set<string> {
	const result = autoincrementTables(destination);
	for (const table of omitted) result.delete(table);
	return result;
}

function expectedSqliteSequences(source: Database, preserved: ReadonlySet<string>): SqliteSequence[] {
	const sourceAutoincrement = autoincrementTables(source);
	return sqliteSequenceRows(source).filter(row => sourceAutoincrement.has(row.name) && preserved.has(row.name));
}

function copySqliteSequences(source: Database, destination: Database, omitted: readonly string[]): void {
	const preserved = preservedAutoincrementTables(destination, omitted);
	const expected = expectedSqliteSequences(source, preserved);
	if (!destination.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").get()) {
		assertInvariant(expected.length === 0, "Candidate is missing sqlite_sequence for preserved AUTOINCREMENT tables");
		return;
	}
	destination.exec("DELETE FROM sqlite_sequence");
	const insert = destination.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)");
	try {
		for (const row of expected) insert.run(row.name, row.seq);
	} finally {
		insert.finalize();
	}
}

function verifySqliteSequences(source: Database, candidate: Database, omitted: readonly string[]): void {
	const preserved = preservedAutoincrementTables(candidate, omitted);
	const expected = expectedSqliteSequences(source, preserved);
	const actual = sqliteSequenceRows(candidate);
	assertInvariant(
		actual.every(row => preserved.has(row.name)),
		"Candidate has sqlite_sequence row for an omitted table",
	);
	assertInvariant(
		stableJson(actual) === stableJson(expected),
		"Candidate sqlite_sequence differs from preserved source high-water marks",
	);
}

function viewOwner(object: SchemaObjectRow) {
	if (object.type !== "view" || typeof object.sql !== "string") return null;
	const match = SIMPLE_VIEW_RE.exec(object.sql);
	return match?.[3] ?? null;
}

function extensionClosures(source: Database, expected: CanonicalSchemaObject[]) {
	const expectedKeys = new Set(expected.map(schemaKey));
	const closures = new Map<string, SchemaObjectRow[]>();
	for (const object of schemaObjects(source)) {
		if (expectedKeys.has(`${object.type}\0${object.name}`)) continue;
		const owner =
			object.type === "table" ? object.name : object.type === "view" ? viewOwner(object) : object.tbl_name;
		assertInvariant(owner && IDENTIFIER_RE.test(owner), `Unsafe or ambiguous extension owner: ${object.name}`);
		const objects = closures.get(owner) ?? [];
		objects.push(object);
		closures.set(owner, objects);
	}
	for (const owner of closures.keys()) {
		assertInvariant(
			closures.get(owner)?.some(object => object.type === "table" && object.name === owner),
			`Extension closure has no owning table: ${owner}`,
		);
	}
	return closures;
}

function validateExtensionIndex(source: Database, object: SchemaObjectRow) {
	assertInvariant(
		object.sql && SIMPLE_INDEX_PREFIX_RE.test(object.sql) && !/\bwhere\b/iu.test(object.sql),
		`Unsafe extension index: ${object.name}`,
	);
	for (const column of sqliteRows(source, "SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", object.name)) {
		if (column.key === 0n) continue;
		assertInvariant(
			typeof column.cid === "bigint" && column.cid >= 0n && column.coll === "BINARY",
			`Unsafe extension index shape: ${object.name}`,
		);
	}
}

function validateExtensionView(owner: string, object: SchemaObjectRow, columns: ReadonlySet<string>) {
	assertInvariant(typeof object.sql === "string", `Missing extension view SQL: ${object.name}`);
	const match = SIMPLE_VIEW_RE.exec(object.sql);
	assertInvariant(match && match[1] === object.name && match[3] === owner, `Unsafe extension view: ${object.name}`);
	for (const column of match[2]?.split(",").map(value => value.trim()) ?? []) {
		assertInvariant(columns.has(column), `Extension view ${object.name} references unknown column ${column}`);
	}
}

function validateExtensionTrigger(owner: string, object: SchemaObjectRow, columns: ReadonlySet<string>) {
	assertInvariant(typeof object.sql === "string", `Missing extension trigger SQL: ${object.name}`);
	const match = SIMPLE_TRIGGER_RE.exec(object.sql);
	assertInvariant(match && match[1] === object.name && match[4] === owner, `Unsafe extension trigger: ${object.name}`);
	const event = match[3]?.toUpperCase();
	const row = match[5]?.toUpperCase();
	assertInvariant(event !== "INSERT" || row === "NEW", `INSERT trigger ${object.name} may only read NEW`);
	assertInvariant(event !== "DELETE" || row === "OLD", `DELETE trigger ${object.name} may only read OLD`);
	assertInvariant(
		typeof match[6] === "string" && columns.has(match[6]),
		`Extension trigger ${object.name} references an unknown column`,
	);
}

function validateExtension(source: Database, owner: string, objects: SchemaObjectRow[]) {
	assertInvariant(!AGENT_TABLES[owner], `Extension owner collides with built-in table: ${owner}`);
	const tables = objects.filter(object => object.type === "table");
	const table = tables[0];
	assertInvariant(
		tables.length === 1 && table?.name === owner && typeof table.sql === "string",
		`Ambiguous extension ownership for ${owner}`,
	);
	assertInvariant(SIMPLE_TABLE_PREFIX_RE.test(table.sql), `Unparsable extension table ${owner}`);
	assertInvariant(
		!/\b(?:virtual|using|generated|collate|check|references|constraint|without\s+rowid|strict)\b/iu.test(table.sql),
		`Unsafe extension table shape: ${owner}`,
	);
	const tableColumnList = tableColumns(source, owner);
	assertInvariant(
		tableColumnList.every(column => column.hidden === 0n),
		`Unsafe extension columns: ${owner}`,
	);
	assertInvariant(tableHasRowid(source, owner), `Extension WITHOUT ROWID tables are unsupported: ${owner}`);
	assertInvariant(
		sqliteRows(source, "SELECT * FROM pragma_foreign_key_list(?)", owner).length === 0,
		`Extension foreign keys are unsupported: ${owner}`,
	);
	const columns = new Set(tableColumnList.map(column => column.name));
	for (const object of objects) {
		if (object.type === "table") continue;
		if (object.type === "index") validateExtensionIndex(source, object);
		else if (object.type === "view") validateExtensionView(owner, object, columns);
		else if (object.type === "trigger") validateExtensionTrigger(owner, object, columns);
		else throw new Error(`Unsupported extension object kind: ${object.type} ${object.name}`);
	}
}

function preserveExtensions(
	source: Database,
	destination: Database,
	expected: CanonicalSchemaObject[],
	results: StorageRepairObjectResult[],
) {
	const closures = [...extensionClosures(source, expected)].sort(([left], [right]) => left.localeCompare(right));
	for (const [owner, objects] of closures) {
		validateExtension(source, owner, objects);
		const table = objects.find(object => object.type === "table");
		assertInvariant(table && typeof table.sql === "string", `Missing extension table SQL: ${owner}`);
		destination.exec(table.sql);
		copyTableRows(source, destination, owner);
		results.push({ name: owner, kind: "table", owner: `extension:${owner}`, action: "preserved" });
		for (const kind of ["index", "view", "trigger"] as const) {
			for (const object of objects
				.filter(entry => entry.type === kind)
				.sort((left, right) => left.name.localeCompare(right.name))) {
				assertInvariant(object.sql, `Missing extension ${kind} SQL: ${object.name}`);
				destination.exec(object.sql);
				results.push({ name: object.name, kind, owner: `extension:${owner}`, action: "preserved" });
			}
		}
	}
}

function objectResults(expected: CanonicalSchemaObject[]) {
	return expected.map(object => {
		const owner = AGENT_TABLES[object.table];
		assertInvariant(owner, `Current agent schema object has no authoritative owner: ${object.name}`);
		return { name: object.name, kind: object.kind, owner: owner.owner, action: "preserved" as const };
	});
}

function markOmitted(results: StorageRepairObjectResult[], table: string) {
	for (const object of results) {
		if (object.name !== table && !object.name.startsWith(`idx_${table}_`)) continue;
		object.action = "omitted";
		object.detail = "registered rebuildable table B-tree is unreadable";
	}
}

export function buildAgentCandidate(
	source: Database,
	candidate: string,
	diagnosis: AgentRepairDiagnosis,
): StorageRepairObjectResult[] {
	initializeCandidate(candidate);
	const results: StorageRepairObjectResult[] = objectResults(diagnosis.expectedSchema);
	const destination = new Database(candidate, { safeIntegers: true });
	try {
		destination.exec("PRAGMA foreign_keys = OFF");
		for (const table of Object.keys(AGENT_TABLES)) clearTable(destination, table);
		for (const table of Object.keys(AGENT_TABLES)) {
			if (diagnosis.omitTables.includes(table)) {
				markOmitted(results, table);
				continue;
			}
			try {
				copyTableRows(source, destination, table);
			} catch (error) {
				throw new Error(`Lossless row transfer failed for ${table}: ${errorMessage(error)}`, { cause: error });
			}
		}
		preserveExtensions(source, destination, diagnosis.expectedSchema, results);
		copySqliteSequences(source, destination, diagnosis.omitTables);
		assertInvariant(
			destination.prepare("PRAGMA foreign_key_check").all().length === 0,
			"Candidate foreign key check failed after assembly",
		);
		return results;
	} finally {
		destination.close();
	}
}

export function verifyAgentCandidate(candidate: string, source: Database, omitted: readonly string[]) {
	AgentStorage.validateExactPath(candidate);
	validateMemoryStorageExactPath(candidate);
	checkpointCandidate(candidate);
	verifyCommonCandidate(candidate);
	const db = new Database(candidate, { readonly: true, safeIntegers: true });
	try {
		assertSupportedVersions(db);
		for (const table of Object.keys(AGENT_TABLES)) {
			assertInvariant(
				db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
				`Candidate is missing ${table}`,
			);
		}
		for (const table of preservedTableNames(source, omitted)) verifyTableRows(source, db, table);
		verifySqliteSequences(source, db, omitted);
	} finally {
		db.close();
	}
}

function preservedTableNames(source: Database, omitted: readonly string[]) {
	const excluded = new Set(omitted);
	const tables = new Set(Object.keys(AGENT_TABLES).filter(table => !excluded.has(table)));
	for (const object of schemaObjects(source)) {
		if (object.type === "table" && !AGENT_TABLES[object.name]) tables.add(object.name);
	}
	return [...tables].sort((left, right) => left.localeCompare(right));
}
