// The Sovereign Vault and the arbitrage bot, for the monthly report
// (contract-report.mjs). Pure functions over the rows the Worker's read API
// serves (functions/_lib/report-data.ts), so tests can feed them real rows
// (tests/report-vault.test.mjs). Dependency-free: the report runs on plain
// Node in GitHub Actions.
//
// House style: no em dashes or en dashes in text.

/** 7 decimals: HITZ, XLM and USDC. */
export const UNIT = 10_000_000n;

/**
 * Events of one transaction share the operation id before the dash
 * (`0281116110719234048-0000000002`): a swap through two pools leaves one
 * point in each, under the same id.
 */
export const txKey = (eventId) => String(eventId).split("-")[0];

/** "25.7379483" → 257379483n. Null or empty → 0n. */
export function toStroops(decimal) {
  if (decimal === null || decimal === undefined || decimal === "") return 0n;
  const s = String(decimal).trim();
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(whole || "0") * UNIT + BigInt((frac + "0000000").slice(0, 7));
  return neg ? -v : v;
}

/**
 * 257379483n → "25.7379483": rounded to `maxDecimals`, trailing zeros
 * dropped, thousands separated.
 */
export function fmtUnits(stroops, maxDecimals = 7) {
  const n = typeof stroops === "bigint" ? stroops : BigInt(stroops ?? 0);
  const sign = n < 0n ? "-" : "";
  const step = 10n ** BigInt(7 - Math.min(7, Math.max(0, maxDecimals)));
  const abs = (((n < 0n ? -n : n) + step / 2n) / step) * step;
  const frac = (abs % UNIT).toString().padStart(7, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${sign}${(abs / UNIT).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/**
 * The events of one vault pool, from its reserve points (oldest first, from
 * the pool's first point). The first point is the pool's seed. After that, a
 * point where both reserves grew is a deposit, and any other change is a swap
 * hop. A hop's amounts and fee follow exactly from the reserves before and
 * after it: the contract computes gross = r_out × in / (r_in + in), rounded
 * down, withholds the fee from gross and pays out the rest, so
 * fee = gross − out, in the token the hop paid out.
 */
export function poolEvents(points) {
  const events = [];
  let prev = null;
  for (const p of points) {
    const hitz = BigInt(p.hitz);
    const quote = BigInt(p.quote);
    const base = { eventId: p.eventId, tx: txKey(p.eventId), ts: Number(p.ts), after: { hitz, quote } };
    if (!prev) {
      events.push({ ...base, kind: "seed", hitz, quote, before: null });
    } else {
      const dh = hitz - prev.hitz;
      const dq = quote - prev.quote;
      if (dh > 0n && dq > 0n) {
        events.push({ ...base, kind: "deposit", hitz: dh, quote: dq, before: prev });
      } else if (dq > 0n && dh < 0n) {
        // The asset in, HITZ out.
        const gross = (prev.hitz * dq) / (prev.quote + dq);
        events.push({ ...base, kind: "hop", hitzIn: false, amountIn: dq, amountOut: -dh, fee: gross + dh, before: prev });
      } else if (dh > 0n && dq < 0n) {
        // HITZ in, the asset out.
        const gross = (prev.quote * dh) / (prev.hitz + dh);
        events.push({ ...base, kind: "hop", hitzIn: true, amountIn: dh, amountOut: -dq, fee: gross + dq, before: prev });
      } else {
        events.push({ ...base, kind: "other", hitz: dh, quote: dq, before: prev });
      }
    }
    prev = { hitz, quote };
  }
  return events;
}

/**
 * Swaps, from the hops of every pool (`pools`: [{ asset, events }]), one per
 * transaction:
 *   - buy:   one hop, an asset in and HITZ out
 *   - sell:  one hop, HITZ in and an asset out
 *   - cross: two hops, asset A → HITZ → asset B; HITZ never leaves the vault
 *   - multi: anything else (several swaps in one transaction)
 */
export function vaultSwaps(pools) {
  const byTx = new Map();
  for (const pool of pools) {
    for (const e of pool.events) {
      if (e.kind !== "hop") continue;
      const hops = byTx.get(e.tx) ?? [];
      hops.push({ ...e, asset: pool.asset });
      byTx.set(e.tx, hops);
    }
  }
  const swaps = [];
  for (const [tx, hops] of byTx) {
    hops.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const ts = hops[0].ts;
    const fees = hops.map((h) => ({ token: h.hitzIn ? h.asset : "HITZ", amount: h.fee }));
    let swap;
    if (hops.length === 1 && !hops[0].hitzIn) {
      swap = { kind: "buy", sold: { token: hops[0].asset, amount: hops[0].amountIn }, bought: { token: "HITZ", amount: hops[0].amountOut } };
    } else if (hops.length === 1) {
      swap = { kind: "sell", sold: { token: "HITZ", amount: hops[0].amountIn }, bought: { token: hops[0].asset, amount: hops[0].amountOut } };
    } else if (hops.length === 2 && !hops[0].hitzIn && hops[1].hitzIn && hops[0].amountOut === hops[1].amountIn) {
      swap = { kind: "cross", sold: { token: hops[0].asset, amount: hops[0].amountIn }, bought: { token: hops[1].asset, amount: hops[1].amountOut } };
    } else {
      swap = { kind: "multi", sold: null, bought: null };
    }
    swaps.push({ tx, ts, hops, fees, ...swap });
  }
  return swaps.sort((a, b) => (a.tx < b.tx ? -1 : 1));
}

/**
 * What happened in the vault between `startTs` (inclusive) and `endTs`
 * (exclusive), unix seconds. `pools`: [{ key, asset, events }] with events
 * from poolEvents(). Reserves are as of the last event before each bound
 * (null before the pool was seeded).
 */
export function summarizeVault(pools, startTs, endTs) {
  const inWindow = (e) => e.ts >= startTs && e.ts < endTs;
  const lastBefore = (events, t) => {
    let r = null;
    for (const e of events) if (e.ts < t) r = e.after;
    return r;
  };
  const summaries = pools.map((pool) => {
    const evs = pool.events.filter(inWindow);
    const s = {
      key: pool.key,
      asset: pool.asset,
      start: lastBefore(pool.events, startTs),
      end: lastBefore(pool.events, endTs),
      seeds: evs.filter((e) => e.kind === "seed"),
      deposits: evs.filter((e) => e.kind === "deposit"),
      hops: 0,
      assetIn: 0n,
      assetOut: 0n,
      hitzIn: 0n,
      hitzOut: 0n,
      feeHitz: 0n,
      feeAsset: 0n,
      other: evs.filter((e) => e.kind === "other").length,
    };
    for (const e of evs) {
      if (e.kind !== "hop") continue;
      s.hops++;
      if (e.hitzIn) {
        s.hitzIn += e.amountIn;
        s.assetOut += e.amountOut;
        s.feeAsset += e.fee;
      } else {
        s.assetIn += e.amountIn;
        s.hitzOut += e.amountOut;
        s.feeHitz += e.fee;
      }
    }
    return s;
  });
  const swaps = vaultSwaps(pools).filter(inWindow);
  const counts = { buy: 0, sell: 0, cross: 0, multi: 0 };
  for (const sw of swaps) counts[sw.kind]++;
  return { pools: summaries, swaps, counts };
}

/**
 * The vault leg of each HITZ transfer to or from the vault, keyed by the
 * ledger time (unix seconds) and the HITZ amount it moved: a seed or deposit
 * (HITZ in, with the asset paired), a one-hop purchase (HITZ out) or a
 * one-hop sale (HITZ in). Swaps between two assets move no HITZ and have no
 * transfer to match. Each key holds a list, taken in order.
 */
export function vaultLegIndex(pools) {
  const index = new Map();
  const add = (ts, hitz, leg) => {
    const k = `${ts}|${hitz}`;
    const list = index.get(k) ?? [];
    list.push(leg);
    index.set(k, list);
  };
  for (const pool of pools) {
    for (const e of pool.events) {
      if (e.kind === "seed" || e.kind === "deposit") {
        add(e.ts, e.hitz, { kind: e.kind, asset: pool.asset, assetAmount: e.quote });
      }
    }
  }
  for (const sw of vaultSwaps(pools)) {
    const hop = sw.hops[0];
    if (sw.kind === "buy") add(sw.ts, hop.amountOut, { kind: "buy", asset: hop.asset, assetAmount: hop.amountIn, fee: hop.fee, feeToken: "HITZ" });
    if (sw.kind === "sell") add(sw.ts, hop.amountIn, { kind: "sell", asset: hop.asset, assetAmount: hop.amountOut, fee: hop.fee, feeToken: hop.asset });
  }
  return {
    /** The leg a transfer of `hitz` stroops at `iso` matches, or null. */
    take(iso, hitz) {
      const list = index.get(`${Math.floor(Date.parse(iso) / 1000)}|${BigInt(hitz)}`);
      return list?.length ? list.shift() : null;
    },
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The bot's live actions between `startISO` (inclusive) and `endISO`
 * (exclusive), from the rows of /api/data/arb-runs. `firstLive` is the first
 * live action ever, whether or not it falls in the window.
 */
export function summarizeBot(runs, startISO, endISO) {
  const rows = runs.filter((r) => r.at >= startISO && r.at < endISO);
  const count = (action) => rows.filter((r) => r.action === action).length;
  const trades = rows.filter((r) => r.action === "trade");
  const sold = {};
  for (const t of trades) {
    const k = t.sell ?? "?";
    sold[k] ??= { trips: 0, amount: 0n };
    sold[k].trips++;
    sold[k].amount += toStroops(t.amount_in);
  }
  const perDay = new Map();
  for (const t of trades) {
    const d = t.at.slice(0, 10);
    const day = perDay.get(d) ?? { trips: 0, profit: 0 };
    day.trips++;
    day.profit += Number(t.profit_xlm ?? 0);
    perDay.set(d, day);
  }
  const gaps = trades.map((t) => Math.abs(Number(t.gap_pct))).filter((g) => Number.isFinite(g));
  return {
    firstLive: runs.length ? runs.reduce((m, r) => (r.at < m ? r.at : m), runs[0].at) : null,
    trades: trades.length,
    incomplete: count("trade-incomplete"),
    missed: count("missed"),
    rebalances: count("rebalance"),
    setups: count("setup"),
    errors: count("error"),
    sold,
    profitXlm: trades.reduce((s, t) => s + Number(t.profit_xlm ?? 0), 0),
    medianGapPct: median(gaps),
    maxGapPct: gaps.length ? Math.max(...gaps) : null,
    perDay: [...perDay.entries()].sort(),
  };
}

/**
 * How many of the bot's completed round trips in the window match one of
 * the vault's asset-to-asset swaps exactly: the asset it sold, the amount,
 * and what the vault paid. Each swap counts once.
 */
export function matchBotSwaps(swaps, runs, startISO, endISO) {
  const free = swaps.filter((s) => s.kind === "cross");
  let matched = 0;
  for (const t of runs) {
    if (t.action !== "trade" || t.at < startISO || t.at >= endISO) continue;
    const i = free.findIndex(
      (s) => s.sold.token === t.sell && s.sold.amount === toStroops(t.amount_in) && s.bought.amount === toStroops(t.vault_out)
    );
    if (i >= 0) {
      free.splice(i, 1);
      matched++;
    }
  }
  return matched;
}

/**
 * HITZ/USD at unix second `ts`, from the hourly [hourTs, usd] points of
 * /api/price/history: the last point at or before it, or null.
 */
export function priceAt(points, ts) {
  let lo = 0;
  let hi = points.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= ts) {
      found = points[mid][1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The fees the vault kept in the window, in dollars at each hop's hour: a
 * fee in HITZ at the HITZ price, a fee in an asset first turned into HITZ at
 * the pool's own price before the hop. Null without prices.
 */
export function feesUsd(pools, startTs, endTs, points) {
  if (!points?.length) return null;
  let usd = 0;
  for (const pool of pools) {
    for (const e of pool.events) {
      if (e.kind !== "hop" || e.ts < startTs || e.ts >= endTs) continue;
      const price = priceAt(points, e.ts);
      if (price === null) continue;
      const hitz = e.hitzIn ? (Number(e.fee) * Number(e.before.hitz)) / Number(e.before.quote) : Number(e.fee);
      usd += (hitz / 1e7) * price;
    }
  }
  return usd;
}
