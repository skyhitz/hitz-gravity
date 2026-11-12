#!/usr/bin/env node
// Run the vault ↔ SDEX arbitrage bot yourself: the same code Skyhitz runs in
// its Worker cron (functions/_lib/arb.ts). Strategy: ../ARB_BOT.md.
//
// From frontend/ (after `pnpm install`), with Node 22.6 or later:
//
//   # Dry run: plan and simulate for any funded account, send nothing.
//   node --experimental-strip-types scripts/arb-bot.mjs --address G…
//
//   # Live, every 5 minutes, with your own account's key in the environment.
//   ARB_BOT_SECRET=S… node --experimental-strip-types scripts/arb-bot.mjs --live --every 300
//
// Options:
//   --address G…        account to plan for (defaults to the key's account)
//   --live              sign and send (needs ARB_BOT_SECRET)
//   --every <seconds>   keep running at this interval (default: run once)
//   --min-profit <xlm>  smallest profit worth a trade, after fees (default 0.02)
//   --max-trade <xlm>   largest trade, in XLM or its USDC value (default 150)
// Environment: ARB_BOT_SECRET, RPC_URL, HORIZON_URL.
//
// The account needs XLM. A live run adds the USDC trustline if it is missing
// and converts half the XLM to USDC on the SDEX, since a round trip uses
// both: it buys back on the SDEX the asset the vault overpays for, then
// sells it into the vault.

import { Keypair } from "@stellar/stellar-sdk";
import { DEFAULTS, runOnce } from "../functions/_lib/arb.ts";

const MAINNET = {
  rpcUrl: process.env.RPC_URL ?? "https://soroban-rpc.mainnet.stellar.gateway.fm",
  horizonUrl: (process.env.HORIZON_URL ?? "https://horizon.stellar.org").replace(/\/$/, ""),
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  vault: "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU",
  hitz: "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU",
  usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const live = flag("live");
const secret = process.env.ARB_BOT_SECRET?.trim();
const keypair = secret ? Keypair.fromSecret(secret) : undefined;
const address = option("address") ?? keypair?.publicKey();
if (!address) {
  console.error("Give --address G… for a dry run, or set ARB_BOT_SECRET.");
  process.exit(1);
}
if (live && (!keypair || keypair.publicKey() !== address)) {
  console.error("--live needs ARB_BOT_SECRET for the same account as --address.");
  process.exit(1);
}

const config = {
  ...MAINNET,
  address,
  keypair: live ? keypair : undefined,
  live,
  minProfitXlm: Number(option("min-profit") ?? DEFAULTS.minProfitXlm),
  minProfitBps: DEFAULTS.minProfitBps,
  maxTradeXlm: Number(option("max-trade") ?? DEFAULTS.maxTradeXlm),
  feeBufferXlm: DEFAULTS.feeBufferXlm,
};

const every = Number(option("every") ?? 0);
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.error("stopping after this run…");
});

do {
  const report = await runOnce(config);
  console.log(JSON.stringify(report, null, every ? 0 : 2));
  if (!every || stopping) break;
  await new Promise((r) => setTimeout(r, every * 1000));
} while (!stopping);
