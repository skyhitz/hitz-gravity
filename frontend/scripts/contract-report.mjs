// HITZ contract activity report generator.
//
// Reads the on-chain data store and writes a markdown report for one month
// to reports/YYYY-MM.md.
//
// The store lives in Cloudflare D1 (`hitz-data`). The Worker's ingestion
// cron (functions/_lib/ingest.ts) pulls new contract events from Soroban
// RPC every 5 minutes and enriches them (Horizon tx envelopes, Stellar
// Expert contract metadata); this script reads it all back through the
// Worker's public read API (functions/api/data.ts):
//
//   - the HITZ token's events: every transfer, vault flag and registry change
//   - the Sovereign Vault's reserve points (every seed, deposit and swap hop,
//     including swaps between two assets, which move no HITZ)
//   - the arbitrage bot's live log
//
// The vault and bot sections need routes added in November 2026; against a
// deployment without them, those sections are left out with a note.
//
// Usage:
//   node scripts/contract-report.mjs generate            # current month
//   node scripts/contract-report.mjs generate 2026-05    # explicit month
//
// Env overrides:
//   REPORTS_API_BASE   default https://skyhitz.io (use http://localhost:8787
//                      against `wrangler dev`)
//   HITZ_CONTRACT_ID   default CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU
//   REPORTS_OUT_DIR    default reports/ at the repo root
//
// House style: no em dashes or en dashes in the report's text.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  feesUsd,
  fmtUnits,
  matchBotSwaps,
  poolEvents,
  priceAt,
  summarizeBot,
  summarizeVault,
  vaultLegIndex,
} from "./report-vault.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const reportsDir = process.env.REPORTS_OUT_DIR ?? join(repoRoot, "reports");
const API_BASE = (process.env.REPORTS_API_BASE ?? "https://skyhitz.io").replace(/\/$/, "");
const CONTRACT_ID =
  process.env.HITZ_CONTRACT_ID ??
  "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const STELLAR_EXPERT_API =
  process.env.STELLAR_EXPERT_API ??
  "https://api.stellar.expert/explorer/public";
const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon.stellar.org";

// HITZ's own exchange since 2026-11-04: one pool per trusted asset (XLM,
// USDC), registered as a HITZ pool.
const VAULT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";
// The vault's assets if /api/v1/vault can't be read: [asset contract, label].
const DEFAULT_VAULT_ASSETS = [
  { contract: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", asset: "XLM" },
  { contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", asset: "USDC" },
];

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
  // store starts, so the runtime hitzRouters set won't include them).
  // Hard-coded so reports display the right role from day one. All were
  // removed from the registry by 2026-11-08.
  CCPGFQUTSEHDIQODRE3GJDNE64A35HZ32L7LPDN7GXOCIYNBJSMS6V6B: {
    label: "registered HITZ router (primary)",
    kind: "router",
  },
  CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK: {
    label: "Aquarius router (registered until 2026-11-08)",
    kind: "router",
  },
  CA7RQDMMV6E53P5EDZA5GPWBZ33AMW2ZNO42XLI2RGRIAP4QXIARUOJQ: {
    label: "Aquarius router (registered until 2026-11-08)",
    kind: "router",
  },
  CB4YHF4ESRJ4XZRXISLXSUZTYY6YPBPZ73MZWSTUWY46DKYW7IGLHGF7: {
    label: "registered HITZ router (until 2026-11-08)",
    kind: "router",
  },
  CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH: {
    label: "registered HITZ router (until 2026-11-08)",
    kind: "router",
  },
  [VAULT]: {
    label: "HITZ Sovereign Vault",
    kind: "pool",
  },
  // Aquarius AMM pools paired with HITZ until 2026-11-03, when they were
  // removed from the registry and their liquidity withdrawn. Kept so
  // earlier months still read right.
  CCCDPF74BFBIHCBWCA3QX5R2UULH4VSJFOK6KL44KDKJS75ZKJJYUSPH: {
    label: "Aquarius HITZ/XLM pool (retired 2026-11-03)",
    kind: "pool",
    era: "aquarius",
  },
  CBMOEJUOKI72AXRPEQCRYSWDUBMI2LZEYVFJUTB256FO3WYSYSZI5F5A: {
    label: "Aquarius HITZ/USDC pool (retired 2026-11-03)",
    kind: "pool",
    era: "aquarius",
  },

  // ─── Arb infrastructure identified through manual investigation ────
  //
  // IMPORTANT: from HITZ `transfer` events alone we CANNOT see the
  // cross-asset side of a trade (the XLM/USDC legs, a Blend borrow,
  // etc.). So "flash-loan vs capital-funded arb" is not auto-detectable
  // from our event store: it requires knowing the contract. These
  // entries carry that hard-won knowledge forward so the report labels
  // the pattern correctly. Add a contract here once you've confirmed
  // its role (Stellar Expert creator + subinvocation count + reading
  // the actual invocation tree of one of its txs).
  CBNVK5PE7JCL773P5SHWE3YUCHQVVVPVOG72SKCEFVTZOLLQWVTCPLZ3: {
    label: "Blend flash-loan receiver (GDJMOSUF arb)",
    kind: "flashloan",
    note:
      "Receives flash-loaned capital from a Blend pool during the loan " +
      "callback, runs the swap chain through HITZ pools, repays the loan " +
      "+ fee, keeps the spread. Confirmed 2026-05-15 (tx c74e0f7e).",
  },
  CA4I5TPQAEF6C62B4UI7IDNDAPT5RUNSYGB6WSYNIQXHLG4JOFX2NSMH: {
    label: "Flash-loan arb entry point (GDJMOSUF)",
    kind: "flashloan",
    note:
      "Outer contract: owner calls its a() function to kick off a Blend " +
      "flash-loan arbitrage cycle. Pairs with the receiver above.",
  },
  CDWMA5P5CYR7JNUGTQVETOCSJZWSGNLEILF7JMBF3QIV5BKKVGDKKI4G: {
    label: "GDXGYASW personal arb contract",
    kind: "arb",
    note:
      "Owner-deployed routing contract. Pass-through arb cycles through " +
      "HITZ pools. Funding source (own capital vs borrowed) not visible " +
      "from HITZ events; see Stellar Expert for the full invocation tree.",
  },
};

// Accounts with a role. Hard-coded so reports don't need a query to label
// them. Update if any rotate.
const SPONSOR = "GBER7ROBYH5NFFKXCDGTSMUKTDQ4U3MEUTUCPJRZZY6EYZVEFDBVNJNB";
const ADMIN = "GCAETBNBFKVGLYFXKCLMKT6ZVHFXHRSDFSEW7ODIUJYC6R7H2QJ6OKGU";
// HITZ Terminal payments send their HITZ to the treasury: the token's admin
// account unless the Worker's TERMINAL_TREASURY names another registered pool
// (functions/_lib/terminal/chain.ts).
const TREASURY = ADMIN;
// Skyhitz's arbitrage bot (frontend/ARB_BOT.md, ARB_BOT_ADDRESS in
// wrangler.toml). Its trades swap XLM and USDC through the vault and never
// move HITZ.
const ARB_BOT = "GDZACFEQZNHDEH4K3RQQWQNXZ5RIT4SNNJZJG6BROYNWMU567HT6BASD";

// ─── data store (Worker read API over D1) ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET a read-API path. Network errors, 429s and 5xx are retried; any other
// HTTP error fails at once. With `optional`, a 404 (a route this deployment
// doesn't serve) returns null instead.
async function apiGet(path, { optional = false } = {}) {
  const url = `${API_BASE}${path}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      if (attempt >= 3) throw new Error(`[contract-report] ${url} failed: ${err instanceof Error ? err.message : err}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.ok) return await res.json();
    if (optional && res.status === 404) return null;
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`[contract-report] ${url} failed: HTTP ${res.status}`);
    }
    await sleep(2000 * (attempt + 1));
  }
}

// Every stored event, in id (= chronological) order: the same rows the
// old events.jsonl held.
async function readEvents() {
  const events = [];
  let after = "";
  for (;;) {
    const page = await apiGet(`/api/data/events?limit=1000&after=${encodeURIComponent(after)}`);
    events.push(...page.events);
    if (!page.next) return events;
    after = page.next;
  }
}

// The vault's pools, each with every event since its seed (report-vault.mjs
// poolEvents), or null when this deployment doesn't serve
// /api/data/pool-reserves.
async function readVault() {
  const live = await apiGet("/api/v1/vault", { optional: true }).catch(() => null);
  const vault = live?.vault ?? VAULT;
  const assets = live?.pools?.length
    ? live.pools.map((p) => ({ contract: p.contract, asset: p.asset }))
    : DEFAULT_VAULT_ASSETS;
  const pools = [];
  for (const { contract, asset } of assets) {
    const key = `${vault}:${contract}`;
    const points = [];
    let after = "";
    for (;;) {
      const page = await apiGet(
        `/api/data/pool-reserves?pool=${encodeURIComponent(key)}&limit=2000&after=${encodeURIComponent(after)}`,
        { optional: true }
      );
      if (page === null) return null;
      points.push(...page.points);
      if (!page.next) break;
      after = page.next;
    }
    pools.push({ key, asset, events: poolEvents(points) });
  }
  return pools;
}

// The arbitrage bot's live actions, oldest first, or null when this
// deployment doesn't serve /api/data/arb-runs.
async function readArbRuns() {
  const runs = [];
  let after = 0;
  for (;;) {
    const page = await apiGet(`/api/data/arb-runs?limit=1000&after=${after}`, { optional: true });
    if (page === null) return null;
    runs.push(...page.runs);
    if (!page.next) return runs;
    after = page.next;
  }
}

// HITZ/USD, hourly: [[unixSeconds, usd], …], or null.
async function readPriceHistory() {
  const body = await apiGet("/api/price/history", { optional: true }).catch(() => null);
  return Array.isArray(body?.points) ? body.points : null;
}

// ─── report generation ───────────────────────────────────────────────

function shortAddr(addr) {
  if (!addr || typeof addr !== "string") return String(addr ?? "");
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

// Render an address with a human label. For G-accounts: the accounts with a
// role, or "external account". For C-addresses: well-known protocol name (if
// in KNOWN_CONTRACTS), then registered pool/router (from HITZ's own
// registration events), then cached-creator info, then a generic label.
// The `txSource` argument lets us flag "this contract was deployed by
// the tx initiator", a strong signal of a personal arb bot.
function describeAddress(addr, ctx) {
  if (!addr) return "none";
  if (!isContractAddr(addr)) {
    if (addr === SPONSOR) return "**sponsor** (gateway)";
    if (addr === ADMIN) return "**admin** (treasury)";
    if (addr === ARB_BOT) return "**arbitrage bot**";
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
      // tool" territory: that's Stellar-network-wide DEX / lending /
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

// The one sender and one receiver of a plain transfer (no pass-through),
// or null.
function single(cls) {
  if (cls.passThroughs.length || cls.distributors.length !== 1 || cls.acquirers.length !== 1) return null;
  return { from: cls.distributors[0].addr, to: cls.acquirers[0].addr };
}

// One line on what the vault did in a transfer's transaction, from the
// vault's own events (see vaultLegIndex in report-vault.mjs).
function legText(leg) {
  if (!leg) return "";
  const asset = `${fmtUnits(leg.assetAmount, 7)} ${leg.asset}`;
  switch (leg.kind) {
    case "seed":
      return `seed of the ${leg.asset} pool, with ${asset}`;
    case "deposit":
      return `deposit into the ${leg.asset} pool, with ${asset}`;
    case "buy":
      return `paid ${asset}; fee ${fmtUnits(leg.fee, 7)} HITZ`;
    case "sell":
      return `received ${asset}; fee ${fmtUnits(leg.fee, 7)} ${leg.feeToken}`;
    default:
      return "";
  }
}

// ─── Playbooks ────────────────────────────────────────────────────────
//
// A "playbook" is a recurring tx pattern we recognise. When we see one,
// we know what's happening end to end (who, what, why, risk profile):
// the report explains the playbook once and lists the occurrences
// compactly, instead of re-rendering near-identical per-leg tables.
//
// New patterns get added here as we observe them. Detectors run against
// the structured tx classification from classifyTx() plus the cached
// envelope + contract metadata, and the vault's own record of the
// transaction (`ctx.vaultLeg`). First-match-wins, so most-specific
// playbooks come first in the array. `detail`, when present, adds one line
// per occurrence.
const PLAYBOOKS = [
  {
    // MUST stay ahead of owner-arb: a flash-loan tx also looks like an
    // owner-deployed pass-through, so the more-specific playbook wins.
    id: "flashloan-arb",
    name: "Flash-loan arbitrage cycle (Aquarius pools)",
    // Detection is registry-based: if any address in the tx is a known
    // flash-loan contract (KNOWN_CONTRACTS kind === "flashloan"), it's a
    // flash-loan cycle. We can't infer this from HITZ events alone (the
    // borrow leg is in XLM/USDC), so confirmed contracts are listed in
    // KNOWN_CONTRACTS. Add new ones there as you identify them.
    matches: (cls) =>
      (cls.addresses ?? []).some(
        (a) => KNOWN_CONTRACTS[a]?.kind === "flashloan"
      ),
    explain: () => [
      "**What's happening:** A flash-loan arbitrage through HITZ's Aquarius pools, where HITZ traded until they froze on Oct 2, 2026 (they were retired on Nov 3). The initiator's entry-point contract borrows capital from a lending protocol (Blend) inside one transaction, runs a multi-hop swap through the HITZ pools, repays the loan and its fee, and keeps the spread. If the cycle isn't profitable, the whole transaction reverts and only the network fee is lost.",
      "",
      "**How to read the flow table below:** HITZ enters the flash-loan receiver from one pool and leaves to another (net 0 on the receiver). The XLM or USDC borrow and repayment legs are not visible here, since HITZ events only show the HITZ hop. The flash-loan nature is known because the receiver contract is in the identified-contracts registry (see its note).",
      "",
      "**Why this matters:** The pools' prices drifted from the market often enough to pay for the loan and the network fees. The receiver briefly holds a large amount of HITZ mid-swap and is vaulted, then released in the same transaction by lazy evaluation. Each cycle paid Aquarius's 0.1% fee in each pool: half stayed in the pool, whose LP shares the treasury held, and half went to Aquarius.",
    ],
  },
  {
    id: "owner-arb",
    name: "Owner-deployed arbitrage cycle (Aquarius pools)",
    matches: (cls, ctx) =>
      ctx.txSource &&
      cls.passThroughs.some((pt) => {
        const info = ctx.contractCache?.[pt.addr];
        return info?.creator === ctx.txSource;
      }),
    explain: () => [
      "**What's happening:** The transaction's initiator deployed their own Soroban contract that acts as a pass-through router. HITZ enters from one of HITZ's Aquarius pools and exits to the other, and the contract's HITZ balance ends at zero: the round trip captures a price gap in another asset (XLM, USDC, …).",
      "",
      "**What we can and can't tell:** HITZ `transfer` events show only the HITZ hop. They **cannot** tell whether the cycle was funded by the owner's own capital or by a flash loan; that lives in the XLM and USDC legs, which aren't indexed. If you confirm a flash-loan source for one of these contracts, add it to `KNOWN_CONTRACTS` with `kind: \"flashloan\"` and it will reclassify automatically.",
      "",
      "**Why this matters:** Personal arbitrage contracts mean the pools' spreads were wide enough to justify bespoke routing code. Each cycle pulled the pools back toward the market and paid Aquarius's 0.1% fee in each pool, half of it kept by the pool.",
      "",
      "**Risk:** None. These contracts are the arbitrageurs' own, not registered HITZ routers or pools, so they can't bypass the vault rules. When HITZ briefly exceeds L mid-cycle, lazy evaluation vaults and releases the contract within the same transaction.",
    ],
  },
  {
    id: "sponsor-claim",
    name: "Sponsor to user payment (legacy reparation)",
    matches: (cls) => cls.distributors.some((d) => d.addr === SPONSOR),
    explain: () => [
      "**What's happening:** The email gateway redeemed a legacy-reparation claim: an email user clicked their magic link, and `/api/auth/verify` transferred the recorded HITZ from the sponsor to the user's account.",
      "",
      "**Why this matters:** Tracks how much of the v6 campaign's 46,149 HITZ has been claimed. Claimed equals distributed.",
    ],
  },
  {
    id: "aquarius-withdrawal",
    name: "Liquidity withdrawn from a retired Aquarius pool",
    matches: (cls) => {
      const t = single(cls);
      return !!t && KNOWN_CONTRACTS[t.from]?.era === "aquarius" && t.to === ADMIN;
    },
    explain: () => [
      "**What's happening:** The admin withdrew HITZ's liquidity from one of its Aquarius pools. Both pools froze on Oct 2, 2026, when Aquarius upgraded their code; on Nov 3 the admin removed them from the registry and withdrew everything, and the liquidity moved to the Sovereign Vault (`contracts/sovereign-vault/MIGRATION.md`, steps A and B).",
      "",
      "**Why this matters:** The pool's HITZ went to the admin account, a registered pool, which put it back in Total Mass. Removed from the registry, the old pool is an ordinary account above L, so the vault dynamics section lists it as vaulted.",
    ],
  },
  {
    id: "vault-liquidity",
    name: "Liquidity added to the Sovereign Vault",
    matches: (cls, ctx) => {
      const t = single(cls);
      if (!t || t.to !== VAULT) return false;
      if (ctx.vaultLeg) return ctx.vaultLeg.kind === "seed" || ctx.vaultLeg.kind === "deposit";
      return !ctx.vaultData && t.from === ADMIN;
    },
    explain: () => [
      "**What's happening:** HITZ and a pool's asset went into the Sovereign Vault together, at the pool's price: the admin's one-time seed of a pool, or a deposit, which anyone can make. A deposit earns no shares and can never be withdrawn, so this liquidity belongs to the protocol for good.",
      "",
      "**Why this matters:** Deeper pools mean smaller price moves, and so smaller fees, for everyone who trades. From the admin account (a registered pool) to the vault (another), the HITZ stays in Total Mass and L doesn't change.",
    ],
    detail: (a) => legText(a.ctx.vaultLeg),
  },
  {
    id: "terminal-payment",
    name: "HITZ Terminal payment",
    matches: (cls, ctx) => {
      const t = single(cls);
      return !!t && t.from === VAULT && t.to === TREASURY && !!ctx.txSource && ctx.txSource !== ADMIN;
    },
    explain: () => [
      "**What's happening:** A subscriber paid for a HITZ Terminal plan. The payment is one vault swap: the plan's price in USDC or XLM goes into the vault, and the HITZ it buys goes to the treasury, not to the subscriber.",
      "",
      "**Why this matters:** Each subscription buys HITZ through the vault, which keeps its fee on it. The treasury is a registered pool, so the HITZ stays in Total Mass.",
    ],
    detail: (a) => legText(a.ctx.vaultLeg),
  },
  {
    id: "vault-buy",
    name: "Purchase from the Sovereign Vault",
    matches: (cls) => {
      const t = single(cls);
      return !!t && t.from === VAULT;
    },
    explain: () => [
      "**What's happening:** Someone bought HITZ from the vault with XLM or USDC. The fee, 1% when the vault is calm and up to 10% while a trade leaves one asset dislocated against another, was withheld from the HITZ paid out and stayed in the pool.",
      "",
      "**Why this matters:** This is direct demand for HITZ. The token judges the buyer against the L the purchase leaves behind: a buyer whose balance ends above L is vaulted and can only sell back into the vault.",
    ],
    detail: (a) => legText(a.ctx.vaultLeg),
  },
  {
    id: "vault-sell",
    name: "Sale into the Sovereign Vault",
    matches: (cls, ctx) => {
      const t = single(cls);
      if (!t || t.to !== VAULT) return false;
      return ctx.vaultData ? ctx.vaultLeg?.kind === "sell" : true;
    },
    explain: () => [
      "**What's happening:** Someone sold HITZ to the vault for XLM or USDC, and the vault's fee stayed in the pool. Selling into the vault is always allowed, even for a vaulted account. When the vault's own events aren't available, this list also includes any sacrifice (HITZ sent to the vault outside a swap).",
      "",
      "**Why this matters:** The HITZ that enters the vault raises Total Mass and L. For a vaulted account, a large enough sale is the way out.",
    ],
    detail: (a) => legText(a.ctx.vaultLeg),
  },
  {
    id: "vault-sacrifice",
    name: "HITZ sent to the vault outside a swap (sacrifice)",
    matches: (cls, ctx) => {
      const t = single(cls);
      return !!t && t.to === VAULT && ctx.vaultData && !ctx.vaultLeg;
    },
    explain: () => [
      "**What's happening:** HITZ was transferred to the vault directly, not through a swap or a deposit: no pool's reserves changed with it. It counts in Total Mass, which can release a vaulted sender, but it never enters a pool and can't come back out.",
    ],
  },
  {
    id: "admin-direct",
    name: "Admin direct transfer",
    matches: (cls) => cls.distributors.some((d) => d.addr === ADMIN),
    explain: () => [
      "**What's happening:** The admin account signed a HITZ transfer itself: a distribution, a fix or a funding move. Seeds and deposits into the vault are listed as liquidity instead.",
    ],
  },
  {
    id: "account-transfer",
    name: "Transfer between accounts",
    matches: (cls) => {
      const t = single(cls);
      return !!t && !isContractAddr(t.from) && !isContractAddr(t.to);
    },
    explain: () => [
      "**What's happening:** A plain HITZ transfer from one account to another, such as a payment or a send to an email address. A sender has to be under L to send anywhere but a registered pool.",
    ],
  },
  {
    id: "aggregator-third-party",
    name: "Swap routed by a registered aggregator (third-party fee bump)",
    matches: (cls, ctx) => {
      const hasRegisteredPassthrough = cls.passThroughs.some(
        (pt) => KNOWN_CONTRACTS[pt.addr]?.kind === "router"
      );
      const isThirdPartyBump =
        ctx.txInfo?.isFeeBump && ctx.txInfo?.feeAccount !== SPONSOR;
      return hasRegisteredPassthrough && isThirdPartyBump;
    },
    explain: () => [
      "**What's happening:** An end user's wallet or relay service submitted their transaction as a FeeBumpTransaction. The swap went through one of HITZ's registered aggregator routers, which used HITZ's Aquarius pools as a hop in a larger trade. The routers left the registry on Nov 8, 2026, after HITZ moved to the Sovereign Vault.",
      "",
      "**Why this matters:** Retail and bot traffic reaching HITZ as part of ordinary Stellar DEX routing. Many end users bumped by the same fee account means one service routes volume through HITZ.",
      "",
      "**Watch:** Volume that depends on one fee bumper depends on that service staying up.",
    ],
  },
  {
    id: "aggregator-direct",
    name: "Swap routed by a registered aggregator (direct wallet)",
    matches: (cls, ctx) => {
      const hasRegisteredPassthrough = cls.passThroughs.some(
        (pt) => KNOWN_CONTRACTS[pt.addr]?.kind === "router"
      );
      return hasRegisteredPassthrough && !ctx.txInfo?.isFeeBump;
    },
    explain: () => [
      "**What's happening:** A user signed and submitted directly (Freighter, a hardware wallet, …), with no fee bumper. Their swap went through one of HITZ's registered aggregator routers and used HITZ's Aquarius pools as part of the path. The routers left the registry on Nov 8, 2026.",
      "",
      "**Why this matters:** Users who sign for themselves are the most self-custody-minded; their activity shows HITZ trading was convenient enough to integrate by hand.",
    ],
  },
  {
    id: "direct-swap",
    name: "Direct trade with a pool",
    matches: (cls) =>
      cls.passThroughs.length === 0 &&
      cls.distributors.length === 1 &&
      cls.acquirers.length === 1 &&
      (isContractAddr(cls.distributors[0].addr) ||
        isContractAddr(cls.acquirers[0].addr)),
    explain: () => [
      "**What's happening:** A single-hop HITZ transfer between an account and a pool contract, with no routing in between: a buy (pool to account) or a sell (account to pool). Trades with the Sovereign Vault are listed under their own headings; this covers other pools, such as the Aquarius pools before Nov 4, 2026.",
      "",
      "**Why this matters:** The most basic form of HITZ trading, and the clearest read on demand that isn't routing.",
    ],
  },
];

const UNMATCHED_PLAYBOOK = {
  id: "unmatched",
  name: "Other / unique patterns",
  explain: () => [
    "Transactions that didn't fit any recognised playbook. Worth a manual look: they may be a new arbitrageur, a new integration, or a one-off.",
  ],
};

// Compact one-word mode label for the per-tx roll-up tables. Distinguishes:
//   - gateway: our sponsor fee-bumped this tx (an email user)
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

  // Pass-through addresses: in == out, non-zero. Order by amount desc:
  // the biggest pass-through is the most-likely arber.
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
    if (d === SPONSOR) verdict = "sponsor to user payment (legacy reparation or claim)";
    else if (d === ADMIN) verdict = "admin direct transfer";
    else if (isContractAddr(d)) verdict = "pool/router to user (swap output)";
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

  return {
    totalMoved,
    passThroughs,
    acquirers,
    distributors,
    verdict,
    addresses: [...addrs],
  };
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
// quick prefix check is enough for our reporting: the on-chain types
// guarantee the convention.
function isContractAddr(addr) {
  return typeof addr === "string" && addr.startsWith("C") && addr.length === 56;
}

// Registration events carry `{ registered, wasm_hash }` since token v2.0.0
// and a bare boolean before it.
function registeredOf(data) {
  if (data !== null && typeof data === "object") return data.registered === true;
  return data === true;
}

// A Wasm hash as stored: hex, or a serialized Buffer ({type, data}).
function hexOf(v) {
  if (typeof v === "string") return v;
  if (v && Array.isArray(v.data)) return v.data.map((b) => b.toString(16).padStart(2, "0")).join("");
  return "";
}

// ─── Stellar Expert metadata cache ────────────────────────────────────
//
// Used to enrich vault events with creator info: we want to be able to
// tell a personal arb bot (creator == initiator) from public routing
// infra (creator == DAO/team) at a glance, without hand-investigation.
//
// All fetches are best-effort: API failures degrade to "unknown" rather
// than blocking the report. The cache lives in D1 (filled by the Worker
// cron as contracts first appear) so repeated runs are deterministic and
// don't hammer the API; a miss here is looked up live for this run only.

async function readContractCache() {
  return apiGet("/api/data/contract-info");
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
    // Keep only the fields we display: Stellar Expert returns more, but
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
      // Subinvocation count: high values suggest the contract is
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
//   - tx source = sponsor: a fee-bumped gateway call from an email user
//   - tx source = anyone else: a direct wallet user or a contract owner
// Cached (in D1, by the Worker cron) because tx envelopes are immutable
// once on-chain; a miss here is looked up live for this run only.

async function readTxCache() {
  const cache = {};
  let after = "";
  for (;;) {
    const page = await apiGet(`/api/data/tx-info?limit=2000&after=${encodeURIComponent(after)}`);
    Object.assign(cache, page.items);
    if (!page.next) return cache;
    after = page.next;
  }
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

const fmtDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const fmtUsdPrice = (p) => (p === null || p === undefined ? "n/a" : `$${p.toPrecision(3)}`);

// Strict YYYY-MM validation. Defense-in-depth: the GitHub workflow
// validates too, but anyone running locally could pass `../foo` which
// would otherwise let us write outside reports/.
const YYYYMM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function generateReport(yyyymm = currentYM()) {
  if (!YYYYMM_RE.test(yyyymm)) {
    throw new Error(`invalid month: ${yyyymm} (expected YYYY-MM)`);
  }
  const [startISO, endISO] = monthBounds(yyyymm);
  const startTs = Date.parse(startISO) / 1000;
  const endTs = Date.parse(endISO) / 1000;
  const [allEvents, vaultPools, arbRuns, priceHistory] = await Promise.all([
    readEvents(),
    readVault(),
    readArbRuns(),
    readPriceHistory(),
  ]);
  const events = allEvents.filter((e) => inWindow(e.ts, startISO, endISO));

  if (events.length === 0) {
    console.warn(
      `[contract-report] no events in window ${startISO}..${endISO} (store has ${allEvents.length} total)`
    );
  }
  if (!vaultPools) console.warn("[contract-report] /api/data/pool-reserves is not served here: no vault section");
  if (!arbRuns) console.warn("[contract-report] /api/data/arb-runs is not served here: no bot section");

  // The vault in this window: its pools, swaps and fees. Shown once it
  // exists (seeded by the window's end).
  const vault = vaultPools ? summarizeVault(vaultPools, startTs, endTs) : null;
  const vaultLive = !!vault && vault.pools.some((p) => p.end !== null);
  const bot = arbRuns ? summarizeBot(arbRuns, startISO, endISO) : null;
  const botLive = !!bot && !!bot.firstLive && bot.firstLive < endISO;

  // Bucketise by event name. The token emits (the `_event` suffix of the
  // Gravity events is dropped at ingestion):
  //   transfer, mint, burn, approve, vaulted, pool_registered,
  //   router_registered, admin_changed, initialized, upgrade_proposed,
  //   upgrade_cancelled, upgraded, admin_renounced, integrity_drift
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
  const lifecycle = ["upgrade_proposed", "upgrade_cancelled", "upgraded", "admin_renounced", "integrity_drift"].flatMap(
    (n) => byName.get(n) ?? []
  );

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
    const on = registeredOf(e.data);
    if (e.name === "pool_registered") {
      if (on) hitzPools.add(e.topics[0]);
      else hitzPools.delete(e.topics[0]);
    } else if (e.name === "router_registered") {
      if (on) hitzRouters.add(e.topics[0]);
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

  const contractCache = await readContractCache();
  await Promise.all(
    [...allContractAddrs].map((id) => fetchContractInfo(id, contractCache))
  );

  // Group transfers by tx hash: needed for both notable-tx rendering
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

  // The vault's own record of each transaction with one HITZ transfer to or
  // from it: a seed, a deposit, a purchase or a sale, matched by ledger time
  // and amount. Taken in time order, so a repeat of the same amount in the
  // same second matches its own event.
  const vaultLegs = new Map();
  if (vaultPools) {
    const legs = vaultLegIndex(vaultPools);
    const ordered = [...txsByHash.entries()].sort((a, b) => (a[1][0].id < b[1][0].id ? -1 : 1));
    for (const [hash, ts] of ordered) {
      if (ts.length !== 1) continue;
      const [from, to] = ts[0].topics;
      if (from !== VAULT && to !== VAULT) continue;
      const leg = legs.take(ts[0].ts, ts[0].data ?? "0");
      if (leg) vaultLegs.set(hash, leg);
    }
  }

  // EVERY HITZ-touching tx in the window gets narrated: no top-N
  // cutoff. A report you can't find a specific tx in is useless. The
  // playbook grouping keeps it readable: each pattern is explained once,
  // then every occurrence is listed compactly. With ~dozens of txs/month
  // this stays well within a scannable length.
  const notableTxs = [...txsByHash.keys()];

  const txCache = await readTxCache();
  await Promise.all(notableTxs.map((h) => fetchTxInfo(h, txCache)));

  // The describeAddress helper takes this ctx and produces consistent
  // labels everywhere. txSource is per-call (set when rendering a
  // specific tx so personal-contract detection works).
  const ctxBase = { contractCache, hitzPools, hitzRouters, vaultData: !!vaultPools };

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

  push(`# HITZ on-chain report: ${yyyymm}`);
  push("");
  push(
    `> Auto-generated by \`scripts/contract-report.mjs generate ${yyyymm}\`. ` +
      `Data window: \`${startISO}\` to \`${endISO}\`.`
  );
  const missing = [
    !vaultPools && "the Sovereign Vault's own events",
    !arbRuns && "the arbitrage bot's log",
  ].filter(Boolean);
  if (missing.length) {
    push(">");
    push(`> Not available from ${API_BASE} when this report was generated: ${missing.join(" and ")}. The sections built on them are left out.`);
  }
  push("");
  push("## Summary");
  push("");
  push("| Metric | Value |");
  push("|---|---|");
  push(`| HITZ events emitted | ${events.length.toLocaleString()} |`);
  push(`| Distinct addresses active | ${addrs.size} |`);
  push(`| Transfer events | ${transfers.length} |`);
  push(`| Transfer volume | ${fmtHitz(transferVolume)} HITZ |`);
  push(`| Mints | ${mints.length} |`);
  push(`| Burns | ${burns.length} |`);
  push(
    `| Vault transitions | ${trapped} vaulted / ${released} released |`
  );
  push(`| Pool register/remove events | ${poolRegs.length} |`);
  push(`| Router register/remove events | ${routerRegs.length} |`);
  push(`| Admin changes | ${adminChanges.length} |`);
  if (vaultLive) {
    const c = vault.counts;
    push(
      `| Sovereign Vault swaps | ${vault.swaps.length} (${c.buy} bought HITZ, ${c.sell} sold HITZ, ${c.cross} between two assets${c.multi ? `, ${c.multi} other` : ""}) |`
    );
  }
  if (botLive) push(`| Arbitrage bot round trips | ${bot.trades} |`);
  push("");

  // ─── Sovereign Vault ───────────────────────────────────────────────
  if (vaultLive) {
    push("## Sovereign Vault");
    push("");
    push(
      "HITZ's own exchange since Nov 4, 2026 (`" + shortAddr(VAULT) + "`): one constant-product pool per listed asset, " +
        "owned by the protocol, with no LP shares and no withdrawals. Every hop pays a fee of 1% when the vault is calm, rising " +
        "to 10% while a trade leaves one asset dislocated against another, and the fee stays in the pool it was charged in. " +
        "These figures come from the vault's own events, so they include swaps between two assets, which move no HITZ and " +
        "never appear among the HITZ transfers."
    );
    push("");
    push("| Pool | At the start | Seeded or deposited | At the end |");
    push("|---|---|---|---|");
    const reserves = (r, asset) =>
      r ? `${fmtUnits(r.hitz, 0)} HITZ + ${fmtUnits(r.quote, 2)} ${asset}` : "not seeded yet";
    for (const p of vault.pools) {
      const added = [...p.seeds, ...p.deposits].sort((a, b) => a.ts - b.ts);
      const addedText = added.length
        ? added
            .map((e) => `${e.kind} ${fmtDate(e.ts)}: ${fmtUnits(e.hitz, 0)} HITZ + ${fmtUnits(e.quote, 2)} ${p.asset}`)
            .join("; ")
        : "none";
      push(`| ${p.asset} | ${reserves(p.start, p.asset)} | ${addedText} | ${reserves(p.end, p.asset)} |`);
    }
    push("");
    push("| Pool | Swap hops | Into the pool | Out of the pool | Fees kept |");
    push("|---|---|---|---|---|");
    for (const p of vault.pools) {
      const both = (asset, hitz, assetAmount) =>
        [assetAmount > 0n && `${fmtUnits(assetAmount, 4)} ${asset}`, hitz > 0n && `${fmtUnits(hitz, 2)} HITZ`]
          .filter(Boolean)
          .join(" + ") || "0";
      push(
        `| ${p.asset} | ${p.hops} | ${both(p.asset, p.hitzIn, p.assetIn)} | ${both(p.asset, p.hitzOut, p.assetOut)} | ${both(p.asset, p.feeHitz, p.feeAsset)} |`
      );
    }
    push("");
    const c = vault.counts;
    const usd = feesUsd(vaultPools, startTs, endTs, priceHistory);
    const first = priceHistory ? priceAt(priceHistory, startTs) : null;
    const last = priceHistory ? priceAt(priceHistory, endTs - 1) : null;
    push(
      `${vault.swaps.length} swap${vault.swaps.length === 1 ? "" : "s"} in the window: ${c.buy} bought HITZ, ${c.sell} sold HITZ and ` +
        `${c.cross} swapped one asset for another through HITZ, which stays in the vault${c.multi ? `; ${c.multi} carried several swaps in one transaction` : ""}. ` +
        "A fee is kept in the token the hop paid out: HITZ when someone buys it, the asset when someone sells."
    );
    push("");
    if (usd !== null) {
      push(`Fees kept in the window, valued at each hour's HITZ price: about $${usd.toFixed(2)}.`);
      push("");
    }
    if (first !== null || last !== null) {
      push(`HITZ/USD (from the vault's prices): ${fmtUsdPrice(first)} at the start of the window, ${fmtUsdPrice(last)} at the end.`);
      push("");
    }
  }

  // ─── Arbitrage bot ─────────────────────────────────────────────────
  if (botLive) {
    push("## Arbitrage bot");
    push("");
    const since = bot.firstLive >= startISO ? `went live on ${bot.firstLive.slice(0, 10)}` : `has run live since ${bot.firstLive.slice(0, 10)}`;
    push(
      `Skyhitz's open-source bot (\`${shortAddr(ARB_BOT)}\`, \`frontend/ARB_BOT.md\`) ${since}. It keeps the vault's XLM/USDC rate ` +
        "in line with the Stellar DEX: when the vault pays more for one asset than the DEX does, it buys that asset on the DEX and " +
        "sells it into the vault. Its vault legs swap one asset for another through HITZ inside the vault, so they count among the " +
        "vault's swaps above and never appear among the HITZ transfers."
    );
    push("");
    push("| | |");
    push("|---|---|");
    push(`| Round trips completed | ${bot.trades} |`);
    push(`| Stopped after the DEX leg (the vault leg didn't run) | ${bot.incomplete} |`);
    push(`| Missed (the DEX leg didn't fill) | ${bot.missed} |`);
    push(`| Rebalances | ${bot.rebalances} |`);
    if (bot.setups) push(`| Setup steps | ${bot.setups} |`);
    push(`| Errors | ${bot.errors} |`);
    const sold = Object.entries(bot.sold)
      .map(([asset, s]) => `${fmtUnits(s.amount, 4)} ${asset} in ${s.trips} trip${s.trips === 1 ? "" : "s"}`)
      .join(", ");
    push(`| Sold into the vault | ${sold || "nothing"} |`);
    push(`| Profit after network fees | ${bot.profitXlm.toFixed(4)} XLM |`);
    if (bot.medianGapPct !== null) {
      push(
        `| The vault's rate off the DEX when it traded | ${bot.medianGapPct.toFixed(2)}% at the median, ${bot.maxGapPct.toFixed(2)}% at most |`
      );
    }
    push("");
    if (vaultLive && vault.counts.cross > 0) {
      const matched = matchBotSwaps(vault.swaps, arbRuns, startISO, endISO);
      push(
        `Of the vault's ${vault.counts.cross} swap${vault.counts.cross === 1 ? "" : "s"} between two assets in the window, ` +
          `${matched} match the bot's logged trades exactly (asset sold, amount and what the vault paid).`
      );
      push("");
    }
    if (bot.perDay.length) {
      push("| Day | Round trips | Profit (XLM) |");
      push("|---|---|---|");
      for (const [d, v] of bot.perDay) push(`| ${d} | ${v.trips} | ${v.profit.toFixed(4)} |`);
      push("");
    }
  }

  if (days.length > 0) {
    push("## Daily activity");
    push("");
    push("| Date | HITZ events |");
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
      push(`| \`${shortAddr(a)}\` | ${n} | ${describeAddress(a, ctxBase)} |`);
    }
    push("");
  }

  if (sponsorTransfers.length > 0) {
    push("## Sponsor activity (legacy reparation)");
    push("");
    push(
      `${sponsorTransfers.length} transfer(s) from the sponsor to users, ` +
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
    push("## Admin transfers");
    push("");
    push(
      `${adminTransfers.length} transfer(s) from the admin account, which is also the treasury. ` +
        "Seeds and deposits into the vault among them are listed under *Liquidity added to the Sovereign Vault* below."
    );
    push("");
  }

  if (poolRegs.length + routerRegs.length + adminChanges.length + lifecycle.length > 0) {
    push("## Governance events");
    push("");
    push("| When | Event | Address | Detail | Tx |");
    push("|---|---|---|---|---|");
    const gov = [...poolRegs, ...routerRegs, ...adminChanges, ...lifecycle].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const e of gov) {
      const when = e.ts.slice(0, 19).replace("T", " ");
      const tx = `[\`${e.txHash?.slice(0, 8)}…\`](https://stellar.expert/explorer/public/tx/${e.txHash})`;
      const who = (a) => `\`${shortAddr(a)}\` (${describeAddress(a, ctxBase)})`;
      const d = e.data && typeof e.data === "object" ? e.data : {};
      let event = e.name;
      let address = e.topics[0] ? who(e.topics[0]) : "";
      let detail = "";
      if (e.name === "pool_registered" || e.name === "router_registered") {
        const kind = e.name === "pool_registered" ? "pool" : "router";
        event = registeredOf(e.data) ? `${kind} registered` : `${kind} removed`;
        const hash = hexOf(d.wasm_hash);
        if (hash) {
          detail = /^0+$/.test(hash)
            ? "classic account (no code to bind)"
            : `${registeredOf(e.data) ? "bound to" : "was bound to"} Wasm \`${hash.slice(0, 8)}…\``;
        }
      } else if (e.name === "admin_changed") {
        event = "admin changed";
        address = `${who(e.topics[0])} to ${who(e.topics[1])}`;
      } else if (e.name === "upgrade_proposed") {
        event = "token upgrade proposed";
        address = "";
        detail = `Wasm \`${hexOf(d.wasm_hash).slice(0, 8)}…\`, installable from ${d.eta ? new Date(Number(d.eta) * 1000).toISOString().slice(0, 16).replace("T", " ") : "n/a"}`;
      } else if (e.name === "upgrade_cancelled" || e.name === "upgraded") {
        event = e.name === "upgraded" ? "token upgraded" : "token upgrade cancelled";
        address = "";
        detail = `Wasm \`${hexOf(d.wasm_hash).slice(0, 8)}…\``;
      } else if (e.name === "admin_renounced") {
        event = "admin role renounced";
      } else if (e.name === "integrity_drift") {
        event = "registered contract runs new code";
        detail = `approved \`${hexOf(d.approved).slice(0, 8)}…\`, live \`${hexOf(d.live).slice(0, 8)}…\``;
      }
      push(`| ${when} | ${event} | ${address} | ${detail} | ${tx} |`);
    }
    push("");
  }

  if (trapped > 0 || released > 0) {
    push("## Vault dynamics");
    push("");
    push(
      `${trapped} account vault flags were set and ${released} cleared during the window. ` +
        "L (the Event Horizon) moves with the HITZ held by the registered pools, so balances near it cross it routinely. " +
        "What to watch is whether a change is **transient** (vaulted and released in the same transaction: lazy evaluation " +
        "passing through an arbitrage contract, as designed) or **persistent** (the state changed and stayed: a buyer whose " +
        "balance ended above L, a holder waiting for L to grow back, or a contract that keeps the HITZ it receives)."
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
      push("### Transient: vaulted and released in the same transaction");
      push("");
      push(
        "The rule working as designed: an account briefly exceeded L while passing HITZ through, and its next outflow " +
          "brought it back under. No user-visible delay."
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
      push("### Persistent: the state changed and stayed");
      push("");
      push(
        "Worth a closer look: a buyer whose balance ended above L (who can now only sell back into the vault), a holder " +
          "waiting for L to grow, or a contract keeping the HITZ it receives instead of routing it. Cross-reference with " +
          "the address's other transfers in this window."
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
  // Every HITZ-touching tx in the window gets a structural narrative
  // built from on-chain events: who initiated, what addresses moved how
  // much HITZ, what playbook it fits. No cutoff: completeness over
  // brevity, because the point is to be able to find any tx.
  if (notableTxs.length > 0) {
    push("## Transactions");
    push("");
    push(
      `Every one of the ${notableTxs.length} HITZ-touching transactions this window, grouped by ` +
        "**playbook**, a recurring pattern recognised end to end. Each playbook is explained once, " +
        "then its most recent occurrence is shown leg by leg and the rest are listed compactly. " +
        "Anything that matches no known pattern lands in *Other / unique patterns*. Swaps between two " +
        "assets in the vault, such as the arbitrage bot's, move no HITZ: they are counted in the " +
        "Sovereign Vault section instead."
    );
    push("");

    // Build one analysis per tx, including playbook assignment.
    const txAnalyses = notableTxs
      .map((hash) => {
        const txTransfers = txsByHash.get(hash) ?? [];
        if (txTransfers.length === 0) return null;
        const txInfo = txCache[hash] ?? {};
        const txSource = txInfo.innerSource ?? txInfo.sourceAccount ?? null;
        const ctx = { ...ctxBase, txSource, txInfo, vaultLeg: vaultLegs.get(hash) ?? null };
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
        `### ${playbook.name}: ${items.length} tx${items.length === 1 ? "" : "s"}, ${fmtHitz(totalVol)} HITZ total`
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
      const exampleDetail = playbook.detail?.(example);
      if (exampleDetail) {
        push(`**In the vault:** ${exampleDetail}`);
        push("");
      }
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
              `⚠ \`${shortAddr(pt.addr)}\` crossed L mid-tx: vaulted, then released in the same tx (lazy evaluation).`
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
        const withDetail = !!playbook.detail && rest.some((a) => playbook.detail(a));
        push(`| When | Tx | HITZ moved | Initiator | Mode |${withDetail ? " In the vault |" : ""}`);
        push(`|---|---|---|---|---|${withDetail ? "---|" : ""}`);
        for (const a of rest) {
          push(
            `| ${a.ts.slice(0, 19).replace("T", " ")} | [\`${a.hash.slice(0, 8)}…\`](https://stellar.expert/explorer/public/tx/${a.hash}) | ${fmtHitz(a.cls.totalMoved)} | \`${shortAddr(a.txSource)}\` | ${initiatorMode(a)} |${withDetail ? ` ${playbook.detail(a)} |` : ""}`
          );
        }
        push("");
      }
    }
  }

  push("---");
  push("");
  push(
    `Source-validated contracts: HITZ token ` +
      `[\`${shortAddr(CONTRACT_ID)}\`](https://stellar.expert/explorer/public/contract/${CONTRACT_ID})` +
      `, Sovereign Vault [\`${shortAddr(VAULT)}\`](https://stellar.expert/explorer/public/contract/${VAULT})`
  );
  push("");

  mkdirSync(reportsDir, { recursive: true });
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
      // Kept so old invocations don't fail: ingestion moved to the Worker cron.
      console.log(
        "[contract-report] `fetch` is no longer needed: the Worker cron ingests events into D1 every 5 minutes."
      );
      break;
    case "generate":
    case "all":
      await generateReport(arg);
      break;
    default:
      console.error("usage: contract-report.mjs generate [YYYY-MM]");
      process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
