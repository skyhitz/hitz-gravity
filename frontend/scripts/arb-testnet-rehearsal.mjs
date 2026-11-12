#!/usr/bin/env node
// Rehearse the arbitrage bot's live path on Stellar testnet, with nothing of
// value: the vault's own mainnet bytecode, deployed fresh with test assets,
// a market maker's offers standing in for the SDEX, and a new bot account.
// The bot (functions/_lib/arb.ts) then runs live against it, and every step
// is checked against the balances the network reports.
//
//   node --experimental-strip-types scripts/arb-testnet-rehearsal.mjs
//
// It walks the bot through:
//   1. a dry run (nothing sent);
//   2. adding its USDC trustline;
//   3. converting half its XLM to USDC (rebalance);
//   4. a round trip selling XLM into the vault (SDEX leg first);
//   5. a buy-back quoted 3% better than the SDEX really pays: the SDEX leg
//      must fail on chain and the vault must stay untouched;
//   6. with the market moved above the vault, a round trip selling USDC.
//
// Every account is new and funded by friendbot; run it as often as you like.
// Environment: TESTNET_RPC_URL, TESTNET_HORIZON_URL, MAINNET_RPC_URL.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { DEFAULTS, runOnce } from "../functions/_lib/arb.ts";

const RPC = process.env.TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON = (process.env.TESTNET_HORIZON_URL ?? "https://horizon-testnet.stellar.org").replace(/\/$/, "");
const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://soroban-rpc.mainnet.stellar.gateway.fm";
const MAINNET_VAULT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";
const PASSPHRASE = StellarSdk.Networks.TESTNET;
const { xdr } = StellarSdk;

const UNIT = 10_000_000n;
const units = (decimal) => {
  const [w, f = ""] = String(decimal).split(".");
  return BigInt(w) * UNIT + BigInt((f + "0000000").slice(0, 7));
};
const show = (raw) => (Number(raw) / 1e7).toFixed(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(...parts);

// ─── Plumbing: JSON-RPC and Horizon over fetch, like the bot itself ──────────

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
      return body.result;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(1500);
    }
  }
}

async function horizon(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HORIZON}${path}`, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (attempt >= 4) throw new Error(`horizon ${path}: HTTP ${res.status}`);
    await sleep(1500);
  }
}

async function sequenceOf(address) {
  return (await horizon(`/accounts/${address}`)).sequence;
}

/** Build, (simulate,) sign, send and wait for one transaction. Returns its Soroban return value, if any. */
async function send(what, keypair, operation, { soroban = false } = {}) {
  const account = new StellarSdk.Account(keypair.publicKey(), await sequenceOf(keypair.publicKey()));
  let tx = new StellarSdk.TransactionBuilder(account, { fee: soroban ? "1000000" : "10000", networkPassphrase: PASSPHRASE }).addOperation(operation).setTimeout(120).build();
  if (soroban) {
    const sim = StellarSdk.rpc.parseRawSimulation(await rpc(RPC, "simulateTransaction", { transaction: tx.toXDR() }));
    if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`${what}: simulation failed: ${sim.error.split("\n")[0]}`);
    tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  }
  tx.sign(keypair);
  const sent = await rpc(RPC, "sendTransaction", { transaction: tx.toXDR() });
  if (sent.status === "ERROR") throw new Error(`${what}: rejected (${sent.errorResultXdr})`);
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const res = await rpc(RPC, "getTransaction", { hash: sent.hash });
    if (res.status === "NOT_FOUND") continue;
    if (res.status !== "SUCCESS") throw new Error(`${what}: ${res.status} (${res.resultXdr})`);
    log(`  ok  ${what}`);
    try {
      const meta = xdr.TransactionMeta.fromXDR(res.resultMetaXdr, "base64");
      return (meta.switch() === 4 ? meta.v4().sorobanMeta() : meta.v3().sorobanMeta())?.returnValue();
    } catch {
      return undefined;
    }
  }
  throw new Error(`${what}: no result after 90 seconds`);
}

async function friendbot(keypair, name) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot ${name}: HTTP ${res.status}`);
  log(`  ok  ${name} ${keypair.publicKey()}`);
}

async function balances(address, usdc) {
  const acct = await horizon(`/accounts/${address}`);
  const of = (match) => units(acct.balances.find(match)?.balance ?? "0");
  return { xlm: of((b) => b.asset_type === "native"), usdc: of((b) => b.asset_code === "USDC" && b.asset_issuer === usdc.getIssuer()), trustline: acct.balances.some((b) => b.asset_code === "USDC") };
}

async function vaultPools(vault, viewer) {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(viewer, "0"), { fee: "100", networkPassphrase: PASSPHRASE }).addOperation(new StellarSdk.Contract(vault).call("pools")).setTimeout(30).build();
  const sim = StellarSdk.rpc.parseRawSimulation(await rpc(RPC, "simulateTransaction", { transaction: tx.toXDR() }));
  return StellarSdk.scValToNative(sim.result.retval).map((p) => ({ asset: String(p.asset), hitz: BigInt(p.hitz), reserve: BigInt(p.reserve), dislocation: BigInt(p.dislocation), fee: BigInt(p.fee) }));
}

const vaultRate = ([x, u]) => Number(u.reserve) / Number(u.hitz) / (Number(x.reserve) / Number(x.hitz));

/**
 * Wait until Horizon's path finder quotes the maker's market both ways, three
 * looks in a row: testnet's Horizon is several servers, and each trails the
 * ledger by its own moment.
 */
async function marketAt(usdc, bid, ask) {
  const dest = encodeURIComponent(`USDC:${usdc.getIssuer()}`);
  const best = async (query) => Math.max(0, ...(await horizon(`/paths/strict-send?${query}`))._embedded.records.map((r) => Number(r.destination_amount)));
  let seen = 0;
  for (let i = 0; i < 60 && seen < 3; i++) {
    const sold = await best(`source_asset_type=native&source_amount=10&destination_assets=${dest}`);
    const bought = await best(`source_asset_type=credit_alphanum4&source_asset_code=USDC&source_asset_issuer=${usdc.getIssuer()}&source_amount=1.5&destination_assets=native`);
    seen = Math.abs(sold / 10 - bid) < 0.00005 && bought > 0 && Math.abs(1.5 / bought - ask) < 0.00005 ? seen + 1 : 0;
    await sleep(1500);
  }
  if (seen < 3) throw new Error(`Horizon never settled on the maker's ${bid} / ${ask}`);
  log(`  ok  Horizon quotes XLM at ${bid} / ${ask} USDC`);
}

// ─── The world ───────────────────────────────────────────────────────────────

log("1. accounts (friendbot)");
const admin = StellarSdk.Keypair.random();
const issuer = StellarSdk.Keypair.random();
const maker = StellarSdk.Keypair.random();
const bot = StellarSdk.Keypair.random();
await Promise.all([friendbot(admin, "admin "), friendbot(issuer, "issuer"), friendbot(maker, "maker "), friendbot(bot, "bot   ")]);

const XLM = StellarSdk.Asset.native();
const USDC = new StellarSdk.Asset("USDC", issuer.publicKey());
const HITZ = new StellarSdk.Asset("HITZ", issuer.publicKey());
const sac = { XLM: XLM.contractId(PASSPHRASE), USDC: USDC.contractId(PASSPHRASE), HITZ: HITZ.contractId(PASSPHRASE) };
const address = (a) => StellarSdk.Address.fromString(a).toScVal();
const i128 = (v) => StellarSdk.nativeToScVal(v, { type: "i128" });

log("2. test assets: USDC and a stand-in HITZ, with their contracts");
for (const asset of [USDC, HITZ]) {
  await send(`admin trusts ${asset.getCode()}`, admin, StellarSdk.Operation.changeTrust({ asset }));
}
await send("maker trusts USDC", maker, StellarSdk.Operation.changeTrust({ asset: USDC }));
await send("issue 60,000,000 HITZ to the admin", issuer, StellarSdk.Operation.payment({ destination: admin.publicKey(), asset: HITZ, amount: "60000000" }));
await send("issue 2,000 USDC to the admin", issuer, StellarSdk.Operation.payment({ destination: admin.publicKey(), asset: USDC, amount: "2000" }));
await send("issue 5,000 USDC to the maker", issuer, StellarSdk.Operation.payment({ destination: maker.publicKey(), asset: USDC, amount: "5000" }));
for (const asset of [USDC, HITZ]) {
  await send(`deploy the ${asset.getCode()} asset contract`, admin, StellarSdk.Operation.createStellarAssetContract({ asset }), { soroban: true });
}

log("3. the vault: mainnet's bytecode, deployed fresh");
const instance = await rpc(MAINNET_RPC, "getLedgerEntries", { keys: [xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: StellarSdk.Address.fromString(MAINNET_VAULT).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() })).toXDR("base64")] });
const wasmHash = xdr.LedgerEntryData.fromXDR(instance.entries[0].xdr, "base64").contractData().val().instance().executable().wasmHash();
const code = await rpc(MAINNET_RPC, "getLedgerEntries", { keys: [xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash })).toXDR("base64")] });
const wasm = xdr.LedgerEntryData.fromXDR(code.entries[0].xdr, "base64").contractCode().code();
assert.equal(createHash("sha256").update(wasm).digest("hex"), wasmHash.toString("hex"));
log(`  ok  ${wasm.length} bytes, sha256 ${wasmHash.toString("hex")}`);
await send("upload it to testnet", admin, StellarSdk.Operation.uploadContractWasm({ wasm }), { soroban: true });
const created = await send(
  "create the vault (admin, HITZ, [XLM, USDC])",
  admin,
  StellarSdk.Operation.createCustomContract({
    address: StellarSdk.Address.fromString(admin.publicKey()),
    wasmHash,
    salt: randomBytes(32),
    constructorArgs: [address(admin.publicKey()), address(sac.HITZ), xdr.ScVal.scvVec([address(sac.XLM), address(sac.USDC)])],
  }),
  { soroban: true }
);
const vault = StellarSdk.Address.fromScVal(created).toString();
log(`  vault ${vault}`);

// Six tenths of mainnet's depth on Nov 11, 2026, priced at 0.16 USDC per XLM.
const seedXlm = { hitz: units("30581634.4901746"), amount: units("6516.0497591") };
const seedUsdc = { hitz: units("22470650.6991633"), amount: units("766.04") };
const vaultCall = (name, ...args) => new StellarSdk.Contract(vault).call(name, ...args);
await send("seed the XLM pool", admin, vaultCall("seed", address(sac.XLM), i128(seedXlm.hitz), i128(seedXlm.amount)), { soroban: true });
await send("seed the USDC pool", admin, vaultCall("seed", address(sac.USDC), i128(seedUsdc.hitz), i128(seedUsdc.amount)), { soroban: true });
log(`  the vault prices XLM at ${vaultRate(await vaultPools(vault, admin.publicKey())).toFixed(6)} USDC`);

log("4. the SDEX: a maker quoting XLM at 0.1498 / 0.1502 USDC");
const offer = (selling, buying, amount, price, offerId = "0") => StellarSdk.Operation.manageSellOffer({ selling, buying, amount, price, offerId });
await send("maker offers 3,000 XLM at 0.1502", maker, offer(XLM, USDC, "3000", "0.1502"));
await send("maker bids for XLM at 0.1498 with 600 USDC", maker, offer(USDC, XLM, "600", { n: 10_000, d: 1_498 }));
// The bot keeps 200 XLM: a real one is funded small.
await send("bot returns 9,790 XLM to the maker", bot, StellarSdk.Operation.payment({ destination: maker.publicKey(), asset: XLM, amount: "9790" }));
await marketAt(USDC, 0.1498, 0.1502);

// ─── The bot ─────────────────────────────────────────────────────────────────

const config = (over = {}) => ({
  rpcUrl: RPC,
  horizonUrl: HORIZON,
  networkPassphrase: PASSPHRASE,
  vault,
  hitz: sac.HITZ,
  usdcIssuer: issuer.publicKey(),
  address: bot.publicKey(),
  keypair: bot,
  live: true,
  ...DEFAULTS,
  ...over,
});
const state = async () => ({ ...(await balances(bot.publicKey(), USDC)), pools: await vaultPools(vault, bot.publicKey()) });
const brief = (r) => JSON.stringify({ action: r.action, reason: r.reason, error: r.error, gapPct: r.gapPct, plan: r.plan, hedgeLeg: r.hedgeLeg, vaultLeg: r.vaultLeg, setupLeg: r.setupLeg, profit: r.profit, profitXlm: r.profitXlm }, null, 1);
async function step(title, over, check) {
  log(`\n${title}`);
  const before = await state();
  let started = Date.now();
  let report = await runOnce(config(over));
  // One of Horizon's servers may still be a ledger behind the maker's offers: that run sent nothing.
  for (let again = 0; again < 3 && report.action === "error" && /no XLM\/USDC route/.test(report.error); again++) {
    log(`  (Horizon had no route yet: running again)`);
    await sleep(5000);
    started = Date.now();
    report = await runOnce(config(over));
  }
  log(brief(report));
  await sleep(6000); // let Horizon catch up with the last ledger
  const after = await state();
  log(`  took ${((Date.now() - started) / 1000).toFixed(1)} s · XLM ${show(before.xlm)} → ${show(after.xlm)} · USDC ${show(before.usdc)} → ${show(after.usdc)} · vault ${vaultRate(before.pools).toFixed(6)} → ${vaultRate(after.pools).toFixed(6)}`);
  check(report, before, after);
  log("  ok");
  return report;
}
const samePools = (a, b) => assert.deepEqual(a.pools.map((p) => [p.hitz, p.reserve]), b.pools.map((p) => [p.hitz, p.reserve]), "the vault's reserves changed");

log("\n5. the bot, live on testnet");
await step("5.1 a dry run plans and sends nothing", { live: false, keypair: undefined }, (r, before, after) => {
  assert.equal(r.action, "skip");
  assert.match(r.reason, /trustline/);
  assert.equal(after.xlm, before.xlm);
});

await step("5.2 a live run adds the USDC trustline", {}, (r, before, after) => {
  assert.equal(r.action, "setup", r.error);
  assert.equal(after.trustline, true);
  assert.equal(before.xlm - after.xlm, 100n, "one classic fee");
  samePools(before, after);
});

await step("5.3 with no USDC it can't fund a round trip, so it converts half its XLM", {}, (r, before, after) => {
  assert.equal(r.action, "rebalance", r.error ?? r.reason);
  assert.ok(after.usdc > 0n);
  assert.equal(units(r.hedgeLeg.received), after.usdc - before.usdc, "reported what the network delivered");
  samePools(before, after);
});

const first = await step("5.4 the vault pays more for XLM than the SDEX: buy XLM back on the SDEX, then sell XLM into the vault", {}, (r, before, after) => {
  assert.equal(r.action, "trade", r.error ?? r.reason);
  assert.equal(r.plan.sell, "XLM");
  assert.equal(r.hedgeLeg.status, "SUCCESS");
  assert.equal(r.vaultLeg.status, "SUCCESS");
  assert.ok(after.usdc >= before.usdc, "USDC is whole");
  assert.ok(after.xlm > before.xlm, "XLM grew");
  // The report against the network's own balances: XLM in from the SDEX, out to the vault, less both fees.
  const fees = units(r.hedgeLeg.feeXlm) + units(r.vaultLeg.feeXlm);
  assert.equal(after.xlm - before.xlm, units(r.hedgeLeg.received) - units(r.plan.amountIn) - fees);
  assert.equal(after.usdc - before.usdc, units(r.vaultLeg.received) - units(r.plan.hedgeIn));
  assert.ok(vaultRate(after.pools) < vaultRate(before.pools), "the vault's XLM price came down toward the SDEX");
  assert.ok(Math.abs(r.profitXlm - r.plan.profitXlm) < 0.01, "realized close to planned");
});

await step("5.5 a buy-back quoted 3% better than the SDEX pays: the SDEX leg fails, the vault is never touched", {
  minProfitXlm: 0,
  minProfitBps: 0,
  io: {
    // A glitched quote for the exact-size request only: the small reference quotes stay true.
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      const url = new URL(input);
      if (url.pathname !== "/paths/strict-send" || ["10", "1.5"].includes(url.searchParams.get("source_amount"))) return res;
      const body = await res.json();
      for (const record of body._embedded.records) record.destination_amount = (Number(record.destination_amount) * 1.03).toFixed(7);
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  },
}, (r, before, after) => {
  assert.equal(r.action, "missed", r.error ?? r.reason);
  assert.equal(r.hedgeLeg.status, "FAILED");
  assert.match(r.hedgeLeg.code, /UnderDestmin/);
  assert.equal(r.vaultLeg, undefined);
  assert.equal(after.usdc, before.usdc);
  assert.equal(before.xlm - after.xlm, 100n, "only the failed transaction's fee is gone");
  samePools(before, after);
});

log("\n6. the market moves above the vault: the maker now quotes 0.1718 / 0.1722");
const offers = (await horizon(`/accounts/${maker.publicKey()}/offers`))._embedded.records;
for (const o of offers) {
  const asset = (a) => (a.asset_type === "native" ? XLM : USDC);
  await send(`maker cancels offer ${o.id}`, maker, offer(asset(o.selling), asset(o.buying), "0", o.price_r, o.id));
}
await send("maker offers 3,000 XLM at 0.1722", maker, offer(XLM, USDC, "3000", "0.1722"));
await send("maker bids for XLM at 0.1718 with 600 USDC", maker, offer(USDC, XLM, "600", { n: 10_000, d: 1_718 }));
await marketAt(USDC, 0.1718, 0.1722);

await step("6.1 the vault pays less for XLM than the SDEX: sell XLM on the SDEX, then USDC into the vault", {}, (r, before, after) => {
  assert.equal(r.action, "trade", r.error ?? r.reason);
  assert.equal(r.plan.sell, "USDC");
  assert.ok(after.usdc > before.usdc, "USDC grew");
  const fees = units(r.hedgeLeg.feeXlm) + units(r.vaultLeg.feeXlm);
  assert.equal(after.usdc - before.usdc, units(r.hedgeLeg.received) - units(r.plan.amountIn));
  assert.equal(after.xlm - before.xlm, units(r.vaultLeg.received) - units(r.plan.hedgeIn) - fees);
  assert.ok(after.xlm >= before.xlm - fees, "XLM is whole but for the fees");
  assert.ok(vaultRate(after.pools) > vaultRate(before.pools), "the vault's XLM price came up toward the SDEX");
});

log(`\nRehearsal passed. First round trip: ${first.profitXlm} XLM on ${first.plan.amountIn} XLM sold.`);
log(`Bot ${bot.publicKey()} · vault ${vault} (testnet)`);
