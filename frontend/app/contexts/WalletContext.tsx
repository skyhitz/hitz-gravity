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
 *                 The user's derived account is created on its first call
 *                 that can succeed, sponsored and with a zero balance
 *                 (transparent to the UI). Only transfers of HITZ, XLM and
 *                 USDC and vault swaps go through.
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
// Types only: the SDK itself is loaded on demand (lib/sdk.ts).
import type * as StellarSdk from "@stellar/stellar-sdk";
import * as gateway from "../lib/gateway";
import { errorMessage } from "../lib/errors";
import { loadSdk } from "../lib/sdk";
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
    ])
      .then(([kit, utils]) => ({ kit, utils }))
      .catch((err) => {
        // A failed chunk download must not be remembered: the next call retries.
        swkPromise = null;
        throw err;
      });
  }
  return swkPromise;
}

// The kit is a module-level singleton, so it is set up once per page however
// often the provider mounts (leaving the app pages and coming back remounts it).
let kitInitialized = false;

async function readyKit() {
  const mods = await loadSwk();
  if (!kitInitialized) {
    kitInitialized = true;
    mods.kit.StellarWalletsKit.init({
      modules: mods.utils.defaultModules(),
      network: mods.kit.Networks.PUBLIC,
    });
  }
  return mods;
}

/**
 * Where the kit keeps a connected wallet's address between visits (its
 * LocalStorageKeys.activeAddress). The kit restores a session from this key
 * and nothing else, so when it is absent there is no session to restore and
 * the kit, a few hundred KB, isn't downloaded until the visitor asks to
 * connect a wallet.
 */
const SWK_ACTIVE_ADDRESS = "@StellarWalletsKit/activeAddress";

function hasStoredWallet(): boolean {
  try {
    return !!window.localStorage.getItem(SWK_ACTIVE_ADDRESS);
  } catch {
    return false; // storage blocked: nothing could have been stored either
  }
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
    const sdk = await loadSdk();
    const server = new sdk.rpc.Server(RPC_URL);
    const contract = new sdk.Contract(contractId);

    // Fresh sequence + simulate on each attempt. Called twice in the rare
    // TTL-restore path (pre-restore to detect archival, post-restore to
    // get final assembled tx against live state).
    const buildAndSimulate = async () => {
      const account = await server.getAccount(publicKey);
      const tx = new sdk.TransactionBuilder(account, {
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
    if (sdk.rpc.Api.isSimulationError(sim)) {
      return { success: false, error: sim.error };
    }
    // Soroban TTL: ~30 days of inactivity archives state to cold storage.
    // If the sim returned a restorePreamble, submit a user-signed
    // RestoreFootprintOp first, then re-simulate against live state. The
    // user sees one extra wallet prompt — no failed tx, no manual steps.
    if (sdk.rpc.Api.isSimulationRestore(sim)) {
      await restoreArchivedState(
        publicKey,
        sim.restorePreamble,
        (xdr, opts) => sign(xdr, opts.networkPassphrase)
      );
      ({ tx, sim } = await buildAndSimulate());
      if (sdk.rpc.Api.isSimulationError(sim)) {
        return { success: false, error: sim.error };
      }
    }
    const prepared = sdk.rpc.assembleTransaction(tx, sim).build();
    const signedXdr = await sign(prepared.toXDR(), NETWORK_PASSPHRASE);
    const signedTx = sdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

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
    return { success: false, error: errorMessage(err) };
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType>(null);
  const [connecting, setConnecting] = useState(false);
  // Detaches this provider's listeners from the kit; null until they are attached.
  const detachKit = useRef<(() => void) | null>(null);
  const mounted = useRef(false);

  /**
   * The kit, loaded, initialized and wired to this provider's state. Called
   * on mount when there is a wallet session to restore, and otherwise the
   * first time the visitor does something that needs a wallet.
   */
  const attachKit = useCallback(async () => {
    const mods = await readyKit();
    if (mounted.current && !detachKit.current) {
      const { StellarWalletsKit, KitEventType } = mods.kit;
      const offState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (e) => {
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
      const offDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        // Only drop if we were in wallet mode — email session is unaffected.
        setConnectionType((cur) => {
          if (cur === "wallet") {
            setPublicKey(null);
            return null;
          }
          return cur;
        });
      });
      detachKit.current = () => {
        offState();
        offDisconnect();
      };
    }
    return mods;
  }, []);

  // ── Init: runs once after hydration, client-only ──────────────────────────
  // Two independent restores:
  //   (a) wallet session — from SWK's persisted storage
  //   (b) email session — from our HttpOnly cookie, read via /api/auth/session
  // Whichever resolves first wins; the other is a no-op if a mode is set.
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;

    // (b) Email session — one fetch on mount.
    gateway.me().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setPublicKey(res.data.publicKey);
        setEmail(res.data.email);
        setConnectionType("email");
      }
    });

    // (a) Wallet restore, only when the kit has a session stored. A visitor
    // who never connected a wallet doesn't download the kit at all.
    if (hasStoredWallet()) {
      attachKit()
        .then(({ kit: { StellarWalletsKit } }) => StellarWalletsKit.getAddress())
        .then(({ address }) => {
          if (cancelled || !address) return;
          // Wallet address overrides email if both exist — wallet is the
          // more "active" connection (user took an action since page load).
          setPublicKey(address);
          setEmail(null);
          setConnectionType("wallet");
        })
        .catch(() => { /* no stored wallet session, or the kit didn't load */ });
    }

    return () => {
      cancelled = true;
      mounted.current = false;
      detachKit.current?.();
      detachKit.current = null;
    };
  }, [attachKit]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const { kit: { StellarWalletsKit } } = await attachKit();
      const { address } = await StellarWalletsKit.authModal();
      setPublicKey(address);
      setEmail(null);
      setConnectionType("wallet");
    } catch {
      // User dismissed the modal — not an error
    } finally {
      setConnecting(false);
    }
  }, [attachKit]);

  const connectEmail = useCallback(async (addr: string) => {
    const res = await gateway.login(addr);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }, []);

  const disconnect = useCallback(async () => {
    if (connectionType === "wallet") {
      const { kit: { StellarWalletsKit } } = await attachKit();
      await StellarWalletsKit.disconnect().catch(() => { /* ignore */ });
    } else if (connectionType === "email") {
      await gateway.logout();
    }
    setPublicKey(null);
    setEmail(null);
    setConnectionType(null);
  }, [connectionType, attachKit]);

  const sign = useCallback(
    async (xdr: string, networkPassphrase: string): Promise<string> => {
      if (connectionType !== "wallet") {
        throw new Error("sign() is wallet-only; use callContract() for email sessions");
      }
      const { kit: { StellarWalletsKit } } = await attachKit();
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase,
        address: publicKey ?? undefined,
      });
      return signedTxXdr;
    },
    [publicKey, connectionType, attachKit]
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
