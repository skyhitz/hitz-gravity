"use client";

/**
 * ProtocolContext — shared on-chain state surface.
 *
 * The Pulse bar, the Vault tab, the Monitor stat cards, and the vault swap
 * all read the same three protocol values (Total Mass S, Event Horizon L,
 * user balance), plus the ephemeral "expected output" preview that the swap
 * emits while the user types. Keeping one source of truth avoids N parallel
 * polls and lets the Pulse bar reflect a live what-if simulation the moment
 * the user enters an amount into the swap form.
 *
 *   totalMass, safetyLimit, balance  — refreshed on mount + every 12s.
 *   expectedOut                       : set by the swap when a quote lands;
 *                                       cleared when the form is empty or
 *                                       the trade doesn't buy HITZ.
 *   vaulted                           : the token's live verdict,
 *                                       `is_actually_vaulted`: balance > L
 *                                       and not a registered pool or router.
 *                                       (The stored flag can lag; the token
 *                                       re-syncs it on the next transfer.)
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getBalance,
  getSafetyLimit,
  getTotalMass,
  isActuallyVaulted,
} from "../lib/stellar";
import { useWallet } from "./WalletContext";

interface ProtocolState {
  /** Current total mass S in stroops. 0n while loading. */
  totalMass: bigint;
  /** Event horizon L in stroops. 0n while loading. */
  safetyLimit: bigint;
  /** Connected wallet's HITZ balance. null when no wallet. */
  balance: bigint | null;
  /** Whether the wallet is vaulted right now (live, not the stored flag). null when no wallet. */
  vaulted: boolean | null;
  /** Expected output (stroops) for an in-progress swap preview. */
  expectedOut: bigint;
  /** True during the initial fetch. */
  loading: boolean;
  /** Latest fetch error, if any (non-fatal; old values are retained). */
  error: string | null;

  /** Force a re-poll of S, L, balance. */
  refresh: () => Promise<void>;
  /** The swap calls this whenever a quote lands / is cleared. */
  setExpectedOut: (v: bigint) => void;
}

const ProtocolCtx = createContext<ProtocolState | null>(null);

const POLL_INTERVAL_MS = 12_000;

export function ProtocolProvider({ children }: { children: ReactNode }) {
  const { publicKey } = useWallet();

  const [totalMass, setTotalMass] = useState<bigint>(0n);
  const [safetyLimit, setSafetyLimit] = useState<bigint>(0n);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [vaulted, setVaulted] = useState<boolean | null>(null);
  const [expectedOut, setExpectedOut] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guard against stale async returning after publicKey changes.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const [s, l] = await Promise.all([getTotalMass(), getSafetyLimit()]);
      if (seq !== seqRef.current) return;
      setTotalMass(s);
      setSafetyLimit(l);

      if (publicKey) {
        const [b, v] = await Promise.all([
          getBalance(publicKey).catch(() => 0n),
          isActuallyVaulted(publicKey).catch(() => false),
        ]);
        if (seq !== seqRef.current) return;
        setBalance(b);
        setVaulted(v);
      } else {
        setBalance(null);
        setVaulted(null);
      }

      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [publicKey]);

  // Mount + publicKey-change fetch, plus a steady poll.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const value = useMemo<ProtocolState>(
    () => ({
      totalMass,
      safetyLimit,
      balance,
      vaulted,
      expectedOut,
      loading,
      error,
      refresh,
      setExpectedOut,
    }),
    [totalMass, safetyLimit, balance, vaulted, expectedOut, loading, error, refresh]
  );

  return <ProtocolCtx.Provider value={value}>{children}</ProtocolCtx.Provider>;
}

export function useProtocol(): ProtocolState {
  const ctx = useContext(ProtocolCtx);
  if (!ctx) throw new Error("useProtocol must be used inside <ProtocolProvider>");
  return ctx;
}
