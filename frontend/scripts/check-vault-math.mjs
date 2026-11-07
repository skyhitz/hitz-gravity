#!/usr/bin/env node
// Replays the Sovereign Vault's golden vectors against app/lib/vaultMath.ts.
//
//   node --experimental-strip-types scripts/check-vault-math.mjs
//
// The rows are the ones the contract test `fee_math_matches_the_golden_vectors`
// (contracts/sovereign-vault/src/test.rs) asserts and that
// research/vault-backtest/vaultmath.py --check replays: XLM and USDC seeded,
// four swaps, EURC listed after the timelock and seeded, seven more swaps.
// Each row: amount out, then (hitz, reserve, deviation, fee) per pool in
// listing order, zeros before EURC is listed. Any difference fails the run.

import { UPGRADE_DELAY_SECS, listAsset, newVault, poolState, seed, swap } from "../app/lib/vaultMath.ts";

const U = 10_000_000n;
const START = 1_800_000_000n;
const SEEDS = [
  ["XLM", 288_489_893_497_397n, 54_295_310_693n],
  ["USDC", 153_635_240_499_979n, 6_366_656_146n],
];
const LISTED = ["EURC", 120_000_000_000_000n, 4_300_000_000n];
const FIRST = [
  [0n, "XLM", "USDC", 50n * U],
  [300n, "USDC", "XLM", 10n * U],
  [3_600n, "XLM", "HITZ", 100n * U],
  [0n, "HITZ", "USDC", 1_000_000n * U],
];
const THEN = [
  [60n, "EURC", "XLM", 20n * U],
  [5n, "XLM", "EURC", 3n * U + 1_234n],
  [1_800n, "USDC", "EURC", 40n * U],
  [17n, "HITZ", "EURC", 3_000_000n * U],
  [100_000n, "EURC", "USDC", 7n * U],
  [61n, "XLM", "USDC", U],
  [3n, "USDC", "XLM", 123_456_789n],
];
const ROWS = [
  [90583437n, 286022114858658n, 54795310693n, 17757676649745520n, 100000000n, 156103019138718n, 6276072709n, -30264917526016470n, 100000000n, 0n, 0n, 0n, 0n],
  [440465227n, 288366558038543n, 54354845466n, 798810344678132n, 11175972n, 153758575958833n, 6376072709n, 1910620077562421n, 11175972n, 0n, 0n, 0n, 0n],
  [4688476682571n, 283678081355972n, 55354845466n, 35107300848891364n, 100000000n, 153758575958833n, 6376072709n, 1158849522909780n, 100000000n, 0n, 0n, 0n, 0n],
  [350422284n, 283678081355972n, 55354845466n, 35107300848891364n, 100000000n, 163758575958833n, 6025650425n, -118377629224182636n, 100000000n, 0n, 0n, 0n, 0n],
  [0n, 283678081355972n, 55354845466n, 0n, 10000000n, 163758575958833n, 6025650425n, 0n, 10000000n, 120000000000000n, 4300000000n, 0n, 10000000n],
  [828946626n, 288478081355971n, 54525898840n, -31867430416331614n, 100000000n, 163758575958833n, 6025650425n, 0n, 100000000n, 115200000000001n, 4500000000n, 86284368597003772n, 100000000n],
  [5013225n, 288335306173639n, 54555900074n, -30800191278960235n, 100000000n, 163758575958833n, 6025650425n, 0n, 100000000n, 115342775182333n, 4494986775n, 83871198194729064n, 100000000n],
  [298078229n, 288335306173639n, 54555900074n, -23987211698595394n, 100000000n, 154583926943411n, 6425650425n, 121928511313954142n, 100000000n, 124517424197755n, 4196908546n, -79832891648938117n, 100000000n],
  [733357621n, 288335306173639n, 54555900074n, -23930642003679640n, 100000000n, 154583926943411n, 6425650425n, 121640964135581149n, 100000000n, 154517424197755n, 3463550925n, -487559680195334898n, 100000000n],
  [101258230n, 288335306173639n, 54555900074n, -22206937912n, 100000000n, 157338832117009n, 6324392195n, -33548292640501588n, 100000000n, 151762519024157n, 3533550925n, 37998442183763223n, 100000000n],
  [1719938n, 288287748674321n, 54565900074n, 348211191514682n, 100000000n, 157386389616327n, 6322672257n, -33839470698265265n, 100000000n, 151762519024157n, 3533550925n, 37677870758180204n, 100000000n],
  [457820900n, 291000597942479n, 54108079174n, -17443781529266122n, 100000000n, 154673540348169n, 6446129046n, 2899642351966819n, 100000000n, 151762519024157n, 3533550925n, 37662174931659568n, 100000000n],
];

function row(pools, now, out) {
  const r = [out, ...Array(12).fill(0n)];
  pools.forEach((_, i) => {
    const s = poolState(pools, i, now);
    r.splice(1 + 4 * i, 4, s.hitz, s.reserve, s.deviation, s.fee);
  });
  return r;
}

let now = START;
let pools = newVault(SEEDS.map(([a]) => a), now);
for (const [asset, hitz, amount] of SEEDS) pools = seed(pools, asset, hitz, amount, now);

const got = [];
for (const [dt, tin, tout, amount] of FIRST) {
  now += dt;
  const r = swap(pools, tin, tout, amount, now);
  pools = r.pools;
  got.push(row(pools, now, r.amountOut));
}
now += UPGRADE_DELAY_SECS;
pools = listAsset(pools, LISTED[0], now);
pools = seed(pools, LISTED[0], LISTED[1], LISTED[2], now);
got.push(row(pools, now, 0n));
for (const [dt, tin, tout, amount] of THEN) {
  now += dt;
  const r = swap(pools, tin, tout, amount, now);
  pools = r.pools;
  got.push(row(pools, now, r.amountOut));
}

let failures = 0;
ROWS.forEach((want, i) => {
  want.forEach((v, j) => {
    if (got[i][j] !== v) {
      failures++;
      console.error(`row ${i} column ${j}: got ${got[i][j]}, want ${v}`);
    }
  });
});
if (failures) {
  console.error(`${failures} mismatches`);
  process.exit(1);
}
console.log(`vaultMath.ts matches all ${ROWS.length} golden rows`);
