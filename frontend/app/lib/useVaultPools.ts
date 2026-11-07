"use client";

/**
 * useVaultPools: the vault's pools, live: re-read every 15 s, on window
 * focus, and on demand (after a swap). Shared by the swap, the release
 * card, the admin tools and the Monitor's vault card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readPools } from "./vault";
import type { PoolState } from "./vaultMath";

const POLL_MS = 15_000;

export interface VaultPoolsState {
  pools: PoolState[] | null;
  /** When `pools` was read (ms). */
  readAt: number | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useVaultPools(): VaultPoolsState {
  const [pools, setPools] = useState<PoolState[] | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const p = await readPools();
      if (n !== seq.current) return;
      setPools(p);
      setReadAt(Date.now());
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      // Keep the last good read; surface the error.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { pools, readAt, error, refresh };
}
