// One-time import of the git-committed report data store into D1.
//
//   reports/data/events.jsonl      → hitz_events
//   reports/data/cursor.json       → cursors ('hitz-rpc')
//   reports/data/contract-info.json → contract_info
//   reports/data/tx-info.json       → tx_info
//
// Idempotent: every insert is INSERT OR IGNORE, so re-running (e.g. after
// the old daily GitHub job appended a few more rows) only adds what's new.
// The cursor is inserted without overwrite — once the Worker cron owns it,
// an import can never move it backwards.
//
// The JSONL has a handful of duplicate rows from before the fetcher
// deduped (identical copies, May 2026). The `id` primary key collapses
// them, keeping the first occurrence.
//
// Usage (from frontend/):
//   node scripts/migrate-to-d1.mjs --local    # wrangler dev's local D1
//   node scripts/migrate-to-d1.mjs --remote   # production D1

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, "..");
const dataDir = join(frontendDir, "..", "reports", "data");
const DB = "hitz-data";
const WRANGLER = ["--yes", "wrangler@4.87.0"];

const target = process.argv.includes("--remote")
  ? "--remote"
  : process.argv.includes("--local")
    ? "--local"
    : null;
if (!target) {
  console.error("usage: node scripts/migrate-to-d1.mjs --local|--remote");
  process.exit(1);
}

// D1 rejects statements over 100 KB; stay well under.
const MAX_STATEMENT_BYTES = 90_000;

const sql = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};

/** Pack rows into multi-row INSERT OR IGNORE statements under the size cap. */
function inserts(table, columns, rows) {
  const head = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES\n`;
  const out = [];
  let batch = [];
  let size = head.length;
  for (const row of rows) {
    const tuple = `(${row.map(sql).join(", ")})`;
    if (batch.length && size + tuple.length + 2 > MAX_STATEMENT_BYTES) {
      out.push(head + batch.join(",\n") + ";");
      batch = [];
      size = head.length;
    }
    batch.push(tuple);
    size += tuple.length + 2;
  }
  if (batch.length) out.push(head + batch.join(",\n") + ";");
  return out;
}

function readJson(file, fallback) {
  const p = join(dataDir, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}

function wrangler(args, { json = false } = {}) {
  const res = spawnSync("npx", [...WRANGLER, "d1", "execute", DB, target, ...args, ...(json ? ["--json"] : [])], {
    cwd: frontendDir,
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`wrangler d1 execute failed (${res.status})`);
  return json ? JSON.parse(res.stdout) : null;
}

// ─── Build SQL ───────────────────────────────────────────────────────────────

const events = readFileSync(join(dataDir, "events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const cursor = readJson("cursor.json", null);
const contractInfo = readJson("contract-info.json", {});
const txInfo = readJson("tx-info.json", {});

const statements = [
  ...inserts(
    "hitz_events",
    ["id", "ledger", "ts", "tx_hash", "name", "topics", "data"],
    events.map((e) => [
      e.id,
      e.ledger,
      e.ts,
      e.txHash,
      e.name,
      JSON.stringify(e.topics ?? []),
      e.data === undefined ? null : JSON.stringify(e.data),
    ])
  ),
  ...inserts(
    "contract_info",
    ["address", "info"],
    Object.entries(contractInfo).map(([k, v]) => [k, JSON.stringify(v)])
  ),
  ...inserts(
    "tx_info",
    ["hash", "info"],
    Object.entries(txInfo).map(([k, v]) => [k, JSON.stringify(v)])
  ),
  ...(cursor?.cursor
    ? inserts("cursors", ["source", "cursor", "updated_at"], [["hitz-rpc", cursor.cursor, cursor.updatedAt ?? new Date().toISOString()]])
    : []),
];

const file = join(mkdtempSync(join(tmpdir(), "hitz-d1-")), "import.sql");
writeFileSync(file, statements.join("\n\n") + "\n");
console.log(`[migrate] ${statements.length} statements → ${file}`);

// ─── Apply + verify ──────────────────────────────────────────────────────────

wrangler(["--file", file]);

const uniqueEvents = new Set(events.map((e) => e.id)).size;
const [{ results }] = wrangler(
  [
    "--command",
    "SELECT (SELECT count(*) FROM hitz_events) AS events, (SELECT count(*) FROM contract_info) AS contracts, (SELECT count(*) FROM tx_info) AS txs, (SELECT cursor FROM cursors WHERE source = 'hitz-rpc') AS cursor",
  ],
  { json: true }
);
const got = results[0];
console.log("[migrate] D1 now holds:", got);

const checks = [
  ["events", got.events >= uniqueEvents, `${got.events} ≥ ${uniqueEvents} unique ids in events.jsonl`],
  ["contract_info", got.contracts >= Object.keys(contractInfo).length, `${got.contracts} ≥ ${Object.keys(contractInfo).length}`],
  ["tx_info", got.txs >= Object.keys(txInfo).length, `${got.txs} ≥ ${Object.keys(txInfo).length}`],
  ["cursor", !cursor?.cursor || !!got.cursor, `cursor ${got.cursor ?? "missing"}`],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`[migrate] ${pass ? "✓" : "✗"} ${name}: ${detail}`);
  ok &&= pass;
}
process.exit(ok ? 0 : 1);
