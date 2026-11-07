/**
 * holders.ts: the on-chain holder set behind the Holder Ecosystem.
 *
 * Soroban storage has no iteration API, so discovery and state come from two
 * places:
 *
 *   1. Discovery: our own holder index, served by the Worker's
 *      `/api/holders` route (the D1 `holders` table: every address in an
 *      ingested HITZ event, plus a one-time backfill of holders older than
 *      the event store). It replaced Stellar Expert's contract-data index
 *      when that API went behind a paywall in November 2026.
 *   2. State: balances and vault flags are read from Soroban RPC with
 *      `getLedgerEntries`, i.e. the exact ledger entries the contract reads.
 *      The index only tells us which keys to ask for; amounts never come
 *      from it.
 *
 * `getLedgerEntries` also returns archived (TTL-expired) persistent entries,
 * so dormant launch-week holders still appear with their real balance.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL, getAdmin } from "./stellar";
import { VAULT_ID, readPools } from "./vault";
import { getTokenInfos } from "./tokens";
import { apiBase } from "./api";

const server = new StellarSdk.rpc.Server(RPC_URL);

/** Soroban RPC caps `getLedgerEntries` at 200 keys per request. */
const LEDGER_KEYS_PER_REQUEST = 200;

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface HolderIndexEntry {
  address: string;
  /** Unix seconds of the balance entry's last write, when known (the index doesn't record it). */
  updated: number | null;
}

/**
 * Every address that has ever held a HITZ balance entry (including zero
 * balances: callers filter those after reading live state).
 */
export async function fetchHolderIndex(): Promise<HolderIndexEntry[]> {
  const res = await fetch(`${apiBase()}/api/holders`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`holder index unavailable (HTTP ${res.status})`);
  const body = (await res.json()) as { holders?: unknown };
  if (!Array.isArray(body.holders)) throw new Error("holder index malformed");
  return body.holders
    .filter((a): a is string => typeof a === "string" && a.length === 56)
    .map((address) => ({ address, updated: null }));
}

// ─── Live state ──────────────────────────────────────────────────────────────

export interface HolderState {
  address: string;
  /** Raw balance (7 decimals). */
  balance: bigint;
  /**
   * The stored `DataKey::Vaulted` flag. It's a cache: `transfer` re-syncs it
   * against the current L before gating, so the effective status is always
   * `balance > L`. A mismatch just means the flag updates on the next move.
   */
  vaultFlag: boolean;
  /** The balance entry's TTL has lapsed (archived until next touched). */
  archived: boolean;
  /** Ledger sequence of the balance entry's last write. */
  lastModifiedLedger: number;
}

export interface HolderStateSnapshot {
  states: Map<string, HolderState>;
  latestLedger: number;
}

function dataKey(kind: "Balance" | "Vaulted", address: string): StellarSdk.xdr.LedgerKey {
  return StellarSdk.xdr.LedgerKey.contractData(
    new StellarSdk.xdr.LedgerKeyContractData({
      contract: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
      key: StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.xdr.ScVal.scvSymbol(kind),
        StellarSdk.Address.fromString(address).toScVal(),
      ]),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    })
  );
}

/**
 * Read `Balance(addr)` and `Vaulted(addr)` for every address straight from
 * the ledger. Addresses with no balance entry are absent from the result.
 */
export async function readHolderStates(addresses: string[]): Promise<HolderStateSnapshot> {
  const lookup = new Map<string, { kind: "Balance" | "Vaulted"; address: string }>();
  const keys: StellarSdk.xdr.LedgerKey[] = [];
  for (const address of addresses) {
    for (const kind of ["Balance", "Vaulted"] as const) {
      const key = dataKey(kind, address);
      lookup.set(key.toXDR("base64"), { kind, address });
      keys.push(key);
    }
  }

  const batches: StellarSdk.xdr.LedgerKey[][] = [];
  for (let i = 0; i < keys.length; i += LEDGER_KEYS_PER_REQUEST) {
    batches.push(keys.slice(i, i + LEDGER_KEYS_PER_REQUEST));
  }
  const responses = await Promise.all(batches.map((b) => server.getLedgerEntries(...b)));

  const latestLedger = Math.max(0, ...responses.map((r) => r.latestLedger));
  const balances = new Map<string, { value: bigint; archived: boolean; modified: number }>();
  const flags = new Map<string, boolean>();

  for (const res of responses) {
    for (const entry of res.entries) {
      const meta = lookup.get(entry.key.toXDR("base64"));
      if (!meta) continue;
      const native = StellarSdk.scValToNative(entry.val.contractData().val());
      if (meta.kind === "Balance") {
        balances.set(meta.address, {
          value: BigInt(native as bigint | number | string),
          archived:
            entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < res.latestLedger,
          modified: entry.lastModifiedLedgerSeq ?? 0,
        });
      } else {
        flags.set(meta.address, native === true);
      }
    }
  }

  const states = new Map<string, HolderState>();
  for (const [address, b] of balances) {
    states.set(address, {
      address,
      balance: b.value,
      vaultFlag: flags.get(address) ?? false,
      archived: b.archived,
      lastModifiedLedger: b.modified,
    });
  }
  return { states, latestLedger };
}

// ─── Pool labels ─────────────────────────────────────────────────────────────

export interface PoolLabel {
  /** e.g. "Sovereign Vault · XLM, USDC", "Treasury (admin)". */
  title: string;
}

/**
 * Human labels for registered pools, from chain state: the Sovereign Vault
 * (named with the assets it lists), the treasury (the admin account, a
 * registered pool so its HITZ counts as mass), other classic accounts and
 * any other pool contract.
 */
export async function describePools(pools: string[]): Promise<Map<string, PoolLabel>> {
  const out = new Map<string, PoolLabel>();
  const admin = await getAdmin().catch(() => null);
  let vaultAssets = "";
  if (pools.includes(VAULT_ID)) {
    const states = await readPools().catch(() => []);
    const infos = await getTokenInfos(states.map((p) => p.asset));
    vaultAssets = states.map((p) => infos.get(p.asset)?.symbol ?? "?").join(", ");
  }
  for (const address of pools) {
    if (address === VAULT_ID) {
      out.set(address, { title: vaultAssets ? `Sovereign Vault · ${vaultAssets}` : "Sovereign Vault" });
    } else if (address.startsWith("G")) {
      out.set(address, { title: address === admin ? "Treasury (admin)" : "Classic account" });
    } else {
      out.set(address, { title: "Pool contract" });
    }
  }
  return out;
}
