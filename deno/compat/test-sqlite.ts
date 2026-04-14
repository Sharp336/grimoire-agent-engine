import "@lu-zero/bun-compat";
import { Database, type SQLQueryBindings } from "bun:sqlite";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${(err as Error).message ?? err}`);
    if ((err as Error).stack) {
      const lines = (err as Error).stack!.split("\n").slice(1, 4);
      for (const l of lines) console.log(`    ${l.trim()}`);
    }
    failed++;
  }
}

console.log("=== SQLite Compat Tests ===");

await test("Database constructor default", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.close();
});

await test("prepare().run() with positional params", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const stmt = db.prepare("INSERT INTO t (name) VALUES (?)");
  const result = stmt.run("alice");
  if (typeof result.changes !== "number")
    throw new Error(`changes type: ${typeof result.changes}`);
  if (result.changes !== 1) throw new Error(`changes: ${result.changes}`);
  db.close();
});

await test("prepare().get() returns row or undefined", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO t (name) VALUES ('bob')");
  const stmt = db.prepare("SELECT * FROM t WHERE id = ?");
  const row = stmt.get(1) as { id: number; name: string } | undefined;
  if (!row) throw new Error("expected row");
  if (row.name !== "bob") throw new Error(`name: ${row.name}`);
  const missing = stmt.get(999);
  if (missing !== undefined)
    throw new Error(`expected undefined, got ${missing}`);
  db.close();
});

await test("prepare().all() returns array", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
  ins.run("a");
  ins.run("b");
  ins.run("c");
  const stmt = db.prepare("SELECT * FROM t ORDER BY id");
  const rows = stmt.all() as Array<{ id: number; name: string }>;
  if (rows.length !== 3) throw new Error(`length: ${rows.length}`);
  if (rows[0].name !== "a") throw new Error(`first: ${rows[0].name}`);
  db.close();
});

await test("prepare().columnNames", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  const stmt = db.prepare("SELECT id, name FROM t");
  const cols = stmt.columnNames;
  if (cols.length !== 2) throw new Error(`cols: ${cols}`);
  if (cols[0] !== "id" || cols[1] !== "name") throw new Error(`names: ${cols}`);
  db.close();
});

await test("prepare().paramsCount", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const s1 = db.prepare("SELECT * FROM t");
  if (s1.paramsCount !== 0) throw new Error(`no params: ${s1.paramsCount}`);
  const s2 = db.prepare("SELECT * FROM t WHERE id = ? AND name = ?");
  if (s2.paramsCount !== 2) throw new Error(`two params: ${s2.paramsCount}`);
  const s3 = db.prepare("INSERT INTO t (name) VALUES (?)");
  if (s3.paramsCount !== 1) throw new Error(`one param: ${s3.paramsCount}`);
  db.close();
});

await test("prepare().finalize()", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const stmt = db.prepare("SELECT * FROM t");
  stmt.finalize();
  db.close();
});

await test("db.transaction() preserves return type", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  db.run("INSERT INTO t (val) VALUES ('x')");

  const insertMany = db.transaction((items: string[]) => {
    const stmt = db.prepare("INSERT INTO t (val) VALUES (?)");
    for (const item of items) stmt.run(item);
    return items.length;
  });

  const count = insertMany(["a", "b", "c"]);
  if (count !== 3) throw new Error(`count: ${count}`);

  const rows = db.prepare("SELECT COUNT(*) as c FROM t").get() as
    | { c: number }
    | undefined;
  if (!rows || rows.c !== 4) throw new Error(`total rows: ${rows?.c}`);
  db.close();
});

await test("db.transaction() rollback on error", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT UNIQUE)");
  db.run("INSERT INTO t (val) VALUES ('unique')");

  const fail = db.transaction(() => {
    db.run("INSERT INTO t (val) VALUES ('unique')");
  });

  try {
    fail();
    throw new Error("should have thrown");
  } catch {}
  const rows = db.prepare("SELECT COUNT(*) as c FROM t").get() as
    | { c: number }
    | undefined;
  if (rows!.c !== 1) throw new Error(`rows after rollback: ${rows!.c}`);
  db.close();
});

await test("prepare<T,U>() generic type args", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO t (name) VALUES ('typed')");
  type MyRow = { id: number; name: string };
  const stmt = db.prepare<MyRow, SQLQueryBindings>(
    "SELECT * FROM t WHERE id = ?",
  );
  const row = stmt.get(1);
  if (!row) throw new Error("expected row");
  if (row.name !== "typed") throw new Error(`name: ${row.name}`);
  db.close();
});

await test("db.run() multi-statement DDL", async () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY);",
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  if (tables.length < 2)
    throw new Error(`tables: ${tables.map((t) => t.name)}`);
  db.close();
});

await test("db.exec() PRAGMA", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  db.close();
});

await test("constructor { readonly: true }", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".db" });
  const db1 = new Database(tmpFile);
  db1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  db1.close();
  const db2 = new Database(tmpFile, { readonly: true });
  const tables = db2
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  if (tables.length !== 1) throw new Error(`tables: ${tables.length}`);
  db2.close();
  await Deno.remove(tmpFile);
});

await test("run().changes on mutation", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  const stmt = db.prepare("INSERT INTO t (val) VALUES (?)");
  const r1 = stmt.run("first");
  if (r1.changes !== 1) throw new Error(`insert changes: ${r1.changes}`);

  const updateStmt = db.prepare("UPDATE t SET val = ? WHERE id = ?");
  const r2 = updateStmt.run("updated", 1);
  if (r2.changes !== 1) throw new Error(`update changes: ${r2.changes}`);

  const deleteStmt = db.prepare("DELETE FROM t WHERE id = ?");
  const r3 = deleteStmt.run(1);
  if (r3.changes !== 1) throw new Error(`delete changes: ${r3.changes}`);
  db.close();
});

await test("inTransaction property", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  if (db.inTransaction) throw new Error("should not be in transaction");
  db.close();
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) Deno.exit(1);
