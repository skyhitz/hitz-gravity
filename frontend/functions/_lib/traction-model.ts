// Traction model — pure functions behind the Monitor tab's traction card.
// Used by the Worker cron (_lib/ingest.ts) and runnable offline with
// `node --experimental-strip-types`; keep it dependency-free.
//
// "People" are accounts (G-addresses) outside the protocol's own
// infrastructure: registered pools, registered routers, and the treasury
// (the admin account, itself registered as pool mass). Contracts (C-
// addresses) are never people — bots, aggregators and AMMs all live there.
//
// Activity comes from HITZ `transfer` events. The event store begins on
// 2026-05-11, so launch-window activity (Apr 25 – May 11) isn't counted and
// anyone first active then shows up as "new" on their next appearance.

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;

/** One person's side of a transfer event (a transfer between two people yields two rows). */
export interface PeopleTx {
  /** ISO 8601 ledger close time. */
  ts: string;
  txHash: string;
  addr: string;
  /** Sponsored by the Skyhitz email gateway; null when unknown (no tx info yet). */
  gateway: boolean | null;
  /** The transaction's source account (inner source for fee bumps); null if unknown. */
  source: string | null;
}

/**
 * How an account first got involved:
 *   email    — through the Skyhitz email gateway (sponsor-fee-bumped)
 *   wallet   — signed its own transaction (e.g. bought from a pool)
 *   received — someone else's transaction sent it HITZ
 */
export type Channel = "email" | "wallet" | "received" | "unknown";

export type HolderRole = "person" | "contract" | "amm" | "treasury" | "router";

export interface HolderBalance {
  address: string;
  /** Whole HITZ. */
  hitz: number;
  role: HolderRole;
}

export interface MonthTraction {
  /** `YYYY-MM`. */
  month: string;
  activePeople: number;
  newPeople: number;
  returningPeople: number;
  /** Distinct HITZ transactions touching at least one person. */
  humanTxs: number;
  /** All distinct HITZ transactions (people, bots, infrastructure). */
  allTxs: number;
  /** People with at least one email-gateway transaction that month; null if unknown. */
  gatewayPeople: number | null;
}

export interface TractionSnapshot {
  asOf: string;
  /** First stored event — activity metrics cover [since, asOf]. */
  since: string;
  window: {
    activePeople: number;
    /** Active in the 30 days before the current window. */
    prevActivePeople: number;
    newPeople: number;
    returningPeople: number;
    humanTxs: number;
    allTxs: number;
    gatewayPeople: number | null;
  };
  months: MonthTraction[];
  allTime: { people: number; gatewayPeople: number | null };
  /** Each account's first transaction, by channel — all time, and for accounts new in the window. */
  channels: { allTime: Record<Channel, number>; window: Record<Channel, number> };
  holders: {
    /** People holding a non-zero balance right now. */
    people: number;
    vaultedPeople: number;
    /** Between 75% and 100% of L — one trade from the horizon. */
    nearHorizonPeople: number;
    /** Non-infrastructure contracts holding HITZ (bots, aggregators). */
    contracts: number;
    /** Share of people-held HITZ owned by the 10 largest people (0..1). */
    top10Share: number;
    /** Where the supply sits, in whole HITZ. */
    supply: {
      amm: number;
      treasury: number;
      routers: number;
      contracts: number;
      vaultedPeople: number;
      people: number;
      total: number;
    };
  };
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Every `YYYY-MM` from `from` through `to`, inclusive. */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function summarizeTraction(args: {
  peopleTxs: PeopleTx[];
  /** Distinct HITZ transactions per `YYYY-MM`. */
  monthTxs: Record<string, number>;
  /** Distinct HITZ transactions in the last 30 days. */
  windowTxs: number;
  holders: HolderBalance[];
  safetyLimit: number;
  nowMs: number;
  since: string;
  gatewayKnown: boolean;
  asOf: string;
}): TractionSnapshot {
  const w0 = new Date(args.nowMs - WINDOW_MS).toISOString();
  const w1 = new Date(args.nowMs - 2 * WINDOW_MS).toISOString();

  // Each person's first appearance in the store, and how it happened.
  const firstSeen = new Map<string, string>();
  const firstTx = new Map<string, PeopleTx>();
  for (const t of args.peopleTxs) {
    const prev = firstSeen.get(t.addr);
    if (!prev || t.ts < prev) {
      firstSeen.set(t.addr, t.ts);
      firstTx.set(t.addr, t);
    }
  }
  const channelOf = (t: PeopleTx): Channel =>
    t.gateway === null || t.source === null
      ? "unknown"
      : t.gateway
        ? "email"
        : t.source === t.addr
          ? "wallet"
          : "received";
  const emptyChannels = (): Record<Channel, number> => ({ email: 0, wallet: 0, received: 0, unknown: 0 });
  const channels = { allTime: emptyChannels(), window: emptyChannels() };
  for (const [addr, t] of firstTx) {
    const c = channelOf(t);
    channels.allTime[c] += 1;
    if ((firstSeen.get(addr) ?? "") >= w0) channels.window[c] += 1;
  }

  const active = new Set<string>();
  const prevActive = new Set<string>();
  const windowTx = new Set<string>();
  const windowGateway = new Set<string>();
  const allGateway = new Set<string>();
  const byMonth = new Map<string, { people: Set<string>; txs: Set<string>; gateway: Set<string> }>();

  for (const t of args.peopleTxs) {
    if (t.gateway) allGateway.add(t.addr);
    if (t.ts >= w0) {
      active.add(t.addr);
      windowTx.add(t.txHash);
      if (t.gateway) windowGateway.add(t.addr);
    } else if (t.ts >= w1) {
      prevActive.add(t.addr);
    }
    const m = monthOf(t.ts);
    const bucket = byMonth.get(m) ?? { people: new Set(), txs: new Set(), gateway: new Set() };
    bucket.people.add(t.addr);
    bucket.txs.add(t.txHash);
    if (t.gateway) bucket.gateway.add(t.addr);
    byMonth.set(m, bucket);
  }

  const newInWindow = [...active].filter((a) => (firstSeen.get(a) ?? "") >= w0).length;
  const nowMonth = monthOf(new Date(args.nowMs).toISOString());
  const months: MonthTraction[] = monthRange(monthOf(args.since), nowMonth).map((m) => {
    const b = byMonth.get(m);
    const people = b ? [...b.people] : [];
    const fresh = people.filter((a) => monthOf(firstSeen.get(a) ?? "") === m).length;
    return {
      month: m,
      activePeople: people.length,
      newPeople: fresh,
      returningPeople: people.length - fresh,
      humanTxs: b?.txs.size ?? 0,
      allTxs: args.monthTxs[m] ?? 0,
      gatewayPeople: args.gatewayKnown ? (b?.gateway.size ?? 0) : null,
    };
  });

  // Holders, from live ledger balances.
  const L = args.safetyLimit;
  const people = args.holders.filter((h) => h.role === "person" && h.hitz > 0);
  const vaulted = people.filter((h) => h.hitz > L);
  const below = people.filter((h) => h.hitz <= L);
  const sum = (hs: HolderBalance[]) => hs.reduce((s, h) => s + h.hitz, 0);
  const byRole = (role: HolderRole) => args.holders.filter((h) => h.role === role && h.hitz > 0);
  const peopleHitz = sum(people);
  const top10 = sum([...people].sort((a, b) => b.hitz - a.hitz).slice(0, 10));
  const supply = {
    amm: sum(byRole("amm")),
    treasury: sum(byRole("treasury")),
    routers: sum(byRole("router")),
    contracts: sum(byRole("contract")),
    vaultedPeople: sum(vaulted),
    people: sum(below),
    total: sum(args.holders),
  };
  const round = (v: number) => Math.round(v * 1e7) / 1e7;

  return {
    asOf: args.asOf,
    since: args.since,
    window: {
      activePeople: active.size,
      prevActivePeople: prevActive.size,
      newPeople: newInWindow,
      returningPeople: active.size - newInWindow,
      humanTxs: windowTx.size,
      allTxs: args.windowTxs,
      gatewayPeople: args.gatewayKnown ? windowGateway.size : null,
    },
    months,
    allTime: { people: firstSeen.size, gatewayPeople: args.gatewayKnown ? allGateway.size : null },
    channels,
    holders: {
      people: people.length,
      vaultedPeople: vaulted.length,
      nearHorizonPeople: below.filter((h) => h.hitz > 0.75 * L).length,
      contracts: byRole("contract").length,
      top10Share: peopleHitz > 0 ? Number((top10 / peopleHitz).toFixed(4)) : 0,
      supply: Object.fromEntries(Object.entries(supply).map(([k, v]) => [k, round(v)])) as typeof supply,
    },
  };
}
