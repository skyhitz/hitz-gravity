/**
 * holders.ts — the on-chain holder set behind the Holder Ecosystem.
 *
 * Soroban storage has no iteration API and the HITZ contract keeps no
 * holder index, so discovery and state come from two places:
 *
 *   1. Discovery — which addresses own a `DataKey::Balance(addr)` entry.
 *      Stellar Expert indexes every contract-data ledger entry; we read that
 *      index through the Worker's `/api/holders` route, because Stellar
 *      Expert rejects browser requests from our origin. `next dev` doesn't
 *      run the Worker, so there we fall back to calling Stellar Expert
 *      directly — it does allow `localhost`.
 *   2. State — balances and vault flags are read from Soroban RPC with
 *      `getLedgerEntries`, i.e. the exact ledger entries the contract reads.
 *      The index only tells us which keys to ask for; amounts never come
 *      from it.
 *
 * `getLedgerEntries` also returns archived (TTL-expired) persistent entries,
 * so dormant launch-week holders still appear with their real balance.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL, getAdmin } from "./stellar";
import { HITZ_ADDRESS, discoverPoolsFromRegistry, getTokenInfos } from "./aqua";

const server = new StellarSdk.rpc.Server(RPC_URL);

const EXPERT_CONTRACT_DATA = `https://api.stellar.expert/explorer/public/contract-data/${CONTRACT_ID}`;

/** Soroban RPC caps `getLedgerEntries` at 200 keys per request. */
const LEDGER_KEYS_PER_REQUEST = 200;

// ─── Discovery ───────────────────────────────────────────────────────────────

/** One contract-data record as Stellar Expert (or our proxy of it) returns it. */
interface ContractDataRecord {
  /** Base64 XDR ScVal of the storage key. */
  key: string;
  /** Unix seconds of the entry's last write. */
  updated?: number;
}

export interface HolderIndexEntry {
  address: string;
  /** Unix seconds of the balance entry's last write, per the indexer. */
  updated: number | null;
}

/**
 * Every address that has ever held a HITZ balance entry (including zero
 * balances — callers filter those after reading live state).
 */
export async function fetchHolderIndex(): Promise<HolderIndexEntry[]> {
  let records: ContractDataRecord[];
  try {
    records = await fetchIndexViaWorker();
  } catch (workerErr) {
    try {
      records = await fetchIndexDirect();
    } catch {
      throw workerErr;
    }
  }

  const out = new Map<string, HolderIndexEntry>();
  for (const rec of records) {
    const address = balanceKeyAddress(rec.key);
    if (address) out.set(address, { address, updated: rec.updated ?? null });
  }
  return [...out.values()];
}

async function fetchIndexViaWorker(): Promise<ContractDataRecord[]> {
  const res = await fetch("/api/holders", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`holder index unavailable (HTTP ${res.status})`);
  const body = (await res.json()) as { records?: ContractDataRecord[] };
  if (!Array.isArray(body.records)) throw new Error("holder index malformed");
  return body.records;
}

async function fetchIndexDirect(): Promise<ContractDataRecord[]> {
  const records: ContractDataRecord[] = [];
  let url: string | null = `${EXPERT_CONTRACT_DATA}?order=asc&limit=200`;
  // Hard page cap so a misbehaving cursor can't spin forever.
  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`Stellar Expert HTTP ${res.status}`);
    const body = await res.json();
    const batch: ContractDataRecord[] = body?._embedded?.records ?? [];
    records.push(...batch);
    const next: string | undefined = body?._links?.next?.href;
    url = batch.length === 200 && next ? `https://api.stellar.expert${next}` : null;
  }
  return records;
}

/** `DataKey::Balance(addr)` encodes as `scvVec([scvSymbol("Balance"), scvAddress])`. */
function balanceKeyAddress(keyXdr: string): string | null {
  try {
    const key = StellarSdk.xdr.ScVal.fromXDR(keyXdr, "base64");
    if (key.switch() !== StellarSdk.xdr.ScValType.scvVec()) return null;
    const vec = key.vec();
    if (!vec || vec.length !== 2) return null;
    if (vec[0].switch() !== StellarSdk.xdr.ScValType.scvSymbol()) return null;
    if (vec[0].sym().toString() !== "Balance") return null;
    if (vec[1].switch() !== StellarSdk.xdr.ScValType.scvAddress()) return null;
    return StellarSdk.Address.fromScAddress(vec[1].address()).toString();
  } catch {
    return null;
  }
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
  /** e.g. "Aqua · HITZ/XLM", "Admin account". */
  title: string;
}

/**
 * Human labels for registered pools, derived from chain state: the pool's
 * own `get_tokens()`, each token's `symbol()`, and whether the Aqua router
 * indexes it. Classic G-accounts can be registered as pools too (bootstrap
 * reserves); those are labelled as accounts.
 */
export async function describePools(pools: string[]): Promise<Map<string, PoolLabel>> {
  const out = new Map<string, PoolLabel>();
  const [infos, admin] = await Promise.all([
    discoverPoolsFromRegistry(pools).catch(() => []),
    getAdmin().catch(() => null),
  ]);
  const symbols = await getTokenInfos(infos.flatMap((p) => [p.tokenA, p.tokenB]));

  for (const address of pools) {
    if (address.startsWith("G")) {
      out.set(address, { title: address === admin ? "Admin account" : "Classic account" });
      continue;
    }
    const info = infos.find((p) => p.address === address);
    if (!info) {
      out.set(address, { title: "Pool contract" });
      continue;
    }
    const other = info.tokenA === HITZ_ADDRESS ? info.tokenB : info.tokenA;
    const pair = `HITZ/${symbols.get(other)?.symbol ?? "?"}`;
    const venue = info.poolIndex.length > 0 ? "Aqua" : "Pool";
    out.set(address, { title: `${venue} · ${pair}` });
  }
  return out;
}
