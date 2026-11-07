// Backfill for our own holder index (the D1 `holders` table).
//
// The cron indexes every address that appears in a stored HITZ event, but
// the event store starts on May 11, 2026, and HITZ itself started on April
// 25 (ledger 62283705, tx 22f572c3…). Holders whose HITZ arrived before the
// store and who haven't moved it since appear in no stored event. This finds
// them without Stellar Expert (whose API now charges per request):
//
//   1. Candidates
//      a. holders of the classic HITZ asset (the legacy community);
//      b. every address in a HITZ transfer / transfer_from / mint call that a
//         known account made before the store started (Horizon operations,
//         parameters decoded);
//      c. every HITZ `Balance(addr)` key in the Soroban footprint of any
//         transaction in a ledger where an Aquarius pool traded before the
//         store started (ledgers from D1 `pool_reserves`; envelopes from
//         Horizon). Every HITZ purchase in that window went through one.
//      Step b repeats for each account found until nothing new turns up.
//   2. Keeps the candidates that hold a `Balance` entry on the ledger.
//   3. Proves completeness: total_supply() minus the balances of every
//      indexed holder is the HITZ held by addresses still unknown.
//   4. Writes the new holders as a migration (--out), for review.
//
// Usage (from frontend/, with wrangler logged in for the D1 reads):
//   node --experimental-strip-types scripts/backfill-holders.mjs --out migrations/0003_holders_backfill.sql
//
// Behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1. Horizon allows about
// 3,600 requests an hour; the script backs off when it is throttled.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const HITZ = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const ADMIN = "GCAETBNBFKVGLYFXKCLMKT6ZVHFXHRSDFSEW7ODIUJYC6R7H2QJ6OKGU";
const HITZ_FIRST_LEDGER = 62_283_705;
const HORIZON = "https://horizon.stellar.org";
const RPC_URL = "https://soroban-rpc.mainnet.stellar.gateway.fm";
const VIEW_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const isAddress = (v) => typeof v === "string" && v.length === 56 && (v[0] === "G" || v[0] === "C");

function d1(sql) {
  const res = spawnSync("npx", ["--yes", "wrangler@4", "d1", "execute", "hitz-data", "--remote", "--json", "--command", sql], {
    cwd: frontendDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`wrangler d1 failed: ${res.stderr}`);
  return JSON.parse(res.stdout)[0].results;
}

async function horizon(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : HORIZON + path, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (attempt >= 8 || (res.status !== 429 && res.status < 500)) throw new Error(`Horizon HTTP ${res.status} ${path}`);
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    await new Promise((r) => setTimeout(r, Number.isFinite(reset) && reset > 0 ? Math.min(reset, 120) * 1000 : 2000 * 2 ** attempt));
  }
}

/** Soroban RPC over plain fetch (works behind HTTPS proxies, unlike older axios). */
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function view(method) {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(VIEW_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  })
    .addOperation(new StellarSdk.Contract(HITZ).call(method))
    .setTimeout(30)
    .build();
  const sim = await rpc("simulateTransaction", { transaction: tx.toXDR() });
  if (sim.error || !sim.results?.[0]) throw new Error(`${method} failed: ${sim.error}`);
  return StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(sim.results[0].xdr, "base64"));
}

/** address → raw balance, for the addresses that hold a HITZ Balance entry. */
async function balances(addresses) {
  const contract = StellarSdk.Address.fromString(HITZ).toScAddress();
  const out = new Map();
  const list = [...addresses].filter(isAddress);
  for (let i = 0; i < list.length; i += 200) {
    const keys = list.slice(i, i + 200).map((a) =>
      StellarSdk.xdr.LedgerKey.contractData(
        new StellarSdk.xdr.LedgerKeyContractData({
          contract,
          key: StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol("Balance"), StellarSdk.Address.fromString(a).toScVal()]),
          durability: StellarSdk.xdr.ContractDataDurability.persistent(),
        })
      )
    );
    const { entries } = await rpc("getLedgerEntries", { keys: keys.map((k) => k.toXDR("base64")) });
    for (const e of entries ?? []) {
      const data = StellarSdk.xdr.LedgerEntryData.fromXDR(e.xdr, "base64").contractData();
      out.set(StellarSdk.Address.fromScAddress(data.key().vec()[1].address()).toString(), BigInt(StellarSdk.scValToNative(data.val())));
    }
  }
  return out;
}

/** Addresses in HITZ transfer / transfer_from / mint calls this account made in [from, until). */
async function callRecipients(account, untilIso) {
  const found = new Set();
  let url = `/accounts/${account}/operations?order=asc&limit=200&cursor=${BigInt(HITZ_FIRST_LEDGER) << 32n}`;
  while (url) {
    const page = await horizon(url);
    if (!page) break;
    const records = page._embedded.records;
    let done = false;
    for (const r of records) {
      if (r.created_at >= untilIso) {
        done = true;
        break;
      }
      if (r.type !== "invoke_host_function" || !String(r.function).endsWith("InvokeContract")) continue;
      let vals;
      try {
        vals = (r.parameters ?? []).map((p) => StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(p.value, "base64")));
      } catch {
        continue;
      }
      if (vals[0] === HITZ && ["transfer", "transfer_from", "mint"].includes(vals[1])) for (const v of vals.slice(2)) if (isAddress(v)) found.add(v);
    }
    url = !done && records.length === 200 ? page._links.next.href : null;
  }
  return found;
}

/** HITZ Balance(addr) keys in the Soroban footprints of a ledger's transactions. */
async function footprintHolders(ledger) {
  const found = new Set();
  let url = `/ledgers/${ledger}/transactions?limit=200&include_failed=false`;
  while (url) {
    const page = await horizon(url);
    if (!page) break;
    for (const t of page._embedded.records) {
      const env = StellarSdk.xdr.TransactionEnvelope.fromXDR(t.envelope_xdr, "base64");
      const kind = env.switch().name;
      const tx = kind === "envelopeTypeTx" ? env.v1().tx() : kind === "envelopeTypeTxFeeBump" ? env.feeBump().tx().innerTx().v1().tx() : null;
      if (!tx || tx.ext().switch() !== 1) continue;
      const fp = tx.ext().sorobanData().resources().footprint();
      for (const k of [...fp.readOnly(), ...fp.readWrite()]) {
        if (k.switch().name !== "contractData") continue;
        const cd = k.contractData();
        if (StellarSdk.Address.fromScAddress(cd.contract()).toString() !== HITZ) continue;
        const key = cd.key();
        if (key.switch().name !== "scvVec") continue;
        const vec = key.vec();
        if (vec?.length === 2 && vec[0].switch().name === "scvSymbol" && vec[0].sym().toString() === "Balance") {
          found.add(StellarSdk.Address.fromScAddress(vec[1].address()).toString());
        }
      }
    }
    url = page._embedded.records.length === 200 ? page._links.next.href : null;
  }
  return found;
}

// ─── Inputs from D1 ──────────────────────────────────────────────────────────

const [{ first_ts: storeStartTs }] = d1("SELECT min(ts) AS first_ts FROM hitz_events");
const storeStartUnix = Math.floor(Date.parse(storeStartTs) / 1000);
const indexed = new Set(
  d1(
    `SELECT DISTINCT a FROM (SELECT json_extract(topics, '$[0]') AS a FROM hitz_events WHERE name IN ('transfer', 'mint', 'burn', 'vaulted')
       UNION SELECT json_extract(topics, '$[1]') FROM hitz_events WHERE name = 'transfer') WHERE a IS NOT NULL`
  ).map((r) => r.a)
);
const poolLedgers = d1(
  `SELECT DISTINCT (CAST(substr(event_id, 1, 19) AS INTEGER) >> 32) AS ledger FROM pool_reserves
     WHERE pool NOT LIKE '%:%' AND ts <= ${storeStartUnix} ORDER BY ledger`
).map((r) => r.ledger);
console.log(`[holders] event store starts ${storeStartTs}; ${indexed.size} addresses indexed from events; ${poolLedgers.length} pool-trade ledgers before it`);

// ─── Candidates ──────────────────────────────────────────────────────────────

const candidates = new Set(indexed);
for (let url = `/accounts?asset=HITZ:${ADMIN}&limit=200`; url; ) {
  const page = await horizon(url);
  for (const r of page._embedded.records) candidates.add(r.account_id);
  url = page._embedded.records.length === 200 ? page._links.next.href : null;
}
console.log(`[holders] + classic HITZ holders: ${candidates.size} candidates`);

for (let i = 0; i < poolLedgers.length; i += 8) {
  const batch = await Promise.all(poolLedgers.slice(i, i + 8).map(footprintHolders));
  for (const s of batch) for (const a of s) candidates.add(a);
}
console.log(`[holders] + launch-window trade footprints: ${candidates.size} candidates`);

// Recipients of HITZ calls by every known account, until a fixpoint.
const scanned = new Set();
for (let round = 1; ; round++) {
  const queue = [...candidates].filter((a) => a.startsWith("G") && !scanned.has(a));
  if (!queue.length) break;
  for (const a of queue) {
    scanned.add(a);
    for (const r of await callRecipients(a, storeStartTs)) candidates.add(r);
  }
  console.log(`[holders] round ${round}: scanned ${scanned.size} accounts, ${candidates.size} candidates`);
}

// ─── Ledger check + completeness ─────────────────────────────────────────────

const held = await balances(candidates);
const supply = BigInt(await view("total_supply"));
const sum = [...held.values()].reduce((s, v) => s + v, 0n);
const fresh = [...held.keys()].filter((a) => !indexed.has(a)).sort();
const fmt = (v) => (Number(v) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 7 });
console.log(`[holders] ${held.size} addresses hold a HITZ balance entry; ${fresh.length} are not in the event-derived index`);
console.log(`[holders] total supply ${fmt(supply)}; indexed balances ${fmt(sum)}; unindexed ${fmt(supply - sum)}`);

if (outFile) {
  const now = new Date().toISOString();
  const lines = [
    `-- hitz-data: holders older than the event store (${storeStartTs}), found by`,
    "-- scripts/backfill-holders.mjs. With them the index covers",
    `-- ${fmt(sum)} of ${fmt(supply)} HITZ (unindexed: ${fmt(supply - sum)}).`,
    "",
    "INSERT OR IGNORE INTO holders (address, source, added_at) VALUES",
    fresh.map((a) => `  ('${a}', 'backfill', '${now}')`).join(",\n") + ";",
    "",
  ];
  writeFileSync(join(process.cwd(), outFile), fresh.length ? lines.join("\n") : "-- nothing to backfill\n");
  console.log(`[holders] wrote ${outFile}`);
}
