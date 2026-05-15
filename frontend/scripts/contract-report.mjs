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
// Disk cache of Horizon tx envelope info — keyed by tx hash. Lets us
// know who initiated each tx (source account) and whether it was
// fee-bumped (= routed through the sponsor's gateway = email user).
const txInfoFile = join(dataDir, "tx-info.json");

const RPC_URL =
  process.env.RPC_URL ?? "https://soroban-rpc.mainnet.stellar.gateway.fm";
const CONTRACT_ID =
  process.env.HITZ_CONTRACT_ID ??
  "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const STELLAR_EXPERT_API =
  process.env.STELLAR_EXPERT_API ??
  "https://api.stellar.expert/explorer/public";
const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon.stellar.org";

// Hand-curated registry of well-known mainnet contracts. The cache
// auto-discovers creators for *any* contract, but for established
// protocols we want a friendly label rather than a "creator = G..."
// breadcrumb. Add entries here as you identify new infrastructure;
// the report uses these labels in preference to anything cached.
const KNOWN_CONTRACTS = {
  // Token SACs (Soroban Asset Contracts on mainnet)
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: {
    label: "XLM (native SAC)",
    kind: "token",
  },
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: {
    label: "USDC (Circle SAC)",
    kind: "token",
  },
  CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK: {
    label: "AQUA (Aquarius)",
    kind: "token",
  },
  // HITZ-registered routers (admin-registered Apr 2026, before our event
  // store starts — the runtime hitzRouters set won't include these
  // until we backfill events from launch). Hard-coded so reports
  // display the right role from day one.
  CCPGFQUTSEHDIQODRE3GJDNE64A35HZ32L7LPDN7GXOCIYNBJSMS6V6B: {
    label: "registered HITZ router (primary)",
    kind: "router",
  },
  CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK: {
    label: "registered HITZ router (secondary)",
    kind: "router",
  },
  // Aqua AMM pools paired with HITZ — frequent pass-through endpoints.
  CCCDPF74BFBIHCBWCA3QX5R2UULH4VSJFOK6KL44KDKJS75ZKJJYUSPH: {
    label: "Aqua AMM pool (HITZ pair)",
    kind: "pool",
  },
  CBMOEJUOKI72AXRPEQCRYSWDUBMI2LZEYVFJUTB256FO3WYSYSZI5F5A: {
    label: "Aqua AMM pool (HITZ pair)",
    kind: "pool",
  },
};

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

// Render an address with a human label. For G-accounts: sponsor/admin
// or "external account". For C-addresses: well-known protocol name (if
// in KNOWN_CONTRACTS), then registered-pool/router (from HITZ's own
// registration events), then cached-creator info, then a generic label.
// The `txSource` argument lets us flag "this contract was deployed by
// the tx initiator" — strong signal of a personal arb bot.
function describeAddress(addr, ctx) {
  if (!addr) return "—";
  if (!isContractAddr(addr)) {
    if (addr === SPONSOR) return "**sponsor** (gateway)";
    if (addr === ADMIN) return "**admin**";
    return "external account";
  }
  const known = KNOWN_CONTRACTS[addr];
  if (known) return known.label;
  if (ctx?.hitzPools?.has(addr)) return "HITZ-registered pool";
  if (ctx?.hitzRouters?.has(addr)) return "HITZ-registered router";
  const info = ctx?.contractCache?.[addr];
  if (info?.creator) {
    const isOwnerCalled =
      ctx?.txSource && ctx.txSource === info.creator;
    const subInv = info.subinvocationAtLookup ?? 0;
    let label;
    if (isOwnerCalled) {
      label = `personal contract (owner-deployed, ${info.versionsAtLookup ?? 0} versions)`;
    } else if (subInv > 10_000) {
      // 10k+ subinvocations puts a contract well outside "personal
      // tool" territory — that's Stellar-network-wide DEX / lending /
      // protocol traffic. Below this threshold we just show creator.
      label = `infrastructure contract (${subInv.toLocaleString()} sub-invocations network-wide)`;
    } else {
      label = `contract (creator \`${shortAddr(info.creator)}\`)`;
    }
    if (info.validation === "verified") label += " · source verified";
    return label;
  }
  return "contract (metadata unavailable)";
}

// ─── Playbooks ────────────────────────────────────────────────────────
//
// A "playbook" is a recurring tx pattern we recognise. When we see one,
// we know what's happening end-to-end (who, what, why, risk profile) —
// the report explains the playbook once and lists the occurrences
// compactly, instead of re-rendering near-identical per-leg tables.
//
// New patterns get added here as we observe them. Detectors run against
// the structured tx classification from classifyTx() plus the cached
// envelope + contract metadata. First-match-wins, so most-specific
// playbooks come first in the array.
const PLAYBOOKS = [
  {
    id: "owner-arb",
    name: "Owner-deployed arbitrage cycle",
    matches: (cls, ctx) =>
      ctx.txSource &&
      cls.passThroughs.some((pt) => {
        const info = ctx.contractCache?.[pt.addr];
        return info?.creator === ctx.txSource;
      }),
    explain: () => [
      "**What's happening:** The tx initiator wrote and deployed their own Soroban contract that acts as a pass-through router. HITZ enters from one of your pools, exits to another, and the contract's HITZ balance ends at zero — but the round-trip captures a price discrepancy in a *different* asset (XLM, USDC, …) that we can't see from HITZ events alone. Capital-funded, not flash-loaned, unless the contract also holds positions in a lending protocol.",
      "",
      "**Why this matters:** Personal arb contracts are a strong signal that HITZ pool spreads are wide enough to justify writing and iterating on bespoke routing code. Each cycle tightens prices across HITZ-paired pools as a side effect. Pool LPs earn the swap fee on every pass-through.",
      "",
      "**Risk:** None. The contract is the arber's own infrastructure, not registered as a HITZ router or pool, so it can't bypass vault rules. When HITZ momentarily exceeds L during the cycle, lazy evaluation flips the vault state on and off within the same tx (zero user-visible delay).",
    ],
  },
  {
    id: "flashloan-arb",
    name: "Flash-loan arbitrage cycle (suspected)",
    // We can't see XLM/USDC sides from HITZ events, but the
    // signature pattern is: tx initiator deployed an entry-point
    // contract that calls a sub-contract many times (the flash-loan
    // receiver / callback). When the pass-through is owner-deployed
    // AND the txInfo shows a deep contract call chain, we tentatively
    // label as flash-loan. Refine as we observe more.
    matches: (cls, ctx) => {
      if (!ctx.txSource) return false;
      return cls.passThroughs.some((pt) => {
        const info = ctx.contractCache?.[pt.addr];
        // Strong heuristic: same owner deployed multiple contracts
        // very close together. We can't verify that here without
        // extra lookups, so leave this playbook for manual flagging
        // via KNOWN_CONTRACTS until we add the heuristic.
        return false;
      });
    },
    explain: () => [
      "**What's happening:** The tx initiator deployed two contracts — an outer entry point + a flash-loan receiver — and uses a lending protocol (Blend, etc.) to borrow capital atomically. The receiver runs a multi-hop swap that passes through HITZ pools, repays the flash loan + fee, and pockets the difference. Zero capital posted; the whole cycle reverts if not profitable.",
      "",
      "**Why this matters:** Flash-loan arb is the most capital-efficient form of price-correction. Its presence proves HITZ pool prices regularly diverge enough to clear borrow fees + gas. As more arbers integrate, per-cycle profit compresses but pool fee revenue persists.",
      "",
      "**Detection note:** Currently flagged only when manually added to `KNOWN_CONTRACTS`. Auto-detection requires cross-asset visibility (i.e. seeing XLM/USDC transfers in the same tx), which our event store doesn't cover yet.",
    ],
  },
  {
    id: "sponsor-claim",
    name: "Sponsor → user payment (legacy reparation / claim)",
    matches: (cls, _ctx) => cls.distributors.some((d) => d.addr === SPONSOR),
    explain: () => [
      "**What's happening:** The HITZ gateway processed a legacy-reparation claim. An email user clicked their magic link, which hit `/api/auth/verify`, which redeemed the pending reparation record by transferring HITZ from the sponsor to the user's derived account.",
      "",
      "**Why this matters:** Tracks ongoing realization of the v6 campaign pool against the ~46k HITZ funded. Cumulative claimed = cumulative distributed.",
    ],
  },
  {
    id: "admin-direct",
    name: "Admin direct transfer",
    matches: (cls, _ctx) => cls.distributors.some((d) => d.addr === ADMIN),
    explain: () => [
      "**What's happening:** Admin key signed a direct HITZ transfer. Usually a manual operation — one-off distribution, fix-up, or pool bootstrap.",
    ],
  },
  {
    id: "aggregator-third-party",
    name: "Routed swap via registered aggregator (third-party fee-bumped)",
    matches: (cls, ctx) => {
      const hasRegisteredPassthrough = cls.passThroughs.some(
        (pt) => KNOWN_CONTRACTS[pt.addr]?.kind === "router"
      );
      const isThirdPartyBump =
        ctx.txInfo?.isFeeBump && ctx.txInfo?.feeAccount !== SPONSOR;
      return hasRegisteredPassthrough && isThirdPartyBump;
    },
    explain: () => [
      "**What's happening:** An end-user paid a custodial wallet / fee-relay service to submit their tx via a FeeBumpTransaction. The swap routed through one of HITZ's registered aggregator routers, which selected HITZ-paired pools as the optimal hop in a broader multi-asset trade.",
      "",
      "**Why this matters:** Healthy retail/bot traffic flowing through HITZ pools as part of normal Stellar DEX activity. Multiple distinct end-users bumped by the same fee account indicates a centralized service routing volume through us.",
      "",
      "**Watch:** Volume concentration on a single fee bumper means trading activity is partially gated on that service's continued operation. Worth knowing which service it is and its policies.",
    ],
  },
  {
    id: "aggregator-direct",
    name: "Routed swap via registered aggregator (direct wallet)",
    matches: (cls, ctx) => {
      const hasRegisteredPassthrough = cls.passThroughs.some(
        (pt) => KNOWN_CONTRACTS[pt.addr]?.kind === "router"
      );
      return hasRegisteredPassthrough && !ctx.txInfo?.isFeeBump;
    },
    explain: () => [
      "**What's happening:** A user signed and submitted directly (Freighter, hardware wallet, etc.) without a fee bumper. Their swap went through one of HITZ's registered aggregator routers and used HITZ pools as part of the path.",
      "",
      "**Why this matters:** Direct wallet users represent the most self-custody-conscious cohort. Their continued activity is a strong signal that HITZ trading is convenient enough for sophisticated users to integrate manually.",
    ],
  },
  {
    id: "direct-swap",
    name: "Direct user ↔ pool trade",
    matches: (cls, _ctx) =>
      cls.passThroughs.length === 0 &&
      cls.distributors.length === 1 &&
      cls.acquirers.length === 1 &&
      (isContractAddr(cls.distributors[0].addr) ||
        isContractAddr(cls.acquirers[0].addr)),
    explain: () => [
      "**What's happening:** Single-hop user-to-pool (or pool-to-user) HITZ transfer. Either a buy (pool → user) or a sell (user → pool) without intermediate routing.",
      "",
      "**Why this matters:** The most fundamental form of HITZ trading. Volume here tracks organic retail demand vs the routed-aggregator volume that may pass through HITZ incidentally.",
    ],
  },
];

const UNMATCHED_PLAYBOOK = {
  id: "unmatched",
  name: "Other / unique patterns",
  explain: () => [
    "Transactions that didn't fit any recognised playbook. Worth a manual look — they may indicate a new arber, a new aggregator integration, or just an unusual one-off.",
  ],
};

// Compact one-word mode label for the per-tx roll-up tables. Distinguishes:
//   - gateway: our sponsor fee-bumped this tx → email user
//   - 3p-bump: third-party fee bumper (custodial wallet, paid relay)
//   - direct:  classic wallet, signs + pays themselves
//   - n/a:     no envelope info available
function initiatorMode(a) {
  const i = a.txInfo;
  if (!i || i.error) return "n/a";
  const isOurs = i.sourceAccount === SPONSOR || i.feeAccount === SPONSOR;
  if (isOurs) return "gateway (email user)";
  if (i.isFeeBump) return `3p-bump \`${shortAddr(i.feeAccount)}\``;
  return "direct wallet";
}

// One-line attribution string used as the lead-in for the "Most recent
// example" block under each playbook. Embeds the source address, the
// envelope mode, and the total HITZ moved.
function initiatorLine(a) {
  const parts = [];
  if (a.txSource === SPONSOR)
    parts.push(`**Initiated by sponsor** \`${shortAddr(a.txSource)}\``);
  else if (a.txSource === ADMIN)
    parts.push(`**Initiated by admin** \`${shortAddr(a.txSource)}\``);
  else if (a.txSource)
    parts.push(`**Initiated by** \`${shortAddr(a.txSource)}\``);
  else parts.push("Initiator unknown");
  parts.push(`mode: ${initiatorMode(a)}`);
  parts.push(`**HITZ moved:** ${fmtHitz(a.cls.totalMoved)}`);
  return parts.join(" · ");
}

// Classify a tx by the per-address net HITZ flow it produced. Returns
// a short structural verdict + a longer narrative line.
function classifyTx(txHash, txTransfers, ctx) {
  // Net flow per address: +received, -sent. Used to detect pass-through
  // (net 0 with non-zero gross) vs accumulators (net positive).
  const grossIn = new Map();
  const grossOut = new Map();
  for (const t of txTransfers) {
    const [from, to] = t.topics;
    const amt = BigInt(t.data ?? "0");
    grossOut.set(from, (grossOut.get(from) ?? 0n) + amt);
    grossIn.set(to, (grossIn.get(to) ?? 0n) + amt);
  }
  const addrs = new Set([...grossIn.keys(), ...grossOut.keys()]);
  const totalMoved = txTransfers.reduce(
    (s, t) => s + BigInt(t.data ?? "0"),
    0n
  );

  // Pass-through addresses: in == out, non-zero. Order by amount desc
  // — the biggest pass-through is the most-likely arber.
  const passThroughs = [];
  for (const a of addrs) {
    const i = grossIn.get(a) ?? 0n;
    const o = grossOut.get(a) ?? 0n;
    if (i > 0n && o > 0n && i === o) passThroughs.push({ addr: a, amount: i });
  }
  passThroughs.sort((a, b) => (b.amount > a.amount ? 1 : -1));

  // Net acquirers and distributors (after pass-throughs filtered out)
  const acquirers = [];
  const distributors = [];
  for (const a of addrs) {
    const i = grossIn.get(a) ?? 0n;
    const o = grossOut.get(a) ?? 0n;
    if (i > 0n && o === 0n) acquirers.push({ addr: a, amount: i });
    if (o > 0n && i === 0n) distributors.push({ addr: a, amount: o });
  }

  // Did any pass-through use a contract whose creator is the same
  // address that initiated the tx? That's the owner-deployed-arb-bot
  // signature: the user spun up a private contract specifically to
  // capture arbitrage through HITZ liquidity.
  const ownerArb =
    ctx?.txSource &&
    passThroughs.some((pt) => {
      const info = ctx?.contractCache?.[pt.addr];
      return info?.creator === ctx.txSource;
    });

  // Verdict: pick the most-explanatory description.
  let verdict;
  if (ownerArb) {
    verdict =
      "**arbitrage cycle via owner-deployed contract** (the tx initiator's own pass-through routing logic)";
  } else if (passThroughs.length > 0 && acquirers.length === 0) {
    verdict = "arbitrage / pass-through routing";
  } else if (
    distributors.length === 1 &&
    acquirers.length === 1 &&
    passThroughs.length === 0
  ) {
    const d = distributors[0].addr;
    if (d === SPONSOR) verdict = "sponsor → user payment (legacy reparation or claim)";
    else if (d === ADMIN) verdict = "admin direct transfer";
    else if (isContractAddr(d)) verdict = "pool/router → user (swap output)";
    else verdict = "user-to-user transfer";
  } else if (passThroughs.length > 0 && acquirers.length > 0) {
    verdict = "multi-hop swap with intermediate routing";
  } else if (txTransfers.length === 1) {
    const t = txTransfers[0];
    if (t.topics[0] === SPONSOR) verdict = "sponsor direct transfer";
    else if (t.topics[0] === ADMIN) verdict = "admin direct transfer";
    else verdict = "single transfer";
  } else {
    verdict = `${txTransfers.length}-leg transfer chain`;
  }

  return { totalMoved, passThroughs, acquirers, distributors, verdict };
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
      // Subinvocation count — high values suggest the contract is
      // called by *other* contracts (i.e. it's infrastructure /
      // callback target) rather than only by its owner directly.
      subinvocationAtLookup: body.subinvocation ?? null,
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

// ─── Horizon tx envelope cache ────────────────────────────────────────
//
// We use this to attribute each tx to a real initiator. Soroban event
// records expose txHash but not the envelope's source account, and we
// care about the difference between:
//   - tx source = sponsor → fee-bumped gateway call from an email user
//   - tx source = anyone else → direct wallet user or a contract owner
// Cached because tx envelopes are immutable once on-chain.

function readTxCache() {
  if (!existsSync(txInfoFile)) return {};
  try {
    return JSON.parse(readFileSync(txInfoFile, "utf8"));
  } catch {
    return {};
  }
}

function writeTxCache(cache) {
  writeFileSync(txInfoFile, JSON.stringify(cache, null, 2) + "\n");
}

async function fetchTxInfo(hash, cache) {
  if (cache[hash]) return cache[hash];
  const url = `${HORIZON_URL}/transactions/${hash}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    cache[hash] = {
      sourceAccount: body.source_account ?? null,
      feeAccount: body.fee_account ?? body.source_account ?? null,
      successful: body.successful ?? null,
      operationCount: body.operation_count ?? null,
      // For fee-bumped txs, Horizon nests the inner tx under
      // `inner_transaction`. The inner source is the real signer of
      // the contract call; the outer source is whoever paid (sponsor).
      innerSource: body.inner_transaction?.source_account ?? null,
      isFeeBump: !!body.inner_transaction,
    };
    return cache[hash];
  } catch (err) {
    console.warn(
      `[contract-report] could not fetch tx ${hash}: ${err instanceof Error ? err.message : err}`
    );
    cache[hash] = { error: true };
    return cache[hash];
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

  // ─── Build enrichment context (sets + caches) ─────────────────────
  // Used by the vault, governance, and notable-transactions sections to
  // produce the same address labels everywhere. Derived ONCE up here so
  // we do the API work in a single concurrent burst.

  // Currently-registered HITZ pools / routers as of the window's end.
  // Walk the entire event store (not just the window) because pools
  // registered before this month are still pools today.
  const hitzPools = new Set();
  const hitzRouters = new Set();
  for (const e of allEvents) {
    if (e.ts >= endISO) continue;
    if (e.name === "pool_registered") {
      if (e.data === true) hitzPools.add(e.topics[0]);
      else hitzPools.delete(e.topics[0]);
    } else if (e.name === "router_registered") {
      if (e.data === true) hitzRouters.add(e.topics[0]);
      else hitzRouters.delete(e.topics[0]);
    }
  }

  // Every C-address that shows up in any transfer / vault event in the
  // window. We prefetch metadata for all of them once.
  const allContractAddrs = new Set();
  for (const e of transfers) {
    if (isContractAddr(e.topics[0])) allContractAddrs.add(e.topics[0]);
    if (isContractAddr(e.topics[1])) allContractAddrs.add(e.topics[1]);
  }
  for (const e of vaults) {
    if (isContractAddr(e.topics[0])) allContractAddrs.add(e.topics[0]);
  }

  const contractCache = readContractCache();
  await Promise.all(
    [...allContractAddrs].map((id) => fetchContractInfo(id, contractCache))
  );
  writeContractCache(contractCache);

  // Group transfers by tx hash — needed for both notable-tx rendering
  // and vault tx flow context. Build the per-tx structure once.
  const txsByHash = new Map();
  for (const e of transfers) {
    const arr = txsByHash.get(e.txHash) ?? [];
    arr.push(e);
    txsByHash.set(e.txHash, arr);
  }
  for (const arr of txsByHash.values()) {
    arr.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // Prefetch tx envelope info for: vault-touching txs, sponsor/admin
  // txs, and the top-N by HITZ volume. These are the txs we'll narrate.
  const NOTABLE_TX_LIMIT = 15;
  const volumeByTx = new Map();
  for (const [hash, ts] of txsByHash) {
    const total = ts.reduce((s, t) => s + BigInt(t.data ?? "0"), 0n);
    volumeByTx.set(hash, total);
  }
  const topVolumeTxs = [...volumeByTx.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, NOTABLE_TX_LIMIT)
    .map(([h]) => h);

  const vaultTxs = [...new Set(vaults.map((e) => e.txHash))];
  const sponsorAdminTxs = transfers
    .filter((e) => e.topics[0] === SPONSOR || e.topics[0] === ADMIN)
    .map((e) => e.txHash);

  const notableTxs = [
    ...new Set([...vaultTxs, ...sponsorAdminTxs, ...topVolumeTxs]),
  ];

  const txCache = readTxCache();
  await Promise.all(notableTxs.map((h) => fetchTxInfo(h, txCache)));
  writeTxCache(txCache);

  // The describeAddress helper takes this ctx and produces consistent
  // labels everywhere. txSource is per-call (set when rendering a
  // specific tx so personal-contract detection works).
  const ctxBase = { contractCache, hitzPools, hitzRouters };

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

    // Group vault events by tx and pair trap↔release within the same
    // transaction. This is the line between healthy lazy-eval pass-
    // throughs (transient) and stuck accounts (persistent).
    const vaultByTx = new Map(); // txHash → [events]
    for (const e of vaults) {
      const arr = vaultByTx.get(e.txHash) ?? [];
      arr.push(e);
      vaultByTx.set(e.txHash, arr);
    }

    const rows = [];
    for (const [txHash, evs] of vaultByTx) {
      evs.sort((a, b) => (a.id < b.id ? -1 : 1));
      const byAddr = new Map();
      for (const e of evs) {
        const a = e.topics[0];
        const arr = byAddr.get(a) ?? [];
        arr.push(e);
        byAddr.set(a, arr);
      }

      // Per-address HITZ flow in this tx, for context.
      const txTransfers = txsByHash.get(txHash) ?? [];
      const inflowByAddr = new Map();
      const outflowByAddr = new Map();
      for (const t of txTransfers) {
        const [from, to] = t.topics;
        const amt = BigInt(t.data ?? "0");
        outflowByAddr.set(from, (outflowByAddr.get(from) ?? 0n) + amt);
        inflowByAddr.set(to, (inflowByAddr.get(to) ?? 0n) + amt);
      }

      const txInfo = txCache[txHash] ?? {};
      const txSource = txInfo.innerSource ?? txInfo.sourceAccount ?? null;

      for (const [addr, addrEvents] of byAddr) {
        const trappedHere = addrEvents.some((e) => e.data === true);
        const releasedHere = addrEvents.some((e) => e.data === false);
        const transient = trappedHere && releasedHere;

        rows.push({
          txHash,
          ts: addrEvents[0].ts,
          addr,
          label: describeAddress(addr, { ...ctxBase, txSource }),
          transient,
          trappedHere,
          releasedHere,
          inflow: inflowByAddr.get(addr) ?? 0n,
          outflow: outflowByAddr.get(addr) ?? 0n,
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

  // ─── Notable transactions ──────────────────────────────────────────
  //
  // The set is: every vault-touching tx, every sponsor/admin direct
  // transfer, and the top-N txs by HITZ volume in the window. Each
  // gets a structural narrative built from on-chain events alone:
  // who initiated, what addresses moved how much HITZ, what pattern
  // it fits (pass-through, sponsor payment, etc.).
  if (notableTxs.length > 0) {
    push("## Notable transactions");
    push("");
    push(
      "Every HITZ-touching tx worth reading — vault transitions, sponsor/admin direct sends, and the top " +
        `${NOTABLE_TX_LIMIT} by HITZ volume. Grouped by **playbook**: a recurring tx pattern we recognise ` +
        "end-to-end. We explain each playbook once, show one detailed example, then list the other occurrences " +
        "compactly. Unrecognised patterns land in *Other / unique patterns* and deserve a manual look."
    );
    push("");

    // Build one analysis per tx, including playbook assignment.
    const txAnalyses = notableTxs
      .map((hash) => {
        const txTransfers = txsByHash.get(hash) ?? [];
        if (txTransfers.length === 0) return null;
        const txInfo = txCache[hash] ?? {};
        const txSource = txInfo.innerSource ?? txInfo.sourceAccount ?? null;
        const ctx = { ...ctxBase, txSource, txInfo };
        const cls = classifyTx(hash, txTransfers, ctx);
        const playbook =
          PLAYBOOKS.find((p) => p.matches(cls, ctx)) ?? UNMATCHED_PLAYBOOK;
        return { hash, ts: txTransfers[0].ts, txTransfers, txInfo, txSource, cls, ctx, playbook };
      })
      .filter(Boolean);

    // Group by playbook, preserving PLAYBOOKS array order so the most
    // important categories appear first in the report.
    const byPlaybook = new Map();
    for (const a of txAnalyses) {
      const list = byPlaybook.get(a.playbook.id) ?? {
        playbook: a.playbook,
        items: [],
      };
      list.items.push(a);
      byPlaybook.set(a.playbook.id, list);
    }
    const orderedGroups = [
      ...PLAYBOOKS,
      UNMATCHED_PLAYBOOK,
    ]
      .map((p) => byPlaybook.get(p.id))
      .filter(Boolean);

    for (const { playbook, items } of orderedGroups) {
      // Total HITZ moved across this playbook's txs, for the header.
      const totalVol = items.reduce(
        (s, a) => s + (a.cls?.totalMoved ?? 0n),
        0n
      );
      push(
        `### ${playbook.name} — ${items.length} tx${items.length === 1 ? "" : "s"}, ${fmtHitz(totalVol)} HITZ total`
      );
      push("");
      for (const line of playbook.explain()) push(line);
      push("");

      // Most recent occurrence gets the full per-leg detail. The rest
      // appear in a compact roll-up table below.
      items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const example = items[0];

      push("**Most recent example:**");
      push("");
      push(
        `[\`${example.hash.slice(0, 12)}…\`](https://stellar.expert/explorer/public/tx/${example.hash}) at ${example.ts.slice(0, 19).replace("T", " ")} UTC`
      );
      push("");
      push(initiatorLine(example));
      push("");
      push("| # | From | To | Amount |");
      push("|---|---|---|---|");
      for (let i = 0; i < example.txTransfers.length; i++) {
        const t = example.txTransfers[i];
        const fromLabel = describeAddress(t.topics[0], example.ctx);
        const toLabel = describeAddress(t.topics[1], example.ctx);
        push(
          `| ${i + 1} | \`${shortAddr(t.topics[0])}\` (${fromLabel}) | \`${shortAddr(t.topics[1])}\` (${toLabel}) | ${fmtHitz(t.data)} |`
        );
      }
      push("");

      // Same-tx vault warning if applicable.
      if (example.cls.passThroughs.length > 0) {
        const ptVaulted = vaults
          .filter((v) => v.txHash === example.hash)
          .map((v) => v.topics[0]);
        for (const pt of example.cls.passThroughs) {
          if (ptVaulted.includes(pt.addr)) {
            push(
              `⚠ \`${shortAddr(pt.addr)}\` crossed L mid-tx → vault-flipped → released in the same tx (lazy evaluation).`
            );
            push("");
          }
        }
      }

      // Compact roll-up of the remaining occurrences.
      const rest = items.slice(1);
      if (rest.length > 0) {
        push(
          `**Other occurrences (${rest.length}):**`
        );
        push("");
        push("| When | Tx | HITZ moved | Initiator | Mode |");
        push("|---|---|---|---|---|");
        for (const a of rest) {
          push(
            `| ${a.ts.slice(0, 19).replace("T", " ")} | [\`${a.hash.slice(0, 8)}…\`](https://stellar.expert/explorer/public/tx/${a.hash}) | ${fmtHitz(a.cls.totalMoved)} | \`${shortAddr(a.txSource)}\` | ${initiatorMode(a)} |`
          );
        }
        push("");
      }
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
