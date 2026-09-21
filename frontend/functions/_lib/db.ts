// Small D1 helpers shared by the ingestion cron and the /api/data routes.

/** D1 caps bound parameters per query at 100. */
const MAX_PARAMS = 100;

/**
 * Multi-row insert, chunked to stay under D1's parameter cap, sent as one
 * batch. `verb` picks the conflict policy ("INSERT OR IGNORE" for
 * append-only data, "INSERT OR REPLACE" for recomputed rows).
 */
export async function insertMany(
  db: D1Database,
  verb: "INSERT OR IGNORE" | "INSERT OR REPLACE",
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  if (!rows.length) return;
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    statements.push(
      db
        .prepare(`${verb} INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")}`)
        .bind(...chunk.flat())
    );
  }
  await db.batch(statements);
}

/** Values from `column` that already exist in `table`, checked in parameter-sized chunks. */
export async function existing(
  db: D1Database,
  table: string,
  column: string,
  values: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < values.length; i += MAX_PARAMS) {
    const chunk = values.slice(i, i + MAX_PARAMS);
    const { results } = await db
      .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ v: string }>();
    for (const r of results) found.add(r.v);
  }
  return found;
}

export async function getCursor(db: D1Database, source: string): Promise<string | null> {
  const row = await db.prepare("SELECT cursor FROM cursors WHERE source = ?").bind(source).first<{ cursor: string }>();
  return row?.cursor ?? null;
}

export async function setCursor(db: D1Database, source: string, cursor: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO cursors (source, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at"
    )
    .bind(source, cursor, new Date().toISOString())
    .run();
}
