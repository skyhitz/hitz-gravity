// HITZ contract activity report generator.
//
// Two-step pipeline:
//   1. `fetch`     — pull new contract events from Soroban RPC, append to
//                    reports/data/events.jsonl. Idempotent + incremental;
//                    the last cursor is persisted next to the data file.
//   2. `generate`  — read the JSONL store, slice to a date window, and
//                    write a markdown report to reports/YYYY-MM.md.
//
// The JSONL store is committed to the repo so we never lose history when
// the public RPC drops events out of its retention window (~24h on most
// nodes). Each cron run extends the store; older data is never lost.
//
// Usage:
//   node scripts/contract-report.mjs fetch
//   node scripts/contract-report.mjs generate            # current month
//   node scripts/contract-report.mjs generate 2026-05    # explicit month
//   node scripts/contract-report.mjs all                 # fetch + generate
//
// Env overrides:
//   RPC_URL           — default https://soroban-rpc.mainnet.stellar.gateway.fm
//   HITZ_CONTRACT_ID  — default CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU
//   START_LEDGER      — first-run only: starting ledger if no cursor yet

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as StellarSdk from "@stellar/stellar-sdk";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const reportsDir = join(repoRoot, "reports");
const dataDir = join(reportsDir, "data");
const dataFile = join(dataDir, "events.jsonl");
const cursorFile = join(dataDir, "cursor.json");
// Disk cache of Stellar Expert contract metadata — keyed by C-address.
// Creator/created are immutable, so we don't need a TTL; we only ever
// fetch on cache miss. This keeps the monthly run from hammering the
// Stellar Expert API and means the report is reproducible offline.
const contractInfoFile = join(dataDir, "contract-info.json");

const RPC_URL =
  process.env.RPC_URL ?? "https://soroban-rpc.mainnet.stellar.gateway.fm";
const CONTRACT_ID =
  process.env.HITZ_CONTRACT_ID ??
  "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const STELLAR_EXPERT_API =
  process.env.STELLAR_EXPERT_API ??
  "https://api.stellar.expert/explorer/public";

// Stellar Expert anchor pages call these G-addrs out by role. Hard-coded
// so reports don't need a query to label them. Update if any rotate.
const SPONSOR = "GBER7ROBYH5NFFKXCDGTSMUKTDQ4U3MEUTUCPJRZZY6EYZVEFDBVNJNB";
const ADMIN = "GCAETBNBFKVGLYFXKCLMKT6ZVHFXHRSDFSEW7ODIUJYC6R7H2QJ6OKGU";

// ─── helpers ──────────────────────────────────────────────────────────

function ensureDirs() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

function readCursor() {
  if (!existsSync(cursorFile)) return null;
  try {
    return JSON.parse(readFileSync(cursorFile, "utf8"));
  } catch {
    return null;
  }
}

function writeCursor(cursor) {
  writeFileSync(cursorFile, JSON.stringify(cursor, null, 2) + "\n");
}

function readEvents() {
  if (!existsSync(dataFile)) return [];
  return readFileSync(dataFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// stellar-sdk's getEvents pre-decodes topic[] and value into ScVal
// objects (not base64 strings). Pass them directly to scValToNative.
// Addresses come back as G/C strings, ints as bigint, symbols as strings.
function decodeScVal(scv) {
  if (scv == null) return null;
  // Defensive: if the SDK ever changes and hands us a raw string, decode.
  if (typeof scv === "string") {
    return StellarSdk.scValToNative(
      StellarSdk.xdr.ScVal.fromXDR(scv, "base64")
    );
  }
  return StellarSdk.scValToNative(scv);
}

// Soroban events from getEvents() come with topic[] + value. The first
// topic is the event symbol — for events derived from #[contractevent]
// structs in lib.rs, that's the snake-cased struct name with the `_event`
// suffix dropped here for friendlier reporting (e.g. `transfer_event` →
// `transfer`). Remaining topics + value depend on the event's schema.
function parseEvent(evt) {
  const topics = (evt.topic ?? []).map(decodeScVal);
  const value = evt.value ? decodeScVal(evt.value) : null;
  let name =
    typeof topics[0] === "string" ? topics[0] : String(topics[0] ?? "");
  if (name.endsWith("_event")) name = name.slice(0, -"_event".length);

  return {
    ledger: evt.ledger,
    ts: evt.ledgerClosedAt, // ISO 8601
    txHash: evt.txHash,
    id: evt.id, // RPC cursor for this event
    name,
    topics: topics.slice(1),
    data: value,
    // JSON.stringify can't serialize bigint; coerce here so the JSONL
    // store stays valid JSON. Consumers cast back as needed.
    raw: undefined,
  };
}

// JSON.stringify with bigint → string conversion. Soroban i128 / u128
// decode to bigint via scValToNative.
const jsonStringify = (obj) =>
  JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// ─── fetch ────────────────────────────────────────────────────────────

async function fetchEvents() {
  ensureDirs();
  const server = new StellarSdk.rpc.Server(RPC_URL);

  let cursor = readCursor();
  let pageCursor = cursor?.cursor;

  // The Soroban RPC SDK requires `startLedger` on every getEvents call,
  // even when a `cursor` is supplied (the cursor takes precedence; the
  // startLedger is just a floor). Pick the floor as:
  //   - $START_LEDGER if explicitly overridden
  //   - the ledger of our newest stored event (we want to start AT or
  //     above it; cursor will skip us forward past already-seen events)
  //   - latest - 17000 if the store is empty (~24h, fits public retention)
  let startLedger;
  if (process.env.START_LEDGER) {
    startLedger = Number(process.env.START_LEDGER);
  } else if (pageCursor) {
    // Derive a safe floor from the last stored event so we never go
    // below RPC retention. The cursor itself supersedes startLedger.
    const last = readEvents().at(-1);
    startLedger = last?.ledger ?? 1;
  } else {
    const latest = await server.getLatestLedger();
    startLedger = Math.max(1, latest.sequence - 17000);
  }

  const filter = {
    type: "contract",
    contractIds: [CONTRACT_ID],
  };

  let totalNew = 0;
  let page;
  do {
    const req = {
      startLedger,
      pagination: {
        limit: 200,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      },
      filters: [filter],
    };
    try {
      page = await server.getEvents(req);
    } catch (err) {
      // Common RPC failure mode: requested startLedger is below retention.
      // Bump forward and try again. If we already have a cursor, surface
      // the error — it's not a retention problem.
      if (!pageCursor && /not within.*range|outside.*window/i.test(String(err))) {
        const latest = await server.getLatestLedger();
        startLedger = Math.max(1, latest.sequence - 8640); // ~12h
        console.warn(
          `[contract-report] RPC retention window too tight, retrying from ledger ${startLedger}`
        );
        continue;
      }
      throw err;
    }

    for (const evt of page.events ?? []) {
      const parsed = parseEvent(evt);
      appendFileSync(dataFile, jsonStringify(parsed) + "\n");
      totalNew++;
    }

    if (page.cursor) {
      pageCursor = page.cursor;
      writeCursor({ cursor: pageCursor, updatedAt: new Date().toISOString() });
    }
    // RPC returns fewer than the limit when we've caught up.
  } while (page.events && page.events.length === 200);

  console.log(
    `[contract-report] fetch complete: ${totalNew} new events appended`
  );
}

// ─── report generation ───────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr || typeof addr !== "string") return String(addr ?? "");
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function fmtHitz(stroops) {
  // Stroops come back as bigint or string (post-jsonl-roundtrip).
  const n = typeof stroops === "bigint" ? stroops : BigInt(stroops ?? "0");
  // Manual decimal formatting to avoid Number precision loss for big i128s.
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac.replace(/0+$/, "") || "0"}`;
}

// Soroban contract IDs start with C; Stellar account IDs with G. A
// quick prefix check is enough for our reporting — the on-chain types
// guarantee the convention.
function isContractAddr(addr) {
  return typeof addr === "string" && addr.startsWith("C") && addr.length === 56;
}

// ─── Stellar Expert metadata cache ────────────────────────────────────
//
// Used to enrich vault events with creator info: we want to be able to
// tell a personal arb bot (creator == initiator) from public routing
// infra (creator == DAO/team) at a glance, without hand-investigation.
//
// All fetches are best-effort: API failures degrade to "unknown" rather
// than blocking the report. The cache is committed to the repo so
// repeated runs are deterministic and don't hammer the API.

function readContractCache() {
  if (!existsSync(contractInfoFile)) return {};
  try {
    return JSON.parse(readFileSync(contractInfoFile, "utf8"));
  } catch {
    return {};
  }
}

function writeContractCache(cache) {
  writeFileSync(contractInfoFile, JSON.stringify(cache, null, 2) + "\n");
}

async function fetchContractInfo(id, cache) {
  if (cache[id]) return cache[id];
  const url = `${STELLAR_EXPERT_API}/contract/${id}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Keep only the fields we display — Stellar Expert returns more, but
    // we don't want the cache to bloat with churn-prone counters.
    cache[id] = {
      creator: body.creator ?? null,
      created: body.created ?? null,
      validation: body.validation?.status ?? null,
      validationRepo: body.validation?.repository ?? null,
      // Snapshot the version count at first-look. Subsequent reports
      // can compare against the live API if they want trend data, but
      // for our purposes a static reference is enough.
      versionsAtLookup: body.versions ?? null,
      lookedUpAt: new Date().toISOString(),
    };
    return cache[id];
  } catch (err) {
    console.warn(
      `[contract-report] could not fetch metadata for ${id}: ${err instanceof Error ? err.message : err}`
    );
    cache[id] = { error: true, lookedUpAt: new Date().toISOString() };
    return cache[id];
  }
}

function monthBounds(yyyymm) {
  // yyyymm in 'YYYY-MM' form. Returns [startISO, endISO) for the month.
  const [y, m] = yyyymm.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return [start.toISOString(), end.toISOString()];
}

function currentYM() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function inWindow(ts, startISO, endISO) {
  return ts >= startISO && ts < endISO;
}

// Strict YYYY-MM validation. Defense-in-depth — the GitHub workflow
// validates too, but anyone running locally could pass `../foo` which
// would otherwise let us write outside reports/.
const YYYYMM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function generateReport(yyyymm = currentYM()) {
  if (!YYYYMM_RE.test(yyyymm)) {
    throw new Error(`invalid month: ${yyyymm} (expected YYYY-MM)`);
  }
  ensureDirs();
  const [startISO, endISO] = monthBounds(yyyymm);
  const allEvents = readEvents();
  const events = allEvents.filter((e) => inWindow(e.ts, startISO, endISO));

  if (events.length === 0) {
    console.warn(
      `[contract-report] no events in window ${startISO}..${endISO} (store has ${allEvents.length} total)`
    );
  }

  // Bucketise by event name. The contract emits:
  //   transfer, mint, burn, approve, vault, register_pool, register_router,
  //   admin_changed, initialize
  const byName = new Map();
  for (const e of events) {
    const k = e.name || "unknown";
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }

  const transfers = byName.get("transfer") ?? [];
  const mints = byName.get("mint") ?? [];
  const burns = byName.get("burn") ?? [];
  const vaults = byName.get("vaulted") ?? [];
  const poolRegs = byName.get("pool_registered") ?? [];
  const routerRegs = byName.get("router_registered") ?? [];
  const adminChanges = byName.get("admin_changed") ?? [];

  // Active addresses: union of all `from`/`to`/`account` topics.
  const addrs = new Set();
  const txCountPerAddr = new Map();
  const bump = (addr) => {
    if (!addr) return;
    addrs.add(addr);
    txCountPerAddr.set(addr, (txCountPerAddr.get(addr) ?? 0) + 1);
  };
  for (const e of transfers) {
    bump(e.topics[0]); // from
    bump(e.topics[1]); // to
  }
  for (const e of mints) bump(e.topics[0]);
  for (const e of burns) bump(e.topics[0]);

  // Transfer volume.
  let transferVolume = 0n;
  for (const e of transfers) {
    transferVolume += BigInt(e.data ?? "0");
  }

  // Sponsor + admin direct-transfer activity.
  const sponsorTransfers = transfers.filter((e) => e.topics[0] === SPONSOR);
  const sponsorVolume = sponsorTransfers.reduce(
    (s, e) => s + BigInt(e.data ?? "0"),
    0n
  );
  const adminTransfers = transfers.filter((e) => e.topics[0] === ADMIN);

  // Top participants by transfer count.
  const topAddrs = [...txCountPerAddr.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Per-day count for a tiny activity chart.
  const perDay = new Map();
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const days = [...perDay.entries()].sort();

  // Vault transitions (in/out).
  const trapped = vaults.filter((e) => e.data === true).length;
  const released = vaults.filter((e) => e.data === false).length;

  // ─── render ────────────────────────────────────────────────────────
  const lines = [];
  const push = (s = "") => lines.push(s);

  push(`# HITZ on-chain report — ${yyyymm}`);
  push("");
  push(
    `> Auto-generated by \`scripts/contract-report.mjs generate ${yyyymm}\`. ` +
      `Data window: \`${startISO}\` to \`${endISO}\`.`
  );
  push("");
  push("## Summary");
  push("");
  push("| Metric | Value |");
  push("|---|---|");
  push(`| Events emitted | ${events.length.toLocaleString()} |`);
  push(`| Distinct addresses active | ${addrs.size} |`);
  push(`| Transfer events | ${transfers.length} |`);
  push(`| Transfer volume | ${fmtHitz(transferVolume)} HITZ |`);
  push(`| Mints | ${mints.length} |`);
  push(`| Burns | ${burns.length} |`);
  push(
    `| Vault transitions | ${trapped} trapped / ${released} released |`
  );
  push(`| Pool register/remove events | ${poolRegs.length} |`);
  push(`| Router register/remove events | ${routerRegs.length} |`);
  push(`| Admin changes | ${adminChanges.length} |`);
  push("");

  if (days.length > 0) {
    push("## Daily activity");
    push("");
    push("| Date | Events |");
    push("|---|---|");
    for (const [d, n] of days) push(`| ${d} | ${n} |`);
    push("");
  }

  if (topAddrs.length > 0) {
    push("## Most active addresses");
    push("");
    push("| Address | Events touched | Role |");
    push("|---|---|---|");
    for (const [a, n] of topAddrs) {
      let role = "";
      if (a === SPONSOR) role = "**sponsor**";
      else if (a === ADMIN) role = "**admin**";
      else if (a.startsWith("C")) role = "contract (pool/router)";
      push(`| \`${shortAddr(a)}\` | ${n} | ${role} |`);
    }
    push("");
  }

  if (sponsorTransfers.length > 0) {
    push("## Sponsor activity (legacy reparation)");
    push("");
    push(
      `${sponsorTransfers.length} transfer(s) from sponsor → users, ` +
        `totaling **${fmtHitz(sponsorVolume)} HITZ**.`
    );
    push("");
    push("| Date | Recipient | Amount |");
    push("|---|---|---|");
    for (const e of sponsorTransfers.slice(0, 25)) {
      push(
        `| ${e.ts.slice(0, 10)} | \`${shortAddr(e.topics[1])}\` | ${fmtHitz(e.data)} HITZ |`
      );
    }
    if (sponsorTransfers.length > 25) {
      push(`| … | … | (${sponsorTransfers.length - 25} more) |`);
    }
    push("");
  }

  if (adminTransfers.length > 0) {
    push("## Admin direct transfers");
    push("");
    push(`${adminTransfers.length} transfer(s) initiated by the admin key.`);
    push("");
  }

  if (poolRegs.length + routerRegs.length + adminChanges.length > 0) {
    push("## Governance events");
    push("");
    push("| Type | Address | Registered? | Tx |");
    push("|---|---|---|---|");
    for (const e of [...poolRegs, ...routerRegs]) {
      const addr = e.topics[0];
      const reg = e.data === true ? "yes" : e.data === false ? "no" : "—";
      push(
        `| ${e.name} | \`${shortAddr(addr)}\` | ${reg} | \`${e.txHash?.slice(0, 8)}…\` |`
      );
    }
    for (const e of adminChanges) {
      push(
        `| admin_changed | from \`${shortAddr(e.topics[0])}\` → \`${shortAddr(e.topics[1])}\` | — | \`${e.txHash?.slice(0, 8)}…\` |`
      );
    }
    push("");
  }

  if (trapped > 0 || released > 0) {
    push("## Vault dynamics");
    push("");
    push(
      `${trapped} account vault-traps and ${released} releases during the window. ` +
        "Non-zero counts are normal — L (the Event Horizon) shifts continuously with pool " +
        "reserves, so accounts holding HITZ near the limit cross it routinely. The signal to " +
        "watch is **transient** (trap+release in the same tx → lazy evaluation passing through " +
        "an arber or LP shuffle, exactly as designed) vs **persistent** (an account stuck in " +
        "the vault state across multiple txs → a real holder waiting for L to grow back, or a " +
        "contract that's accidentally accumulating)."
    );
    push("");

    // Group vault events by address+tx and pair trap↔release within
    // the same transaction. This is the line between healthy lazy-eval
    // pass-throughs and stuck accounts.
    const vaultByTx = new Map(); // txHash → [events]
    for (const e of vaults) {
      const arr = vaultByTx.get(e.txHash) ?? [];
      arr.push(e);
      vaultByTx.set(e.txHash, arr);
    }

    // Pre-fetch contract metadata for every C-address that appears in
    // a vault event. We do this concurrently so the wait is bounded by
    // the slowest single API call, not the sum of them.
    const cache = readContractCache();
    const vaultedContracts = new Set();
    for (const e of vaults) {
      const a = e.topics[0];
      if (isContractAddr(a)) vaultedContracts.add(a);
    }
    await Promise.all(
      [...vaultedContracts].map((id) => fetchContractInfo(id, cache))
    );
    writeContractCache(cache);

    // Build a per-tx classification.
    const rows = [];
    for (const [txHash, evs] of vaultByTx) {
      // Sort by op-idx so we keep chronological order within the tx.
      evs.sort((a, b) => (a.id < b.id ? -1 : 1));
      // Group by address so traps and releases on the same address pair up.
      const byAddr = new Map();
      for (const e of evs) {
        const a = e.topics[0];
        const arr = byAddr.get(a) ?? [];
        arr.push(e);
        byAddr.set(a, arr);
      }

      // HITZ flow through each address in this tx, for context.
      const txTransfers = transfers.filter((t) => t.txHash === txHash);
      const inflowByAddr = new Map();
      const outflowByAddr = new Map();
      for (const t of txTransfers) {
        const [from, to] = t.topics;
        const amt = BigInt(t.data ?? "0");
        outflowByAddr.set(from, (outflowByAddr.get(from) ?? 0n) + amt);
        inflowByAddr.set(to, (inflowByAddr.get(to) ?? 0n) + amt);
      }

      for (const [addr, addrEvents] of byAddr) {
        const trappedHere = addrEvents.some((e) => e.data === true);
        const releasedHere = addrEvents.some((e) => e.data === false);
        const transient = trappedHere && releasedHere;

        const info = isContractAddr(addr) ? cache[addr] : null;
        let label;
        if (addr === SPONSOR) label = "**sponsor**";
        else if (addr === ADMIN) label = "**admin**";
        else if (isContractAddr(addr)) {
          if (info?.creator) {
            label = `contract (creator \`${shortAddr(info.creator)}\``;
            if (info.validation === "verified") label += ", verified source";
            label += ")";
          } else {
            label = "contract (metadata unavailable)";
          }
        } else {
          label = "external account";
        }

        rows.push({
          txHash,
          ts: addrEvents[0].ts,
          addr,
          label,
          transient,
          trappedHere,
          releasedHere,
          inflow: inflowByAddr.get(addr) ?? 0n,
          outflow: outflowByAddr.get(addr) ?? 0n,
          info,
        });
      }
    }

    // Render: transient pairs first (the healthy case), then anything
    // that didn't get released within the same tx.
    const transients = rows.filter((r) => r.transient);
    const sticky = rows.filter((r) => !r.transient);

    if (transients.length > 0) {
      push("### Transient — trap + release in same tx (lazy evaluation firing)");
      push("");
      push(
        "These are the model working correctly. An account briefly exceeded L while " +
          "intermediating a transfer, then the next outflow brought it back under. No user-visible delay."
      );
      push("");
      push("| When | Address | Type | HITZ in / out (same tx) | Tx |");
      push("|---|---|---|---|---|");
      for (const r of transients) {
        const flow = `+${fmtHitz(r.inflow)} / -${fmtHitz(r.outflow)}`;
        push(
          `| ${r.ts.slice(0, 19).replace("T", " ")} | \`${shortAddr(r.addr)}\` | ${r.label} | ${flow} | [\`${r.txHash.slice(0, 8)}…\`](https://stellar.expert/explorer/public/tx/${r.txHash}) |`
        );
      }
      push("");
    }

    if (sticky.length > 0) {
      push("### Persistent — vault state changed but did not flip back in the same tx");
      push("");
      push(
        "These are worth a closer look — either a holder is parked above L waiting for the protocol to grow into them, " +
          "or a contract is acquiring HITZ instead of routing through. Cross-reference with the address's other " +
          "transfers in this window."
      );
      push("");
      push("| When | Address | Type | State change | HITZ in / out (same tx) | Tx |");
      push("|---|---|---|---|---|---|");
      for (const r of sticky) {
        const change = r.trappedHere
          ? "→ **vaulted**"
          : "→ released";
        const flow = `+${fmtHitz(r.inflow)} / -${fmtHitz(r.outflow)}`;
        push(
          `| ${r.ts.slice(0, 19).replace("T", " ")} | \`${shortAddr(r.addr)}\` | ${r.label} | ${change} | ${flow} | [\`${r.txHash.slice(0, 8)}…\`](https://stellar.expert/explorer/public/tx/${r.txHash}) |`
        );
      }
      push("");
    }
  }

  push("---");
  push("");
  push(
    `Source-validated contract: ` +
      `[\`${CONTRACT_ID}\`](https://stellar.expert/explorer/public/contract/${CONTRACT_ID})`
  );
  push("");

  const outFile = join(reportsDir, `${yyyymm}.md`);
  writeFileSync(outFile, lines.join("\n"));
  console.log(`[contract-report] wrote ${outFile}`);
}

// ─── cli ──────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const arg = process.argv[3];

(async () => {
  switch (cmd) {
    case "fetch":
      await fetchEvents();
      break;
    case "generate":
      await generateReport(arg);
      break;
    case "all":
      await fetchEvents();
      await generateReport(arg);
      break;
    default:
      console.error(
        "usage: contract-report.mjs <fetch|generate [YYYY-MM]|all [YYYY-MM]>"
      );
      process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
