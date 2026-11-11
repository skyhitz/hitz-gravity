// A D1 database for tests: the Worker's own migrations applied to an
// in-memory SQLite (node:sqlite), behind the part of the D1 API the Worker
// uses. The SQL under test runs for real; nothing is mocked.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  #rows() {
    return this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
  }
  async all() {
    return { results: this.#rows(), success: true };
  }
  async first(column) {
    const row = this.#rows()[0] ?? null;
    return row && column ? row[column] : row;
  }
  async run() {
    return { results: this.#rows(), success: true };
  }
}

/** A fresh database with every migration in migrations/ applied, in order. */
export function testDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return {
    prepare: (sql) => new Statement(db, sql),
    batch: async (statements) => Promise.all(statements.map((s) => s.all())),
    /** Test-only escape hatch for arranging and inspecting rows. */
    raw: db,
  };
}
