"use client";

/**
 * useEcosystemData — live holder set for the Holder Ecosystem.
 *
 *   • Balances + vault flags: Soroban RPC every 15s (`readHolderStates`).
 *   • Holder discovery + pool/router registry: every 2 min. A brand-new
 *     holder therefore appears within ~3 min (2 min here + the Worker's
 *     60s edge cache); every existing holder's balance is at most 15s old.
 *   • S and L come from ProtocolContext, so the scene, the Pulse bar and
 *     the stat cards below all agree on the same Event Horizon.
 *
 * Status is physics, not the stored flag: the contract re-syncs the vault
 * flag against the current L before gating any transfer, so an account is
 * effectively vaulted iff `balance > L` (see `is_actually_vaulted`).
 * Routers are infrastructure (never vaulted, never mass) and are left out.
 */

import { useEffect, useMemo, useState } from "react";
import { useProtocol } from "../../contexts/ProtocolContext";
import { listRegistrations } from "../../lib/registry";
import {
  describePools,
  fetchHolderIndex,
  readHolderStates,
  type HolderIndexEntry,
  type HolderState,
  type PoolLabel,
} from "../../lib/holders";
import type { EcoStatus } from "./types";

const STATE_POLL_MS = 15_000;
const INDEX_REFRESH_MS = 120_000;

export interface EcoHolder {
  id: string;
  kind: "account" | "pool";
  /** Raw balance (7 decimals). */
  balance: bigint;
  status: EcoStatus;
  /** Stored vault flag (accounts). May lag physics until the next transfer. */
  vaultFlag: boolean;
  /** Balance entry TTL has lapsed. */
  archived: boolean;
  /** ms epoch of the balance entry's last observed write, if known. */
  lastActive: number | null;
  /** Pools only, e.g. "Aqua · HITZ/XLM". */
  label?: string;
}

export type EcoSyncState = "loading" | "live" | "error";

interface Snapshot {
  states: Map<string, HolderState>;
  pools: string[];
  routers: string[];
  activity: Map<string, number | null>;
  fetchedAt: number;
}

export interface EcosystemData {
  holders: EcoHolder[] | null;
  totalMass: bigint;
  safetyLimit: bigint;
  sync: EcoSyncState;
  /** Set when discovery failed — the scene then shows pools only. */
  indexError: string | null;
  /** ms epoch of the last successful state read (for relative times). */
  fetchedAt: number;
}

export function statusFor(balance: bigint, L: bigint): EcoStatus {
  if (balance > L) return "vaulted";
  if (balance * 4n > L * 3n) return "near";
  return "safe";
}

export function useEcosystemData(): EcosystemData {
  const { totalMass, safetyLimit } = useProtocol();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [labels, setLabels] = useState<Map<string, PoolLabel>>(new Map());
  const [sync, setSync] = useState<EcoSyncState>("loading");
  const [indexError, setIndexError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let hasData = false;
    let index: HolderIndexEntry[] = [];
    let registry = { pools: [] as string[], routers: [] as string[] };
    let indexAt = 0;
    let labelledPools = "";
    // address → last seen balance-entry ledger + when we believe it last moved.
    const activity = new Map<string, { ledger: number; at: number | null }>();

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (Date.now() - indexAt > INDEX_REFRESH_MS) {
          const [idx, reg] = await Promise.all([
            fetchHolderIndex().catch((e: unknown) => {
              if (!cancelled) setIndexError(e instanceof Error ? e.message : String(e));
              return null;
            }),
            listRegistrations(),
          ]);
          if (cancelled) return;
          registry = reg;
          if (idx) {
            index = idx;
            indexAt = Date.now();
            setIndexError(null);
            for (const e of idx) {
              if (!activity.has(e.address)) {
                activity.set(e.address, { ledger: 0, at: e.updated ? e.updated * 1000 : null });
              }
            }
          }
          const poolKey = reg.pools.join(",");
          if (poolKey !== labelledPools) {
            labelledPools = poolKey;
            describePools(reg.pools)
              .then((l) => !cancelled && setLabels(l))
              .catch(() => {});
          }
        }

        const addresses = [...new Set([...index.map((e) => e.address), ...registry.pools])];
        const { states } = await readHolderStates(addresses);
        if (cancelled) return;

        const now = Date.now();
        for (const [address, s] of states) {
          const rec = activity.get(address);
          if (!rec) {
            activity.set(address, { ledger: s.lastModifiedLedger, at: null });
            continue;
          }
          if (rec.ledger && s.lastModifiedLedger > rec.ledger) rec.at = now;
          rec.ledger = s.lastModifiedLedger;
        }

        hasData = true;
        setSnapshot({
          states,
          pools: registry.pools,
          routers: registry.routers,
          activity: new Map([...activity].map(([k, v]) => [k, v.at])),
          fetchedAt: now,
        });
        setSync("live");
      } catch {
        // Keep the last good frame on a transient RPC failure; only surface
        // an error before we've ever drawn real data.
        if (!cancelled && !hasData) setSync("error");
      } finally {
        busy = false;
      }
    };

    tick();
    const id = setInterval(tick, STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const holders = useMemo<EcoHolder[] | null>(() => {
    if (!snapshot || safetyLimit <= 0n) return null;
    const pools = new Set(snapshot.pools);
    const routers = new Set(snapshot.routers);
    const out: EcoHolder[] = [];

    for (const address of snapshot.pools) {
      const s = snapshot.states.get(address);
      out.push({
        id: address,
        kind: "pool",
        balance: s?.balance ?? 0n,
        status: "pool",
        vaultFlag: false,
        archived: s?.archived ?? false,
        lastActive: snapshot.activity.get(address) ?? null,
        label: labels.get(address)?.title,
      });
    }
    for (const s of snapshot.states.values()) {
      if (pools.has(s.address) || routers.has(s.address) || s.balance <= 0n) continue;
      out.push({
        id: s.address,
        kind: "account",
        balance: s.balance,
        status: statusFor(s.balance, safetyLimit),
        vaultFlag: s.vaultFlag,
        archived: s.archived,
        lastActive: snapshot.activity.get(s.address) ?? null,
      });
    }
    return out;
  }, [snapshot, labels, safetyLimit]);

  return {
    holders,
    totalMass,
    safetyLimit,
    sync,
    indexError,
    fetchedAt: snapshot?.fetchedAt ?? 0,
  };
}
