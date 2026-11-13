// The monthly report's reading of the Sovereign Vault and the arbitrage bot
// (scripts/report-vault.mjs): seeds, deposits and swaps recovered from the
// vault's reserve points, with the exact fee, and the bot's log matched to
// them. The real rows below are public chain data from mainnet, Nov 2026.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  feesUsd,
  fmtUnits,
  matchBotSwaps,
  poolEvents,
  priceAt,
  summarizeBot,
  summarizeVault,
  toStroops,
  vaultLegIndex,
  vaultSwaps,
} from "../scripts/report-vault.mjs";

const VAULT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";
const point = (eventId, ts, hitz, quote) => ({ eventId, ts, hitz: String(hitz), quote: String(quote) });

// Consecutive points of each pool (a gap would read as one big hop).
// The XLM pool: its seed (Nov 4), the deposit (Nov 9) and the 1 XLM purchase
// right after it. The USDC pool: its seed and deposit.
const XLM_POINTS = [
  point("0280432832961880064-0000000002", 1793752824, 50973941813420n, 10859062138n),
  point("0280804923158401024-0000000002", 1794185997, 509739411813420n, 108590620034n),
  point("0280832299280044032-0000000002", 1794217867, 509692952845764n, 108600620034n),
];
const USDC_POINTS = [
  point("0280433159379222528-0000000002", 1793753204, 37451084986055n, 1273331229n),
  point("0280805077777805312-0000000002", 1794186177, 374510844986055n, 12733312125n),
];
const pools = () => [
  { key: `${VAULT}:XLM`, asset: "XLM", events: poolEvents(XLM_POINTS) },
  { key: `${VAULT}:USDC`, asset: "USDC", events: poolEvents(USDC_POINTS) },
];
// The bot's last trade of Nov 13: each pool's point before it, then after
// it, under one transaction id (XLM into the XLM pool, USDC out of the
// other). The first point of each pair only sets the starting reserves.
const lastTradePools = () => [
  {
    key: `${VAULT}:XLM`,
    asset: "XLM",
    events: poolEvents([
      point("0281116110719234048-0000000002", 1794548267, 503484978146276n, 109970258263n),
      point("0281117656907218944-0000000002", 1794550067, 503321471426670n, 110006822631n),
    ]),
  },
  {
    key: `${VAULT}:USDC`,
    asset: "USDC",
    events: poolEvents([
      point("0281116110719234048-0000000003", 1794548267, 380719775009356n, 12531137661n),
      point("0281117656907218944-0000000003", 1794550067, 380883281728962n, 12525892764n),
    ]),
  },
];
// The bot's log line for its last trade of Nov 13 (GET /api/data/arb-runs).
const LAST_TRADE = {
  id: 32,
  at: "2026-11-13T06:07:37.950Z",
  action: "trade",
  sell: "XLM",
  amount_in: "3.6564368",
  vault_out: "0.5244897",
  hedge_out: "3.6782672",
  profit_xlm: 0.0210385,
  gap_pct: 5.801,
};

test("decimal strings and stroops convert both ways, rounded for display", () => {
  assert.equal(toStroops("25.7379483"), 257379483n);
  assert.equal(toStroops("1"), 10000000n);
  assert.equal(toStroops(null), 0n);
  assert.equal(fmtUnits(257379483n), "25.7379483");
  assert.equal(fmtUnits(144247601475n, 2), "14,424.76");
  assert.equal(fmtUnits(205336n, 4), "0.0205");
  assert.equal(fmtUnits(999995n, 4), "0.1");
  assert.equal(fmtUnits(509739411813420n, 0), "50,973,941");
});

test("a hop's fee follows exactly from the reserves around it", () => {
  // The contract's own arithmetic: gross = r_out × in / (r_in + in) rounded
  // down, the fee rounded up from it, the rest paid out.
  for (const [rate, input] of [[10_000_000n, 25n * 10_000_000n], [27_182_818n, 3n], [100_000_000n, 999_999_999n]]) {
    const hitz = 509_739_411_813_420n;
    const xlm = 108_590_620_034n;
    const gross = (hitz * input) / (xlm + input);
    const fee = (gross * rate + 999_999_999n) / 1_000_000_000n;
    const out = gross - fee;
    const [, hop] = poolEvents([point("1-1", 1, hitz, xlm), point("2-1", 2, hitz - out, xlm + input)]);
    assert.equal(hop.kind, "hop");
    assert.equal(hop.hitzIn, false);
    assert.equal(hop.amountIn, input);
    assert.equal(hop.amountOut, out);
    assert.equal(hop.fee, fee);
  }
});

test("the real XLM pool reads as a seed, a deposit and a purchase", () => {
  const events = poolEvents(XLM_POINTS);
  assert.deepEqual(events.map((e) => e.kind), ["seed", "deposit", "hop"]);
  // The seed and the deposit match the migration record (MIGRATION.md).
  assert.equal(fmtUnits(events[0].quote, 2), "1,085.91");
  assert.equal(fmtUnits(events[1].quote, 7), "9,773.1557896");
  // The 1 XLM purchase of Nov 9 paid out 4,645.8967656 HITZ (its transfer
  // event) and kept a little over 1% as the fee.
  const buy = events[2];
  assert.equal(buy.amountIn, 10_000_000n);
  assert.equal(buy.amountOut, 46_458_967_656n);
  const rate = Number(buy.fee) / Number(buy.fee + buy.amountOut);
  assert.ok(rate >= 0.01 && rate < 0.011, `fee rate ${rate}`);
});

test("hops in one transaction make one swap, and the bot's trade matches it exactly", () => {
  const swaps = vaultSwaps(lastTradePools());
  assert.equal(swaps.length, 1);
  const last = swaps[0];
  assert.equal(last.tx, "0281117656907218944");
  assert.equal(last.kind, "cross");
  assert.deepEqual(last.sold, { token: "XLM", amount: toStroops(LAST_TRADE.amount_in) });
  assert.deepEqual(last.bought, { token: "USDC", amount: toStroops(LAST_TRADE.vault_out) });
  // The first hop's fee is in HITZ, the second's in USDC.
  assert.deepEqual(last.fees.map((f) => f.token), ["HITZ", "USDC"]);
  assert.equal(matchBotSwaps(swaps, [LAST_TRADE], "2026-11-01", "2026-12-01"), 1);
  // A trade of another size matches nothing, and a swap counts once.
  assert.equal(matchBotSwaps(swaps, [{ ...LAST_TRADE, amount_in: "3.6564369" }], "2026-11-01", "2026-12-01"), 0);
  assert.equal(matchBotSwaps(swaps, [LAST_TRADE, LAST_TRADE], "2026-11-01", "2026-12-01"), 1);
});

test("a month's summary: reserves at the bounds, what was added, what was traded", () => {
  const nov = summarizeVault(pools(), Date.UTC(2026, 10, 1) / 1000, Date.UTC(2026, 11, 1) / 1000);
  const [xlm, usdc] = nov.pools;
  assert.equal(xlm.start, null);
  assert.equal(xlm.seeds.length, 1);
  assert.equal(xlm.deposits.length, 1);
  assert.equal(xlm.end.quote, 108600620034n);
  assert.equal(xlm.hops, 1);
  assert.equal(xlm.assetIn, 10_000_000n);
  assert.equal(xlm.hitzOut, 46_458_967_656n);
  assert.equal(usdc.hops, 0);
  assert.equal(usdc.end.hitz, 374510844986055n);
  assert.deepEqual(nov.counts, { buy: 1, sell: 0, cross: 0, multi: 0 });
  // Fees are kept in the token each hop paid out: HITZ for a purchase,
  // the asset on the selling side of a swap between two assets.
  assert.ok(xlm.feeHitz > 0n && xlm.feeAsset === 0n);
  const [, usdcLast] = summarizeVault(lastTradePools(), Date.UTC(2026, 10, 1) / 1000, Date.UTC(2026, 11, 1) / 1000).pools;
  assert.ok(usdcLast.feeAsset > 0n && usdcLast.feeHitz === 0n);
  // October: the vault didn't exist yet.
  const oct = summarizeVault(pools(), Date.UTC(2026, 9, 1) / 1000, Date.UTC(2026, 10, 1) / 1000);
  assert.ok(oct.pools.every((p) => p.start === null && p.end === null && p.hops === 0));
});

test("each HITZ transfer to or from the vault finds its own vault event", () => {
  const legs = vaultLegIndex(pools());
  assert.deepEqual(legs.take("2026-11-04T00:40:24Z", 50973941813420n), {
    kind: "seed",
    asset: "XLM",
    assetAmount: 10859062138n,
  });
  const buy = legs.take("2026-11-09T09:51:07Z", "46458967656");
  assert.equal(buy.kind, "buy");
  assert.equal(buy.assetAmount, 10_000_000n);
  assert.equal(buy.feeToken, "HITZ");
  // Taken once; a different amount or second matches nothing.
  assert.equal(legs.take("2026-11-09T09:51:07Z", "46458967656"), null);
  assert.equal(legs.take("2026-11-09T09:51:08Z", "46458967656"), null);
  // Swaps between two assets move no HITZ, so they have no transfer to match.
  const cross = vaultLegIndex(lastTradePools());
  assert.equal(cross.take("2026-11-13T06:07:47Z", 163507476n), null);
});

test("the bot's month: completed round trips, the rest by kind, profit and gaps", () => {
  const runs = [
    { id: 1, at: "2026-11-12T16:52:38.134Z", action: "setup" },
    { id: 2, at: "2026-11-12T16:57:38.650Z", action: "rebalance", hedge_out: "10.6091399" },
    { id: 3, at: "2026-11-12T17:02:37.946Z", action: "error" },
    { id: 4, at: "2026-11-12T17:07:38.494Z", action: "trade", sell: "XLM", amount_in: "25.7379483", vault_out: "3.8978517", profit_xlm: 1.2773079, gap_pct: 10.627 },
    { id: 9, at: "2026-11-12T22:32:37.921Z", action: "trade-incomplete", sell: "XLM", amount_in: "4.1" },
    LAST_TRADE,
    { id: 40, at: "2026-12-01T00:02:00.000Z", action: "trade", sell: "USDC", amount_in: "1", profit_xlm: 0.03, gap_pct: -3 },
  ];
  const nov = summarizeBot(runs, "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
  assert.equal(nov.firstLive, "2026-11-12T16:52:38.134Z");
  assert.equal(nov.trades, 2);
  assert.equal(nov.incomplete, 1);
  assert.equal(nov.rebalances, 1);
  assert.equal(nov.errors, 1);
  assert.equal(nov.setups, 1);
  assert.deepEqual(nov.sold, { XLM: { trips: 2, amount: toStroops("29.3943851") } });
  assert.ok(Math.abs(nov.profitXlm - 1.2983464) < 1e-9);
  assert.equal(nov.maxGapPct, 10.627);
  assert.deepEqual(nov.perDay.map(([d, v]) => [d, v.trips]), [["2026-11-12", 1], ["2026-11-13", 1]]);
  // December starts with its own trade; the gap counts by size.
  const dec = summarizeBot(runs, "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
  assert.equal(dec.trades, 1);
  assert.equal(dec.maxGapPct, 3);
});

test("prices: the hour at or before, and fees valued in dollars", () => {
  const points = [[1794546000, 0.00003], [1794549600, 0.00004]];
  assert.equal(priceAt(points, 1794545999), null);
  assert.equal(priceAt(points, 1794549000), 0.00003);
  assert.equal(priceAt(points, 1794550067), 0.00004);
  const usd = feesUsd(lastTradePools(), Date.UTC(2026, 10, 13) / 1000, Date.UTC(2026, 10, 14) / 1000, points);
  assert.ok(usd > 0 && usd < 1, `fees ${usd}`);
  assert.equal(feesUsd(pools(), 0, 1, null), null);
});
