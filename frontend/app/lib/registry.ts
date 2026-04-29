/**
 * registry.ts — Discovery of currently-registered pools and routers.
 *
 * The V4 contract exposes authoritative `list_pools()` / `list_routers()`
 * views backed by an in-contract `Vec<Address>` that's kept in lockstep
 * with every register / remove call. That's what we read here.
 *
 * Previous iterations of this module unioned four candidate sources
 * (seeds, localStorage, recent events, admin) and verified each via
 * `getLedgerEntries` — necessary when the contract had no enumeration
 * API, but fragile: anything that registered out-of-band (CLI, direct
 * invocation) whose `PoolRegisteredEvent` aged past the RPC's retention
 * window would silently disappear from the UI. The contract-side
 * enumeration closes that gap — one RPC call, always authoritative.
 *
 * `rememberAddress` is kept (as a no-op stub) only to avoid churning
 * call sites that persisted candidates before writes. It's harmless
 * and lets the surrounding UI keep its current error-recovery UX.
 */

import { listPools, listRouters } from "./stellar";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RegistrySnapshot {
  pools: string[];
  routers: string[];
}

/**
 * Discover all currently-registered pools and routers. One read per
 * view — no event scraping, no localStorage reconciliation. The
 * contract's enumeration index IS the source of truth.
 */
export async function listRegistrations(): Promise<RegistrySnapshot> {
  const [pools, routers] = await Promise.all([listPools(), listRouters()]);
  return { pools: [...pools].sort(), routers: [...routers].sort() };
}

/**
 * Kept as a compatibility shim — earlier versions of this module
 * persisted candidates to localStorage so out-of-band registrations
 * could still be verified on the next load. With the contract's
 * native `list_pools` / `list_routers`, that scaffolding is no longer
 * needed. Existing callers (ProtocolGrowth's register buttons,
 * Registry's Verify-Address input) can keep calling this safely —
 * it just returns without touching storage.
 */
export function rememberAddress(_address: string): void {
  // intentionally empty — see module docstring
}
