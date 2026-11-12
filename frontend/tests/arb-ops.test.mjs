// One cron run of the arbitrage bot (functions/_lib/arb-ops.ts): the mode and
// key checks, the D1 log, the last run in KV, the guards that pause it and
// the public status. The network is the simulated one of helpers/ledger.mjs,
// D1 is the Worker's own migrations in SQLite, and nothing is mocked but the
// operator's inbox.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as StellarSdk from "@stellar/stellar-sdk";
import { botStatus, runBot } from "../functions/_lib/arb-ops.ts";
import { testDb } from "./helpers/d1.mjs";
import { fakeKv } from "./helpers/kv.mjs";
import { HITZ, makeLedger, PASSPHRASE, units, USDC_ISSUER, USDC_SAC, VAULT, XLM_SAC } from "./helpers/ledger.mjs";

/** The SDEX on Nov 11, 2026: the vault paid 5.9% more for XLM. */
const SDEX = { bid: 0.1503063, ask: 0.150481 };
/** The SDEX where the vault is: nothing to trade. */
const IN_LINE = { bid: 0.1595, ask: 0.1597 };

function setup({ sdex = SDEX, funds = { xlm: "500", usdc: "50" } } = {}) {
  const ledger = makeLedger(sdex);
  const keypair = StellarSdk.Keypair.random();
  if (funds) ledger.fund(keypair.publicKey(), funds);
  const mails = [];
  const deps = {
    db: testDb(),
    kv: fakeKv(),
    notify: async (subject, text) => {
      mails.push({ subject, text });
    },
    io: ledger.io,
  };
  const vars = (over = {}) => ({
    mode: "live",
    address: keypair.publicKey(),
    secret: keypair.secret(),
    rpcUrl: "https://rpc.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: PASSPHRASE,
    vault: VAULT,
    hitz: HITZ,
    usdcIssuer: USDC_ISSUER,
    statusUrl: "https://skyhitz.io/api/v1/bot",
    ...over,
  });
  const rows = () => deps.db.raw.prepare("SELECT * FROM arb_runs ORDER BY id").all().map((r) => ({ ...r }));
  const at = (secondsAgo) => new Date(ledger.io.now() - secondsAgo * 1000).toISOString();
  /** A past row, as an earlier run would have logged it. */
  const logged = (action, { secondsAgo = 3600, mode = "live", profit = null } = {}) =>
    deps.db.raw.prepare("INSERT INTO arb_runs (at, mode, action, profit_xlm, report) VALUES (?, ?, ?, ?, '{}')").run(at(secondsAgo), mode, action, profit);
  return { ledger, keypair, address: keypair.publicKey(), mails, deps, vars, rows, logged, run: (over) => runBot(deps, vars(over)) };
}

// ─── A run ───────────────────────────────────────────────────────────────────

test("a live cron run trades and logs the round trip", async () => {
  const w = setup();
  const summary = await w.run();
  assert.equal(summary.action, "trade", summary.error ?? summary.reason);
  const [hedge, vault] = w.ledger.submitted;
  assert.equal(summary.hedgeTx, hedge.hash);
  assert.equal(summary.vaultTx, vault.hash);

  const rows = w.rows();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.mode, "live");
  assert.equal(row.action, "trade");
  assert.equal(row.sell, "XLM");
  assert.equal(row.hedge_tx, hedge.hash);
  assert.equal(row.vault_tx, vault.hash);
  assert.equal(units(row.amount_in), vault.call.amountIn);
  assert.equal(units(row.vault_out), vault.received);
  assert.equal(units(row.hedge_out), hedge.received);
  // 0.34953 XLM before fees (brute force over the vault math), less 0.0021752 XLM of fees.
  assert.ok(Math.abs(row.profit_xlm - 0.34735) < 0.0005, `logged ${row.profit_xlm} XLM`);
  assert.ok(Math.abs(row.gap_pct - 6.102) < 0.01, `logged a ${row.gap_pct}% gap`);
  assert.equal(JSON.parse(row.report).vaultLeg.hash, vault.hash);
  assert.equal((await w.deps.kv.get("arb:last", { type: "json" })).action, "trade");
  assert.deepEqual(w.mails, []);
});

test("a dry run logs what it would do and sends nothing", async () => {
  const w = setup();
  const summary = await w.run({ mode: "dry-run", secret: undefined });
  assert.equal(summary.action, "would-trade");
  assert.equal(summary.mode, "dry-run");
  assert.deepEqual(w.ledger.submitted, []);
  const [row] = w.rows();
  assert.equal(row.mode, "dry-run");
  assert.equal(row.action, "would-trade");
  assert.equal(row.sell, "XLM");
  assert.equal(row.vault_tx, null);
  assert.ok(Math.abs(Number(row.amount_in) - 16.02) < 0.05, `planned ${row.amount_in} XLM`);
});

test("a quiet run is kept as the last run and not logged", async () => {
  const w = setup({ sdex: IN_LINE });
  assert.equal((await w.run()).action, "none");
  assert.deepEqual(w.rows(), []);
  const last = await w.deps.kv.get("arb:last", { type: "json" });
  assert.equal(last.action, "none");
  assert.match(last.reason, /in line/);
});

test("switched off, or without a valid address, nothing runs", async () => {
  for (const over of [{ mode: "off" }, { mode: undefined }, { address: "" }, { address: "not an address" }, { address: undefined }]) {
    const w = setup();
    const summary = await w.run(over);
    assert.ok(summary.skipped, JSON.stringify(over));
    assert.deepEqual(w.ledger.calls, []);
    assert.deepEqual(w.rows(), []);
    assert.deepEqual(w.deps.kv.keys(), []);
  }
});

test("live without the key runs as a dry run and says why", async () => {
  const w = setup();
  const summary = await w.run({ secret: undefined });
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.action, "would-trade");
  assert.match(summary.reason, /ARB_BOT_SECRET/);
  assert.deepEqual(w.ledger.submitted, []);
});

test("a key that isn't a secret key is never used: dry run", async () => {
  const w = setup();
  const summary = await w.run({ secret: "definitely-not-a-key" });
  assert.equal(summary.mode, "dry-run");
  assert.match(summary.reason, /valid secret key/);
  assert.deepEqual(w.ledger.submitted, []);
  // The bad value is never echoed.
  assert.equal(JSON.stringify([summary, w.rows(), w.mails]).includes("definitely-not-a-key"), false);
});

test("a key for another account is refused: dry run, and the operator hears once a day", async () => {
  const w = setup();
  const stranger = StellarSdk.Keypair.random();
  for (let i = 0; i < 2; i++) {
    const summary = await w.run({ secret: stranger.secret() });
    assert.equal(summary.mode, "dry-run");
    assert.match(summary.reason, /another account/);
  }
  assert.deepEqual(w.ledger.submitted, []);
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0].subject, /key/);
  assert.equal(JSON.stringify([w.rows(), w.mails]).includes(stranger.secret()), false);
});

// ─── The log ─────────────────────────────────────────────────────────────────

test("the same error in a row is logged once; a different one is logged again", async () => {
  const w = setup();
  w.ledger.horizonDown = () => true;
  await w.run();
  await w.run();
  assert.equal(w.rows().length, 1);
  assert.equal(w.rows()[0].action, "error");
  w.ledger.horizonDown = null;
  w.ledger.sdex = null; // no route: another error
  await w.run();
  assert.equal(w.rows().length, 2);
});

test("every buy-back that misses is logged, with its transaction", async () => {
  const w = setup();
  w.ledger.onSubmit = (entry) => {
    if (entry.type === "pathPaymentStrictSend") w.ledger.sdex = { bid: 0.1548, ask: 0.155 };
  };
  await w.run();
  w.ledger.sdex = SDEX;
  await w.run();
  const rows = w.rows();
  assert.deepEqual(rows.map((r) => r.action), ["missed", "missed"]);
  assert.deepEqual(rows.map((r) => r.hedge_tx), w.ledger.submitted.map((e) => e.hash));
  assert.deepEqual(rows.map((r) => r.vault_tx), [null, null]);
  assert.deepEqual(rows.map((r) => r.profit_xlm), [null, null]);
});

// ─── Guards ──────────────────────────────────────────────────────────────────

/** The next run ends with the buy-back done and the vault leg failed. */
function incompleteNext(w) {
  w.ledger.onApplied = (entry) => {
    if (entry.type === "pathPaymentStrictSend") w.ledger.swapAsOther(XLM_SAC, USDC_SAC, "30");
  };
}

test("a third incomplete trade in a day pauses the bot for 24 hours and tells the operator", async () => {
  const w = setup();
  w.logged("trade-incomplete", { secondsAgo: 20 * 3600 });
  w.logged("trade-incomplete", { secondsAgo: 2 * 3600 });
  incompleteNext(w);
  const summary = await w.run();
  assert.equal(summary.action, "trade-incomplete");
  assert.match(await w.deps.kv.get("arb:paused"), /3 round trips/);
  assert.equal(w.deps.kv.ttl("arb:paused"), 86_400);
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0].subject, /paused/);
  assert.match(w.mails[0].text, /https:\/\/skyhitz\.io\/api\/v1\/bot/);

  // Paused: the next run reads nothing and sends nothing.
  const calls = w.ledger.calls.length;
  const next = await w.run();
  assert.match(next.skipped, /paused/);
  assert.equal(w.ledger.calls.length, calls);
});

test("incomplete trades older than a day, or from dry runs, don't count toward the pause", async () => {
  const w = setup();
  for (const hours of [25, 30]) w.logged("trade-incomplete", { secondsAgo: hours * 3600 });
  for (const hours of [1, 2]) w.logged("trade-incomplete", { secondsAgo: hours * 3600, mode: "dry-run" });
  incompleteNext(w);
  assert.equal((await w.run()).action, "trade-incomplete");
  assert.equal(await w.deps.kv.get("arb:paused"), null);
  assert.deepEqual(w.mails, []);
});

test("a day's realized loss beyond 2 XLM pauses the bot", async () => {
  const w = setup();
  w.logged("trade", { profit: -2.4 });
  assert.equal((await w.run()).action, "trade"); // +0.35 XLM: the day stands at -2.05
  assert.match(await w.deps.kv.get("arb:paused"), /-2\.05/);
  assert.equal(w.mails.length, 1);
});

test("a day that is ahead doesn't pause", async () => {
  const w = setup();
  w.logged("trade", { profit: -1.9 });
  assert.equal((await w.run()).action, "trade");
  assert.equal(await w.deps.kv.get("arb:paused"), null);
});

test("twelve failing live runs in a row pause the bot; a run that works starts the count again", async () => {
  const w = setup({ sdex: IN_LINE });
  const failing = async (n) => {
    w.ledger.horizonDown = () => true;
    for (let i = 0; i < n; i++) assert.equal((await w.run()).action, "error");
    w.ledger.horizonDown = null;
  };
  await failing(11);
  assert.equal(await w.deps.kv.get("arb:paused"), null);
  assert.equal((await w.run()).action, "none");
  await failing(11);
  assert.equal(await w.deps.kv.get("arb:paused"), null);
  await failing(1);
  assert.match(await w.deps.kv.get("arb:paused"), /12 runs in a row failed/);
  assert.equal(w.mails.length, 1);
});

test("failing dry runs never pause", async () => {
  const w = setup();
  w.ledger.horizonDown = () => true;
  for (let i = 0; i < 15; i++) await w.run({ mode: "dry-run", secret: undefined });
  assert.equal(await w.deps.kv.get("arb:paused"), null);
  assert.deepEqual(w.mails, []);
});

test("low funds tell the operator once a day", async () => {
  // 20 XLM: 1.5 in reserves and 5 for fees leave 13.5 to spend, under the 30 XLM line.
  const w = setup({ sdex: IN_LINE, funds: { xlm: "20", usdc: "2.2" } });
  await w.run();
  await w.run();
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0].subject, /low funds/);
  assert.match(w.mails[0].text, /13\.5 XLM/);
  assert.ok(w.mails[0].text.includes(w.address));
});

test("an alert that couldn't be sent is tried again on the next run", async () => {
  const w = setup({ sdex: IN_LINE, funds: { xlm: "20", usdc: "2.2" } });
  let down = true;
  const sent = [];
  w.deps.notify = async (subject) => {
    if (down) throw new Error("mail is down");
    sent.push(subject);
  };
  await w.run();
  down = false;
  await w.run();
  assert.equal(sent.length, 1);
});

// ─── Public status ───────────────────────────────────────────────────────────

test("the status shows the account, the mode, the last run, totals and recent actions with explorer links", async () => {
  const w = setup();
  await w.run();
  const [hedge, vault] = w.ledger.submitted;
  const status = await botStatus(w.deps, w.vars());
  assert.equal(status.address, w.address);
  assert.equal(status.explorer, `https://stellar.expert/explorer/public/account/${w.address}`);
  assert.equal(status.mode, "live");
  assert.equal(status.paused, null);
  assert.equal(status.last_run.action, "trade");
  assert.ok(Math.abs(status.last_run.gap_pct - 6.102) < 0.01);
  assert.deepEqual(status.last_run.sdex, { bid: 0.1503063, ask: 0.150481 });
  for (const window of ["24h", "7d", "all"]) {
    assert.equal(status.totals[window].trades, 1, window);
    assert.ok(Math.abs(status.totals[window].profit_xlm - 0.34735) < 0.0005, window);
  }
  assert.equal(status.recent.length, 1);
  assert.equal(status.recent[0].action, "trade");
  assert.equal(status.recent[0].vault_tx, `https://stellar.expert/explorer/public/tx/${vault.hash}`);
  assert.equal(status.recent[0].hedge_tx, `https://stellar.expert/explorer/public/tx/${hedge.hash}`);
  assert.deepEqual(status.settings, { min_profit_xlm: 0.02, min_profit_bps: 30, max_trade_xlm: 150 });
  // Nothing of the key, ever.
  assert.equal(JSON.stringify(status).includes(w.keypair.secret()), false);
});

test("totals count finished live trades only, each in its window", async () => {
  const w = setup({ sdex: IN_LINE });
  w.logged("trade", { secondsAgo: 3600, profit: 0.5 });
  w.logged("trade", { secondsAgo: 3 * 86_400, profit: 0.25 });
  w.logged("trade", { secondsAgo: 30 * 86_400, profit: 1 });
  w.logged("trade", { secondsAgo: 60, mode: "dry-run", profit: 9 });
  w.logged("would-trade", { secondsAgo: 60, mode: "dry-run", profit: 9 });
  w.logged("trade-incomplete", { secondsAgo: 60 });
  w.logged("missed", { secondsAgo: 60 });
  const status = await botStatus(w.deps, w.vars());
  assert.deepEqual(status.totals, { "24h": { trades: 1, profit_xlm: 0.5 }, "7d": { trades: 2, profit_xlm: 0.75 }, all: { trades: 3, profit_xlm: 1.75 } });
  assert.equal(status.recent.length, 7);
  assert.equal(status.last_run, null);
});

test("the status tells off from dry-run from live, and shows a pause", async () => {
  const w = setup();
  assert.equal((await botStatus(w.deps, w.vars({ mode: "off" }))).mode, "off");
  assert.equal((await botStatus(w.deps, w.vars({ address: "" }))).mode, "off");
  assert.equal((await botStatus(w.deps, w.vars({ address: "" }))).address, null);
  assert.equal((await botStatus(w.deps, w.vars({ mode: "dry-run" }))).mode, "dry-run");
  assert.equal((await botStatus(w.deps, w.vars({ secret: undefined }))).mode, "dry-run");
  assert.equal((await botStatus(w.deps, w.vars())).mode, "live");
  // Live is what it does, not what was asked for: a key it can't trade with means dry runs.
  assert.equal((await botStatus(w.deps, w.vars({ secret: StellarSdk.Keypair.random().secret() }))).mode, "dry-run");
  assert.equal((await botStatus(w.deps, w.vars({ secret: "definitely-not-a-key" }))).mode, "dry-run");
  await w.deps.kv.put("arb:paused", "3 round trips stopped halfway in 24 hours (since 2026-11-11T00:00:00.000Z)");
  assert.match((await botStatus(w.deps, w.vars())).paused, /3 round trips/);
});

test("the floor and the cap can be set, and a bad value falls back to the default", async () => {
  // 0.3495 XLM before fees: a floor of 0.5 XLM leaves it alone.
  const strict = setup();
  assert.equal((await strict.run({ minProfitXlm: "0.5" })).action, "none");
  assert.deepEqual(strict.ledger.submitted, []);
  assert.equal((await botStatus(strict.deps, strict.vars({ minProfitXlm: "0.5", maxTradeXlm: "40" }))).settings.min_profit_xlm, 0.5);
  assert.equal((await botStatus(strict.deps, strict.vars({ minProfitXlm: "0.5", maxTradeXlm: "40" }))).settings.max_trade_xlm, 40);

  const capped = setup();
  await capped.run({ maxTradeXlm: "5" });
  const sold = capped.ledger.submitted[1].call.amountIn;
  assert.ok(sold <= units("5") && sold > units("4.99"), `sold ${sold} stroops with a 5 XLM cap`);

  const typo = setup();
  assert.equal((await typo.run({ minProfitXlm: "abc", maxTradeXlm: "" })).action, "trade");
  assert.ok(typo.ledger.submitted[1].call.amountIn > units("15"));
  assert.equal(typo.ledger.submitted[1].call.tokenOut, USDC_SAC);

  // A negative floor would trade at a loss, and a cap of zero would never trade: both are ignored.
  // 2.8% apart, the best trade (4.20 XLM) earns 0.0144 XLM after fees: 0.34% of it, but under the default 0.02.
  const negative = setup({ sdex: { bid: 0.155, ask: 0.1552 } });
  assert.equal((await negative.run({ minProfitXlm: "-1" })).action, "none");
  assert.deepEqual(negative.ledger.submitted, []);
  const zero = setup();
  assert.equal((await zero.run({ maxTradeXlm: "0" })).action, "trade");
});
