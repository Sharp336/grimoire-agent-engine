import { Database as BaseDatabase } from "@lu-zero/bun-compat/sqlite";
import { type StatementSync } from "node:sqlite";

type SqliteValue = string | number | bigint | Uint8Array | null;

class Statement {
  #stmt: StatementSync;
  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
  }
  get(...params: SqliteValue[]) {
    return this.#stmt.get(...params) as Record<string, SqliteValue> | undefined;
  }
  all(...params: SqliteValue[]) {
    return this.#stmt.all(...params) as Record<string, SqliteValue>[];
  }
  run(...params: SqliteValue[]) {
    return this.#stmt.run(...params);
  }
}

export class Database {
  #db: BaseDatabase;

  constructor(
    path: string,
    options?: { create?: boolean; readwrite?: boolean },
  ) {
    this.#db = new BaseDatabase(path, options);
  }

  #wrapStmt(stmt: StatementSync): Statement {
    return new Statement(stmt);
  }

  prepare(sql: string): Statement {
    return this.#wrapStmt(this.#db.prepare(sql));
  }

  run(sql: string, params?: Record<string, SqliteValue>) {
    if (!params && sql.includes(";")) {
      this.exec(sql);
      return { changes: 0, lastInsertRowid: 0n };
    }
    return this.#db.run(sql, params);
  }

  query(sql: string, params?: Record<string, SqliteValue>) {
    return this.#db.query(sql, params);
  }

  exec(sql: string) {
    this.#db.exec(sql);
  }

  close() {
    this.#db.close();
  }

  get inTransaction() {
    return this.#db.inTransaction;
  }

  serialize(fn?: () => void) {
    this.#db.serialize(fn);
  }

  deserialize(fn?: () => void) {
    this.#db.deserialize(fn);
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return this.#db.transaction(fn) as (...args: unknown[]) => T;
  }
}
