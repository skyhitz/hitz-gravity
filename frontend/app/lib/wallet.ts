/**
 * wallet.ts — thin signing helper used by scenario components.
 *
 * Uses the same dynamic-import pattern as WalletContext so the SWK module is
 * never evaluated during SSR or the React hydration window (SWK v2 mutates
 * <html> CSS vars via @preact/signals at module-eval time → hydration mismatch).
 */

// ─── Lazy SWK loader (shared singleton promise) ───────────────────────────────

async function getKit() {
  const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
  return StellarWalletsKit;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sign a transaction XDR with whichever wallet the user connected.
 * Drop-in compatible with the old Freighter-based signTransaction shape.
 */
export async function signTransaction(
  xdr: string,
  opts: { networkPassphrase: string }
): Promise<string> {
  const StellarWalletsKit = await getKit();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: opts.networkPassphrase,
  });
  return signedTxXdr;
}

/** Friendly address abbreviation used in UI labels. */
export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
