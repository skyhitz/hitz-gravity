// The arbitrage bot (functions/_lib/arb.ts) against a simulated Stellar
// network (helpers/ledger.mjs): the bot's own transactions are decoded and
// applied with the network's checks, so these tests see what would really
// land. Reference sizes and profits were worked out apart from the bot, by
// brute force over the vault math (0.01 XLM steps) for the vault as it stood
// on mainnet on Nov 11, 2026, when 1 XLM was worth 0.15957 USDC in it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as StellarSdk from "@stellar/stellar-sdk";
import { swap } from "../app/lib/vaultMath.ts";
import { pathPaymentReceived, planTrade, returnValueOf, runOnce } from "../functions/_lib/arb.ts";
import { botConfig, HITZ, MAINNET_POOLS, makeLedger, units, USDC_SAC, XLM_SAC } from "./helpers/ledger.mjs";

const POOLS = MAINNET_POOLS.map((p) => ({ ...p, updated: 0n }));
/** The SDEX on Nov 11, 2026: the vault paid 5.9% more for XLM. */
const SDEX = { bid: 0.1503063, ask: 0.150481 };
const vaultPays = (tokenIn, tokenOut, amount) => swap(POOLS, tokenIn, tokenOut, amount, 0n, HITZ).amountOut;
const xlm = (raw) => Number(raw) / 1e7;

const plan = (over = {}) =>
  planTrade({
    pools: POOLS,
    now: 0n,
    hitz: HITZ,
    sac: { XLM: XLM_SAC, USDC: USDC_SAC },
    balances: { xlm: units("5000"), usdc: units("1000") },
    market: SDEX,
    maxTradeXlm: 150,
    ...over,
  });

/** A funded bot account on a fresh simulated network. */
function world({ sdex = SDEX, funds = { xlm: "500", usdc: "50" }, ...options } = {}) {
  const ledger = makeLedger({ ...sdex, ...options });
  const keypair = StellarSdk.Keypair.random();
  if (funds) ledger.fund(keypair.publicKey(), funds);
  const address = keypair.publicKey();
  return { ledger, keypair, address, run: (overrides) => runOnce(botConfig(ledger, keypair, overrides)) };
}
const sent = (ledger) => ledger.submitted.map((e) => e.type);

// ─── Sizing ──────────────────────────────────────────────────────────────────

test("with the vault paying more for XLM than the SDEX, it sells XLM at the size that earns the most", () => {
  const p = plan();
  assert.equal(p.sell, "XLM");
  assert.equal(p.buy, "USDC");
  assert.equal(p.vaultOut, vaultPays(XLM_SAC, USDC_SAC, p.amountIn));
  // Brute force: 16.02 XLM earns 0.34953 XLM, and no other size earns more.
  assert.ok(Math.abs(xlm(p.amountIn) - 16.02) < 0.05, `sized ${xlm(p.amountIn)} XLM`);
  assert.ok(Math.abs(p.profitXlm - 0.34953) < 0.0002, `planned ${p.profitXlm} XLM`);
});

test("with the vault paying less for XLM than the SDEX, it sells USDC", () => {
  const p = plan({ market: { bid: 0.17, ask: 0.17 } });
  assert.equal(p.sell, "USDC");
  assert.equal(p.buy, "XLM");
  assert.equal(p.vaultOut, vaultPays(USDC_SAC, XLM_SAC, p.amountIn));
  // Brute force: 2.600 USDC earns 0.06398 USDC, which is 0.37636 XLM at 0.17.
  assert.ok(Math.abs(xlm(p.amountIn) - 2.6) < 0.01, `sized ${xlm(p.amountIn)} USDC`);
  assert.ok(Math.abs(p.profitXlm - 0.37636) < 0.0005, `planned ${p.profitXlm} XLM`);
});

test("inside the vault's fee band there is nothing to plan", () => {
  // 1.6% apart: the two 1% hops cost more than the gap.
  assert.equal(plan({ market: { bid: 0.1568, ask: 0.157 } }), null);
  assert.equal(plan({ market: { bid: 0.1621, ask: 0.1623 } }), null);
});

test("just outside the fee band, where even the smallest trade loses, there is no plan", () => {
  // 2.07% apart: 1 XLM pays 0.1562624 USDC in the vault, which buys back 0.99976 XLM at 0.1563.
  assert.equal(plan({ market: { bid: 0.1561, ask: 0.1563 } }), null);
});

test("the buy-back never spends more than the vault will pay back", () => {
  const p = plan();
  assert.ok(p.hedgeIn <= p.vaultOut);
  assert.ok(p.hedgeIn >= (p.vaultOut * 999n) / 1000n, "and no more than 0.1% under it");
});

test("the buy-back spends no more than the vault will still pay if its leg lands late", () => {
  // Someone bought XLM from the vault: its XLM price sits 1% under its 2-hour average. As that
  // fades, a sale the other way that overshoots it pays a little less with every ledger.
  const pools = POOLS.map((p) => (p.asset === XLM_SAC ? { ...p, deviation: -10_000_000_000_000_000n } : p));
  const p = plan({ pools, market: { bid: 0.1298, ask: 0.13 } });
  assert.equal(p.sell, "XLM");
  const paysIn = (seconds) => swap(pools, XLM_SAC, USDC_SAC, p.amountIn, BigInt(seconds), HITZ).amountOut;
  assert.equal(p.vaultOut, paysIn(0));
  // The vault leg is valid for a minute: by then the same 57 XLM pays 4.5 basis points less.
  assert.ok(paysIn(60) < (paysIn(0) * 9_996n) / 10_000n, "a minute's wait costs over 4 basis points here");
  assert.ok(p.hedgeIn <= paysIn(60), `would spend ${p.hedgeIn}, the vault pays ${paysIn(60)} a minute on`);
});

test("a trade is sized to what the account holds on both legs", () => {
  // The SDEX leg spends USDC before the vault pays any: 1 USDC buys back at most 6.43 XLM of vault trade.
  const short = plan({ balances: { xlm: units("500"), usdc: units("1") } });
  assert.ok(short.hedgeIn <= units("1"), `would spend ${xlm(short.hedgeIn)} USDC`);
  assert.ok(xlm(short.amountIn) > 6 && xlm(short.amountIn) <= 6.4318, `sized ${xlm(short.amountIn)} XLM`);
  // And the vault leg sells XLM the account must already hold.
  const thin = plan({ balances: { xlm: units("4"), usdc: units("50") } });
  assert.ok(thin.amountIn <= units("4"));
  // The mirror image: selling USDC into the vault, the SDEX leg spends XLM first.
  const mirror = plan({ market: { bid: 0.17, ask: 0.17 }, balances: { xlm: units("3"), usdc: units("100") } });
  assert.ok(mirror.hedgeIn <= units("3"), `would spend ${xlm(mirror.hedgeIn)} XLM`);
  assert.ok(mirror.amountIn > 0n);
});

test("with too little to fund the smallest trade, there is no plan", () => {
  assert.equal(plan({ balances: { xlm: units("500"), usdc: units("0.05") } }), null);
  assert.equal(plan({ balances: { xlm: units("0.5"), usdc: units("50") } }), null);
});

test("a trade never exceeds the cap", () => {
  // The SDEX a third lower: the uncapped best trade is 668 XLM.
  const p = plan({ market: { bid: 0.0999, ask: 0.1 }, maxTradeXlm: 20 });
  assert.ok(xlm(p.amountIn) > 19.9 && p.amountIn <= units("20"), `sized ${xlm(p.amountIn)} XLM`);
});

// ─── A round trip ────────────────────────────────────────────────────────────

test("a live round trip buys back on the SDEX first, then swaps in the vault", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend", "swap"]);
  assert.deepEqual(ledger.submitted.map((e) => e.status), ["SUCCESS", "SUCCESS"]);
  assert.deepEqual(ledger.submitted.map((e) => e.tx.sequence), ["1001", "1002"]);

  const [hedge, vault] = ledger.submitted;
  assert.equal(hedge.op.sendAsset.getCode(), "USDC");
  assert.equal(hedge.op.destAsset.isNative(), true);
  assert.equal(hedge.op.destination, address);
  assert.equal(vault.call.tokenIn, XLM_SAC);
  assert.equal(vault.call.tokenOut, USDC_SAC);
  assert.equal(vault.call.to, address);

  // The account ends with more XLM and no less USDC.
  const after = ledger.account(address);
  assert.ok(after.usdc >= before.usdc, "USDC is whole");
  assert.ok(after.xlm > before.xlm, "XLM grew");
  // 0.34953 XLM before fees, less the 0.0021752 XLM the two transactions cost here.
  const gained = xlm(after.xlm - before.xlm) + xlm(after.usdc - before.usdc) / SDEX.ask;
  assert.ok(Math.abs(gained - 0.34735) < 0.0005, `gained ${gained} XLM`);
  assert.ok(Math.abs(report.profitXlm - gained) < 1e-6, `reported ${report.profitXlm}, gained ${gained}`);
  assert.equal(report.hedgeLeg.status, "SUCCESS");
  assert.equal(report.vaultLeg.status, "SUCCESS");
  assert.equal(units(report.hedgeLeg.received), hedge.received);
  assert.equal(units(report.vaultLeg.received), vault.received);
});

test("the two legs carry minimums that make a finished round trip a profit", async () => {
  const { ledger, run } = world();
  await run();
  const [hedge, vault] = ledger.submitted;
  // The vault must pay back at least what the SDEX leg spent...
  assert.equal(vault.call.minOut, units(hedge.op.sendAmount));
  // ...and the SDEX leg must return more than the vault leg sells, by the fees at least.
  assert.ok(units(hedge.op.destMin) >= vault.call.amountIn + 21_752n, `dest_min ${hedge.op.destMin} for ${xlm(vault.call.amountIn)} XLM sold`);
});

test("right after someone traded the vault the other way, a round trip still finishes", async () => {
  const { ledger, address, run } = world();
  // Someone just bought XLM from the vault with 1.8 USDC: its XLM price sits half a percent dislocated.
  ledger.swapAsOther(USDC_SAC, XLM_SAC, "1.8");
  const before = ledger.account(address);
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  const [, vault] = ledger.submitted;
  // The vault leg landed a few ledgers after its simulation and paid a little less than simulated...
  assert.ok(vault.received < units(report.plan.vaultOut), `paid ${vault.received}, simulated ${report.plan.vaultOut}`);
  // ...and still covered what the buy-back spent.
  const after = ledger.account(address);
  assert.ok(after.usdc >= before.usdc, "USDC is whole");
  assert.ok(after.xlm > before.xlm, "XLM grew");
});

test("on a thin margin the SDEX leg's minimum is still the amount sold plus the fees", async () => {
  // 2.6% apart: 3.23 XLM earns 0.29%, less than the 0.3% the buy-back may slip under its quote.
  const { ledger, run } = world({ sdex: { bid: 0.1553, ask: 0.1555 } });
  const report = await run({ minProfitXlm: 0.005, minProfitBps: 0 });
  assert.equal(report.action, "trade", report.error ?? report.reason);
  const [hedge, vault] = ledger.submitted;
  assert.equal(units(hedge.op.destMin), vault.call.amountIn + 21_752n);
});

test("the mirror round trip sells XLM on the SDEX, then USDC into the vault", async () => {
  const { ledger, address, run } = world({ sdex: { bid: 0.17, ask: 0.1702 } });
  const before = ledger.account(address);
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  const [hedge, vault] = ledger.submitted;
  assert.equal(hedge.op.sendAsset.isNative(), true);
  assert.equal(hedge.op.destAsset.getCode(), "USDC");
  assert.equal(vault.call.tokenIn, USDC_SAC);
  assert.equal(vault.call.minOut, units(hedge.op.sendAmount));
  const after = ledger.account(address);
  assert.ok(after.usdc > before.usdc, "USDC grew");
  // XLM is whole but for the 0.0021752 XLM of fees.
  assert.ok(after.xlm >= before.xlm - 21_752n, `XLM changed by ${xlm(after.xlm - before.xlm)}`);
  assert.equal(report.plan.sell, "USDC");
});

test("a dry run plans and simulates, and sends nothing", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  const report = await run({ live: false, keypair: undefined });
  assert.equal(report.action, "would-trade");
  assert.equal(report.mode, "dry-run");
  assert.deepEqual(sent(ledger), []);
  assert.equal(ledger.calls.includes("rpc sendTransaction"), false);
  assert.deepEqual(ledger.account(address), before);
  assert.equal(report.plan.sell, "XLM");
  assert.ok(Math.abs(Number(report.plan.amountIn) - 16.02) < 0.05, `planned ${report.plan.amountIn} XLM`);
  assert.ok(Math.abs(report.plan.profitXlm - 0.34735) < 0.0005, `planned ${report.plan.profitXlm} XLM after fees`);
  // The vault at 0.159571 over the SDEX mid of 0.150394.
  assert.ok(Math.abs(report.gapPct - 6.102) < 0.01, `gap ${report.gapPct}%`);
});

test("when the SDEX moves away before the buy-back lands, the vault is never touched", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  const pools = structuredClone(ledger.pools);
  ledger.onSubmit = (entry) => {
    if (entry.type === "pathPaymentStrictSend") ledger.sdex = { bid: 0.1548, ask: 0.155 };
  };
  const report = await run();
  assert.equal(report.action, "missed");
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend"]);
  assert.equal(ledger.submitted[0].status, "FAILED");
  assert.deepEqual(ledger.pools, pools);
  const after = ledger.account(address);
  assert.equal(after.usdc, before.usdc);
  assert.equal(after.xlm, before.xlm - 100n, "only the failed transaction's fee is gone");
  assert.equal(report.hedgeLeg.status, "FAILED");
  assert.match(report.hedgeLeg.code, /UnderDestmin/);
  assert.equal(report.profitXlm, undefined);
});

test("when someone else trades the vault first, the round trip stops after the buy-back and says so", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  ledger.onApplied = (entry) => {
    if (entry.type === "pathPaymentStrictSend") ledger.swapAsOther(XLM_SAC, USDC_SAC, "30");
  };
  const report = await run();
  assert.equal(report.action, "trade-incomplete");
  assert.deepEqual(ledger.submitted.map((e) => e.status), ["SUCCESS", "FAILED"]);
  assert.equal(report.hedgeLeg.status, "SUCCESS");
  assert.equal(report.vaultLeg.status, "FAILED");
  assert.match(report.reason, /vault/);
  assert.equal(report.profitXlm, undefined);
  // What is left is a plain conversion at the SDEX price: USDC out, XLM in.
  const after = ledger.account(address);
  const [hedge] = ledger.submitted;
  assert.equal(before.usdc - after.usdc, units(hedge.op.sendAmount));
  assert.equal(after.xlm - before.xlm, hedge.received - 100n - 21_652n);
});

test("a buy-back that never lands is followed until it no longer can, and the vault leg is not sent", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  const started = ledger.time;
  ledger.drop = (entry) => entry.type === "pathPaymentStrictSend";
  const report = await run();
  assert.equal(report.action, "missed");
  assert.equal(report.hedgeLeg.status, "EXPIRED");
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend"]);
  assert.deepEqual(ledger.account(address), before);
  const waited = ledger.time - started;
  assert.ok(waited >= 30 && waited < 120, `followed it for ${waited} s`);
});

test("when the buy-back's outcome can't be learned, the vault leg is not sent and the run is an error", async () => {
  const { ledger, run } = world();
  ledger.rpcDown = (method) => method === "getTransaction";
  const report = await run();
  assert.equal(report.action, "error");
  assert.equal(report.hedgeLeg.status, "UNKNOWN");
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend"]);
  assert.match(report.error, /buy-back/);
});

test("a vault leg that can't be sent after the buy-back is an incomplete trade, not a plain error", async () => {
  const { ledger, run } = world();
  ledger.rpcDown = (method) => method === "sendTransaction" && ledger.submitted.length === 1;
  const report = await run();
  assert.equal(report.action, "trade-incomplete");
  assert.equal(report.hedgeLeg.status, "SUCCESS");
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend"]);
});

test("a busy network's 'try again later' is retried", async () => {
  const { ledger, run } = world();
  ledger.tryAgainLater = 2;
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  assert.deepEqual(ledger.submitted.map((e) => e.status), ["SUCCESS", "SUCCESS"]);
});

test("an RPC node a ledger behind refuses the vault leg's sequence number: it is sent again", async () => {
  const { ledger, run } = world();
  ledger.behind = 2;
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  assert.deepEqual(ledger.submitted.map((e) => e.status), ["SUCCESS", "SUCCESS"]);
});

test("a sequence number that stays refused ends the round trip as incomplete, after a few tries", async () => {
  const { ledger, run } = world();
  ledger.behind = 1000;
  const report = await run();
  assert.equal(report.action, "trade-incomplete");
  assert.equal(report.vaultLeg.status, "REJECTED");
  assert.equal(report.vaultLeg.code, "txBadSeq");
  const sends = ledger.calls.filter((c) => c === "rpc sendTransaction").length;
  assert.ok(sends >= 3 && sends <= 6, `${sends} sends for two transactions`);
});

test("a vault leg that returns something other than an amount is still a finished trade", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  ledger.voidReturn = true;
  const report = await run();
  assert.equal(report.action, "trade", report.error ?? report.reason);
  const after = ledger.account(address);
  const gained = xlm(after.xlm - before.xlm) + xlm(after.usdc - before.usdc) / SDEX.ask;
  assert.ok(Math.abs(report.profitXlm - gained) < 1e-4, `reported ${report.profitXlm}, gained ${gained}`);
});

test("a vault leg whose return value can't be read is still a finished trade", async () => {
  const { ledger, address, run } = world();
  const before = ledger.account(address);
  ledger.omitMeta = true;
  const report = await run();
  assert.equal(report.action, "trade");
  const after = ledger.account(address);
  const gained = xlm(after.xlm - before.xlm) + xlm(after.usdc - before.usdc) / SDEX.ask;
  // Reported from the simulated output: within a hair of what really happened.
  assert.ok(Math.abs(report.profitXlm - gained) < 1e-4, `reported ${report.profitXlm}, gained ${gained}`);
});

// ─── When not to trade ───────────────────────────────────────────────────────

test("with the vault in line with the SDEX, nothing is sent", async () => {
  const { ledger, run } = world({ sdex: { bid: 0.1568, ask: 0.157 } });
  const report = await run();
  assert.equal(report.action, "none");
  assert.match(report.reason, /in line/);
  assert.deepEqual(sent(ledger), []);
  assert.equal(ledger.calls.includes("rpc sendTransaction"), false);
});

test("a round trip that would earn less than the floor is left alone", async () => {
  // 2.6% apart: the best trade (3.23 XLM) earns 0.0094 XLM before fees.
  const { ledger, run } = world({ sdex: { bid: 0.1553, ask: 0.1555 } });
  const report = await run();
  assert.equal(report.action, "none");
  assert.match(report.reason, /floor/);
  assert.deepEqual(sent(ledger), []);
  // With a floor under what it earns after fees (0.0072 XLM), the same trade goes ahead.
  const again = world({ sdex: { bid: 0.1553, ask: 0.1555 } });
  assert.equal((await again.run({ minProfitXlm: 0.005, minProfitBps: 0 })).action, "trade");
});

test("the floor is judged on the fee the simulation asks for", async () => {
  // The same 5.9% gap earns 0.3495 XLM before fees: a 0.34 XLM fee leaves it under the 0.02 floor.
  const costly = world({ resourceFee: 3_400_000n });
  const report = await costly.run();
  assert.equal(report.action, "none");
  assert.match(report.reason, /floor/);
  assert.deepEqual(sent(costly.ledger), []);
});

test("the profit must also be a share of the trade", async () => {
  // 0.3495 XLM on 16 XLM is 2.2%: a 300 bps floor refuses it, the 30 bps one takes it.
  const { ledger, run } = world();
  const report = await run({ live: false, keypair: undefined, minProfitBps: 300 });
  assert.equal(report.action, "none");
  assert.match(report.reason, /floor/);
  assert.deepEqual(sent(ledger), []);
});

test("live mode refuses a key that isn't the account's own, before reading anything", async () => {
  const { ledger, run } = world();
  const report = await run({ keypair: StellarSdk.Keypair.random() });
  assert.equal(report.action, "error");
  assert.match(report.error, /own key/);
  assert.deepEqual(ledger.calls, []);
});

test("an account that doesn't exist is an error that names it", async () => {
  const { address, run } = world({ funds: null });
  const report = await run({ live: false, keypair: undefined });
  assert.equal(report.action, "error");
  assert.ok(report.error.includes(address));
});

test("with no route on the SDEX, nothing is sent", async () => {
  const { ledger, run } = world();
  ledger.sdex = null;
  const report = await run();
  assert.equal(report.action, "error");
  assert.match(report.error, /route/);
  assert.deepEqual(sent(ledger), []);
});

// ─── The USDC trustline ──────────────────────────────────────────────────────

test("without a USDC trustline, a dry run says so and a live run adds it", async () => {
  const dry = world({ funds: { xlm: "500" } });
  const waiting = await dry.run({ live: false, keypair: undefined });
  assert.equal(waiting.action, "skip");
  assert.match(waiting.reason, /trustline/);
  assert.deepEqual(sent(dry.ledger), []);

  const live = world({ funds: { xlm: "500" } });
  const report = await live.run();
  assert.equal(report.action, "setup");
  assert.deepEqual(sent(live.ledger), ["changeTrust"]);
  assert.equal(live.ledger.account(live.address).usdc, 0n);
});

// ─── Rebalancing ─────────────────────────────────────────────────────────────

/** The share of the account's value held in USDC, at the SDEX mid. */
function usdcShare(account, sdex) {
  const mid = (sdex.bid + sdex.ask) / 2;
  const inUsdc = xlm(account.usdc);
  return inUsdc / (inUsdc + xlm(account.xlm) * mid);
}

test("with nothing to trade and almost no USDC, it converts back toward half and half", async () => {
  const sdex = { bid: 0.1595, ask: 0.1597 };
  const { ledger, address, run } = world({ sdex, funds: { xlm: "1000", usdc: "1" } });
  const report = await run();
  assert.equal(report.action, "rebalance", report.error ?? report.reason);
  assert.deepEqual(sent(ledger), ["pathPaymentStrictSend"]);
  assert.equal(ledger.submitted[0].op.sendAsset.isNative(), true);
  const share = usdcShare(ledger.account(address), sdex);
  assert.ok(share > 0.45 && share < 0.55, `USDC is ${(share * 100).toFixed(1)}% of the account`);
});

test("with nothing to trade and almost no XLM to spend, it converts USDC back", async () => {
  const sdex = { bid: 0.1595, ask: 0.1597 };
  // 12 XLM: 1.5 locked in reserves and 5 kept for fees leave 5.5 to spend.
  const { ledger, address, run } = world({ sdex, funds: { xlm: "12", usdc: "100" } });
  const report = await run();
  assert.equal(report.action, "rebalance", report.error ?? report.reason);
  assert.equal(ledger.submitted[0].op.sendAsset.getCode(), "USDC");
  const share = usdcShare(ledger.account(address), sdex);
  assert.ok(share > 0.45 && share < 0.55, `USDC is ${(share * 100).toFixed(1)}% of the account`);
});

test("a balanced account is left alone", async () => {
  const { ledger, run } = world({ sdex: { bid: 0.1595, ask: 0.1597 }, funds: { xlm: "500", usdc: "50" } });
  const report = await run();
  assert.equal(report.action, "none");
  assert.deepEqual(sent(ledger), []);
});

test("a rebalance at a price more than 1% under the going one is refused", async () => {
  const sdex = { bid: 0.1595, ask: 0.1597 };
  const { ledger, address, run } = world({ sdex, funds: { xlm: "1000", usdc: "1" } });
  const before = ledger.account(address);
  // A thin book: anything over 100 XLM sells 3% lower.
  const quote = ledger.sdexOut;
  ledger.sdexOut = (sellNative, amount) => {
    const out = quote(sellNative, amount);
    return sellNative && amount > units("100") ? (out * 97n) / 100n : out;
  };
  const report = await run();
  assert.equal(report.action, "none");
  assert.match(report.reason, /rebalanc/);
  assert.deepEqual(sent(ledger), []);
  assert.deepEqual(ledger.account(address), before);
});

test("a dry run reports the rebalance it would make and sends nothing", async () => {
  const { ledger, run } = world({ sdex: { bid: 0.1595, ask: 0.1597 }, funds: { xlm: "1000", usdc: "1" } });
  const report = await run({ live: false, keypair: undefined });
  assert.equal(report.action, "none");
  assert.match(report.reason, /rebalanc/);
  assert.deepEqual(sent(ledger), []);
});

// ─── Reading real results ────────────────────────────────────────────────────

const MAINNET = JSON.parse(readFileSync(new URL("./fixtures/arb-mainnet.json", import.meta.url), "utf8"));
const result = (b64) => StellarSdk.xdr.TransactionResult.fromXDR(b64, "base64");

test("a real vault swap's return value is read from its transaction meta", () => {
  const value = returnValueOf(MAINNET.vaultSwap.resultMetaXdr);
  assert.equal(StellarSdk.scValToNative(value), 19_790_716n); // 1.9790716 XLM, Nov 9, 2026
  assert.equal(returnValueOf(undefined), undefined);
  assert.equal(returnValueOf("not xdr"), undefined);
});

test("real SDEX path payments report what they delivered, both ways", () => {
  // The amounts are Horizon's own for the same two transactions.
  assert.equal(MAINNET.xlmToUsdc.received, "0.0285863");
  assert.equal(pathPaymentReceived(result(MAINNET.xlmToUsdc.resultXdr)), 285_863n);
  assert.equal(MAINNET.usdcToXlm.received, "0.0563571");
  assert.equal(pathPaymentReceived(result(MAINNET.usdcToXlm.resultXdr)), 563_571n);
  assert.equal(pathPaymentReceived(result(MAINNET.vaultSwap.resultXdr)), null);
  assert.equal(pathPaymentReceived(undefined), null);
});
