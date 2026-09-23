// Holder discovery + balances, server-side.
//
// Soroban storage can't be enumerated over RPC, so which addresses hold a
// `DataKey::Balance(addr)` entry comes from Stellar Expert's index of the
// contract's storage. Amounts always come from the ledger itself.
// Used by /api/holders (index only; the browser reads balances) and by the
// traction step of the ingestion cron.

import * as StellarSdk from "@stellar/stellar-sdk";
import type { Env } from "./types";

const EXPERT_API = "https://api.stellar.expert";
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
/** Soroban RPC caps `getLedgerEntries` at 200 keys per request. */
const LEDGER_KEYS_PER_REQUEST = 200;

export interface ContractDataRecord {
  /** Base64 XDR ScVal of the storage key. */
  key: string;
  /** Unix seconds of the entry's last write. */
  updated?: number;
}

interface ExpertPage {
  _embedded?: { records?: ContractDataRecord[] };
  _links?: { next?: { href?: string } };
}

/** Every storage entry of `contractId`, as Stellar Expert indexes it. */
export async function fetchContractDataIndex(contractId: string): Promise<ContractDataRecord[]> {
  const prefix = `/explorer/public/contract-data/${contractId}`;
  const records: ContractDataRecord[] = [];
  let path: string | null = `${prefix}?order=asc&limit=${PAGE_LIMIT}`;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res = await fetch(EXPERT_API + path, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Stellar Expert HTTP ${res.status}`);
    const body = (await res.json()) as ExpertPage;
    const batch = body._embedded?.records ?? [];
    for (const r of batch) records.push({ key: r.key, updated: r.updated });
    const next = body._links?.next?.href;
    // Only follow `next` within the same contract's listing.
    path = batch.length === PAGE_LIMIT && next?.startsWith(prefix) ? next : null;
  }
  return records;
}

/** `DataKey::Balance(addr)` encodes as `scvVec([scvSymbol("Balance"), scvAddress])`. */
function balanceKeyAddress(keyXdr: string): string | null {
  try {
    const vec = StellarSdk.xdr.ScVal.fromXDR(keyXdr, "base64").vec();
    if (!vec || vec.length !== 2 || vec[0].switch() !== StellarSdk.xdr.ScValType.scvSymbol()) return null;
    if (vec[0].sym().toString() !== "Balance") return null;
    return StellarSdk.Address.fromScAddress(vec[1].address()).toString();
  } catch {
    return null;
  }
}

/** Every HITZ balance on the ledger (whole tokens), keyed by address. */
export async function readAllBalances(env: Env): Promise<Map<string, number>> {
  const index = await fetchContractDataIndex(env.HITZ_CONTRACT_ID);
  const addresses = [...new Set(index.map((r) => balanceKeyAddress(r.key)).filter((a): a is string => !!a))];
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
