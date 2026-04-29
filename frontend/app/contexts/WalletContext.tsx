"use client";

/**
 * WalletContext — unified auth surface for wallet + email users.
 *
 * The UI doesn't care *how* a user is connected. It just needs to know:
 *   - Are we connected?    → `publicKey !== null`
 *   - How?                 → `connectionType` ("wallet" | "email" | null)
 *   - Do a signed action   → `callContract(contractId, method, args)`
 *
 * Two concrete paths live behind `callContract`:
 *
 *   Wallet path:  build tx locally → simulate → assembleTransaction →
 *                 sign via Stellar Wallets Kit → submit via RPC → poll.
 *
 *   Email path:   POST {contractId, method, argsXdr[]} to
 *                 /api/gateway/execute. The Worker derives the user's key
 *                 from the session cookie, inner-signs, wraps in a
 *                 FeeBumpTransaction signed by the sponsor, submits, polls.
 *                 The user's derived account is bootstrapped with 1 XLM on
 *                 first call (transparent to the UI).
 *
 * The sign() export is kept for legacy scenario components that still hand
 * XDR to Freighter directly. New code should use callContract().
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as StellarSdk from "@stellar/stellar-sdk";
import * as gateway from "../lib/gateway";
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  restoreArchivedState,
  type TxResult,
} from "../lib/stellar";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionType = "wallet" | "email" | null;

interface WalletContextValue {
  publicKey: string | null;
  email: string | null;
  connectionType: ConnectionType;
  connecting: boolean;
  /** Launch SWK modal. Used when the ConnectModal's "Connect wallet" button fires. */
  connectWallet: () => Promise<void>;
  /** Send magic-link email. Returns `{ok, error?}` so the modal can render state. */
  connectEmail: (email: string) => Promise<{ ok: boolean; error?: string }>;
  /** Disconnect whichever mode is active. */
  disconnect: () => Promise<void>;
  /** Legacy — wallet-mode XDR signer; throws for email sessions. */
  sign: (xdr: string, networkPassphrase: string) => Promise<string>;
  /** Unified contract-call primitive. Routes to wallet or gateway path. */
  callContract: (
    contractId: string,
    method: string,
    args: StellarSdk.xdr.ScVal[]
  ) => Promise<TxResult>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextValue | null>(null);

// ─── Lazy SWK loader ─────────────────────────────────────────────────────────
//
// SWK v2 uses @preact/signals whose effects fire synchronously at module-eval
// time. A top-level import would mutate <html> CSS vars before React hydrates,
// causing a server/client attribute mismatch. Dynamic import() defers the
// entire module until after mount so the DOM is already owned by React.

type SwkModule = typeof import("@creit.tech/stellar-wallets-kit");
type SwkUtils = typeof import("@creit.tech/stellar-wallets-kit/modules/utils");

let swkPromise: Promise<{ kit: SwkModule; utils: SwkUtils }> | null = null;

function loadSwk() {
  if (!swkPromise) {
    swkPromise = Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
    ]).then(([kit, utils]) => ({ kit, utils }));
  }
  return swkPromise;
}

// ─── Wallet-mode contract call ───────────────────────────────────────────────
// Mirrors the existing buildAndSend in lib/stellar.ts but generic over
// contractId. Kept inline because we want the entire flow — sim, prepare,
// sign, submit, poll — in one place per mode.

async function walletCallContract(
  publicKey: string,
  sign: (xdr: string, networkPassphrase: string) => Promise<string>,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<TxResult> {
  try {
    const server = new StellarSdk.rpc.Server(RPC_URL);
    const contract = new StellarSdk.Contract(contractId);

    // Fresh sequence + simulate on each attempt. Called twice in the rare
    // TTL-restore path (pre-restore to detect archival, post-restore to
    // get final assembled tx against live state).
    const buildAndSimulate = async () => {
      const account = await server.getAccount(publicKey);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "10000000",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      return { tx, sim };
    };

    let { tx, sim } = await buildAndSimulate();
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      return { success: false, error: sim.error };
    }
    // Soroban TTL: ~30 days of inactivity archives state to cold storage.
    // If the sim returned a restorePreamble, submit a user-signed
    // RestoreFootprintOp first, then re-simulate against live state. The
    // user sees one extra wallet prompt — no failed tx, no manual steps.
    if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
      await restoreArchivedState(
        publicKey,
        sim.restorePreamble,
        (xdr, opts) => sign(xdr, opts.networkPassphrase)
      );
      ({ tx, sim } = await buildAndSimulate());
      if (StellarSdk.rpc.Api.isSimulationError(sim)) {
        return { success: false, error: sim.error };
      }
    }
    const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    const signedXdr = await sign(prepared.toXDR(), NETWORK_PASSPHRASE);
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

    const response = await server.sendTransaction(signedTx);
    if (response.status === "ERROR") {
      // Decode the result XDR so the operator (and user) see the actual
      // reason, not a generic "submission failed". Most common cases:
      //   txBAD_AUTH   → destination has no classic account (SAC refuses)
      //   txBAD_SEQ    → stale sequence; rarely hit because we getAccount fresh
      //   txNO_ACCOUNT → source doesn't exist (shouldn't be reachable here)
      // If decoding itself fails we fall back to the opaque string.
      let detail = "";
      try {
        const xdrStr = response.errorResult?.toXDR("base64");
        if (xdrStr) detail = `: ${xdrStr}`;
        const code = response.errorResult?.result().switch().name;
        if (code) detail = `: ${code}`;
      } catch {
        /* fall through to generic */
      }
      return { success: false, error: `Transaction submission failed${detail}` };
    }

    let getResponse = await server.getTransaction(response.hash);
    while (getResponse.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await server.getTransaction(response.hash);
    }
    if (getResponse.status === "SUCCESS") {
      return { success: true, hash: response.hash };
    }
    return {
      success: false,
      hash: response.hash,
      error: `Transaction failed: ${getResponse.status}`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType>(null);
  const [connecting, setConnecting] = useState(false);
  const kitReady = useRef(false);
  // One ensure-trustline call per email + isolate. Tracks the email we
  // already retrofitted so reconnecting as a different user re-fires it.
  const trustlineEnsuredFor = useRef<string | null>(null);

  // ── Init: runs once after hydration, client-only ──────────────────────────
  // Two independent restores:
  //   (a) wallet session — from SWK's persisted storage
  //   (b) email session — from our HttpOnly cookie, read via /api/auth/me
  // Whichever resolves first wins; the other is a no-op if a mode is set.
  useEffect(() => {
    let cancelled = false;
    let cleanupState: (() => void) | null = null;
    let cleanupDisconnect: (() => void) | null = null;

    // (b) Email session — one fetch on mount.
    gateway.me().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setPublicKey(res.data.publicKey);
        setEmail(res.data.email);
        setConnectionType("email");
      }
    });

    // (a) Wallet init + restore
    loadSwk().then(({ kit: { StellarWalletsKit, Networks, KitEventType }, utils: { defaultModules } }) => {
      if (cancelled) return;
      if (!kitReady.current) {
        kitReady.current = true;
        StellarWalletsKit.init({
          modules: defaultModules(),
          network: Networks.PUBLIC,
        });
      }

      StellarWalletsKit.getAddress()
        .then(({ address }) => {
          if (cancelled || !address) return;
          // Wallet address overrides email if both exist — wallet is the
          // more "active" connection (user took an action since page load).
          setPublicKey(address);
          setEmail(null);
          setConnectionType("wallet");
        })
        .catch(() => { /* no stored wallet session */ });

      cleanupState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (e) => {
        if (e.payload.address) {
          setPublicKey(e.payload.address);
          setEmail(null);
          setConnectionType("wallet");
        } else {
          // Only drop wallet state if we were in wallet mode. Use the
          // functional setter so we read the latest mode, not a stale
          // capture from effect-mount.
          setConnectionType((cur) => {
            if (cur === "wallet") {
              setPublicKey(null);
              return null;
            }
            return cur;
          });
        }
      });

      cleanupDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        // Only drop if we were in wallet mode — email session is unaffected.
        setConnectionType((cur) => {
          if (cur === "wallet") {
            setPublicKey(null);
            return null;
          }
          return cur;
        });
      });
    });

    return () => {
      cancelled = true;
      cleanupState?.();
      cleanupDisconnect?.();
    };
  }, []);

  // Retrofit legacy email users with a USDC trustline on session detection.
  // The verify endpoint already does this on fresh magic-link logins; this
  // covers the (one-time) population that bootstrapped before the trustline
  // flow shipped — they get the trustline on app load without re-logging in.
  // Fire-and-forget: failures are surfaced server-side; the UI never blocks
  // on the result.
  useEffect(() => {
    if (connectionType !== "email" || !email) return;
    if (trustlineEnsuredFor.current === email) return;
    trustlineEnsuredFor.current = email;
    gateway.ensureTrustline().catch(() => {
      // Reset so the next session-mount can retry. Server-side errors are
      // logged in Worker logs; the UI has nothing useful to show here.
      trustlineEnsuredFor.current = null;
    });
  }, [connectionType, email]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const { kit: { StellarWalletsKit } } = await loadSwk();
      const { address } = await StellarWalletsKit.authModal();
      setPublicKey(address);
      setEmail(null);
      setConnectionType("wallet");
    } catch {
      // User dismissed the modal — not an error
    } finally {
      setConnecting(false);
    }
  }, []);

  const connectEmail = useCallback(async (addr: string) => {
    const res = await gateway.login(addr);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }, []);

  const disconnect = useCallback(async () => {
    if (connectionType === "wallet") {
      const { kit: { StellarWalletsKit } } = await loadSwk();
      await StellarWalletsKit.disconnect().catch(() => { /* ignore */ });
    } else if (connectionType === "email") {
      await gateway.logout();
    }
    setPublicKey(null);
    setEmail(null);
    setConnectionType(null);
  }, [connectionType]);

  const sign = useCallback(
    async (xdr: string, networkPassphrase: string): Promise<string> => {
      if (connectionType !== "wallet") {
        throw new Error("sign() is wallet-only; use callContract() for email sessions");
      }
      const { kit: { StellarWalletsKit } } = await loadSwk();
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase,
        address: publicKey ?? undefined,
      });
      return signedTxXdr;
    },
    [publicKey, connectionType]
  );

  const callContract = useCallback(
    async (
      contractId: string,
      method: string,
      args: StellarSdk.xdr.ScVal[]
    ): Promise<TxResult> => {
      if (!publicKey || !connectionType) {
        return { success: false, error: "not connected" };
      }
      if (connectionType === "email") {
        const res = await gateway.execute(contractId, method, args);
        if (!res.ok) return { success: false, error: res.error };
        return { success: true, hash: res.data.hash };
      }
      return walletCallContract(publicKey, sign, contractId, method, args);
    },
    [publicKey, connectionType, sign]
  );

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        email,
        connectionType,
        connecting,
        connectWallet,
        connectEmail,
        disconnect,
        sign,
        callContract,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
