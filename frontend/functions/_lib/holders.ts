// HITZ holder index and balances, server-side.
//
// Soroban storage can't be enumerated over RPC, so which addresses to read
// comes from our own index: the D1 `holders` table (migrations/0002 and
// later), filled from the HITZ events the cron ingests plus a one-time
// backfill of holders older than the event store. Amounts always come from
// the ledger itself (getLedgerEntries on `Balance(addr)`), never from events.
// Used by /api/holders (the browser then reads balances itself) and by the
// traction step of the ingestion cron.

import * as StellarSdk from "@stellar/stellar-sdk";
import { insertMany } from "./db";
import type { Env } from "./types";

/** Soroban RPC caps `getLedgerEntries` at 200 keys per request. */
const LEDGER_KEYS_PER_REQUEST = 200;

const isAddress = (v: unknown): v is string => typeof v === "string" && v.length === 56 && (v[0] === "G" || v[0] === "C");

/**
 * Addresses an event shows holding (or having held) HITZ: both sides of a
 * transfer, the recipient of a mint, the source of a burn, the account a
 * vault event is about. `topics` are the ones after the event name.
 */
export function holderAddressesOf(name: string, topics: unknown[]): string[] {
  const picked =
    name === "transfer" ? topics.slice(0, 2) : name === "mint" || name === "burn" || name === "vaulted" ? topics.slice(0, 1) : [];
  return picked.filter(isAddress);
}

/** Add addresses to the index (idempotent). */
export async function indexHolders(env: Env, addresses: Iterable<string>, source: "events" | "backfill"): Promise<number> {
  const unique = [...new Set(addresses)].filter(isAddress);
  const now = new Date().toISOString();
  await insertMany(env.DB, "INSERT OR IGNORE", "holders", ["address", "source", "added_at"], unique.map((a) => [a, source, now]));
  return unique.length;
}

/** Every indexed address. */
export async function listHolders(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT address FROM holders ORDER BY address").all<{ address: string }>();
  return results.map((r) => r.address);
}

/** Every HITZ balance on the ledger (whole tokens), keyed by address, for the indexed holders. */
export async function readAllBalances(env: Env): Promise<Map<string, number>> {
  const addresses = await listHolders(env);
  const contract = StellarSdk.Address.fromString(env.HITZ_CONTRACT_ID).toScAddress();
  const keys = addresses.map((a) =>
    StellarSdk.xdr.LedgerKey.contractData(
      new StellarSdk.xdr.LedgerKeyContractData({
        contract,
        key: StellarSdk.xdr.ScVal.scvVec([
          StellarSdk.xdr.ScVal.scvSymbol("Balance"),
          StellarSdk.Address.fromString(a).toScVal(),
        ]),
        durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      })
    )
  );

  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const balances = new Map<string, number>();
  for (let i = 0; i < keys.length; i += LEDGER_KEYS_PER_REQUEST) {
    const { entries } = await server.getLedgerEntries(...keys.slice(i, i + LEDGER_KEYS_PER_REQUEST));
    for (const e of entries) {
      const data = e.val.contractData();
      const address = StellarSdk.Address.fromScAddress(data.key().vec()![1].address()).toString();
      balances.set(address, Number(StellarSdk.scValToNative(data.val())) / 1e7);
    }
  }
  return balances;
}
