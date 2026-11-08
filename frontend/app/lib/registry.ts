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

import { getAdmin, listPools, listRouters } from "./stellar";
import { describePools } from "./holders";
import { VAULT_ID } from "./vault";

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

/** The registry plus a name for every address we can name, and the token admin. */
export async function listLabelledRegistrations(): Promise<{
  snapshot: RegistrySnapshot;
  labels: Map<string, string>;
  admin: string | null;
}> {
  const [snapshot, admin] = await Promise.all([listRegistrations(), getAdmin().catch(() => null)]);
  const labels = new Map<string, string>(Object.entries(KNOWN_ROUTERS));
  const pools = await describePools(snapshot.pools).catch(() => new Map<string, { title: string }>());
  for (const [address, l] of pools) labels.set(address, l.title);
  return { snapshot, labels, admin };
}

/**
 * What removing a registration would break, for the ones where that's more
 * than housekeeping. Null when removal is harmless.
 */
export function removalWarning(kind: "pool" | "router", address: string, admin: string | null): string | null {
  if (kind === "router") {
    return address === SPONSOR
      ? "This is the email gateway's gas sponsor, holding the reparation reserve. Once removed it is an ordinary account above L: vaulted, able to send HITZ only into a pool. Finish or move the reserve first."
      : null;
  }
  if (address === VAULT_ID) {
    return "This is the Sovereign Vault. Its HITZ would stop counting toward Total Mass: L collapses and nearly every holder is vaulted on their next transfer.";
  }
  if (address === admin) {
    return "This is the treasury. Its HITZ would stop counting toward Total Mass, so L drops sharply, and the treasury itself is vaulted. Move its HITZ into the vault first.";
  }
  return "Its HITZ would stop counting toward Total Mass, which lowers L for everyone.";
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

const SPONSOR = "GBER7ROBYH5NFFKXCDGTSMUKTDQ4U3MEUTUCPJRZZY6EYZVEFDBVNJNB";

/**
 * Registered routers we can name. The rest show as addresses. Since the
 * Aquarius HITZ pools were retired (2026-11-03) the third-party routers
 * route no HITZ: the vault is the only venue and none of them reach it.
 */
export const KNOWN_ROUTERS: Record<string, string> = {
  [SPONSOR]: "Gas sponsor (email gateway)",
  CA7RQDMMV6E53P5EDZA5GPWBZ33AMW2ZNO42XLI2RGRIAP4QXIARUOJQ: "Aquarius router #2 (retired venue)",
  CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK: "Aquarius router (retired venue)",
  CB4YHF4ESRJ4XZRXISLXSUZTYY6YPBPZ73MZWSTUWY46DKYW7IGLHGF7: "Aquarius fee wrapper, third party (retired venue)",
  CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH: "Soroswap router (no HITZ pairs)",
};
