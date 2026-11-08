"use client";

import { useCallback, useEffect, useState } from "react";
import TxButton from "../TxButton";
import {
  registerPoolAddress,
  removePoolAddress,
  registerRouterAddress,
  removeRouterAddress,
  isPool,
  isRouter,
  burn,
  parseHitz,
  type TxResult,
} from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";
import { errorMessage } from "../../lib/errors";
import { listLabelledRegistrations, removalWarning, type RegistrySnapshot } from "../../lib/registry";

interface Props {
  publicKey: string | null;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; snapshot: RegistrySnapshot; labels: Map<string, string>; admin: string | null }
  | { status: "error"; error: string };

/**
 * Race-safe fetch: returns a terminal state (ready/error). Caller decides
 * whether to set "loading" first (user-driven refreshes do; the initial
 * mount starts in "loading" via initial state so the effect can go
 * straight to a terminal dispatch without tripping set-state-in-effect).
 */
async function fetchSnapshot(): Promise<ListState> {
  try {
    return { status: "ready", ...(await listLabelledRegistrations()) };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default function ProtocolGrowth({ publicKey }: Props) {
  const [poolAddress, setPoolAddress] = useState("");
  const [removePoolAddr, setRemovePoolAddr] = useState("");
  const [routerAddress, setRouterAddress] = useState("");
  const [removeRouterAddr, setRemoveRouterAddr] = useState("");
  const [checkAddress, setCheckAddress] = useState("");
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [burnFrom, setBurnFrom] = useState("");
  const [burnAmount, setBurnAmount] = useState("");

  // Initial state is "loading" so the mount effect can go straight to a
  // terminal state without a synchronous setState (which the
  // react-hooks/set-state-in-effect rule rightly flags).
  const [listState, setListState] = useState<ListState>({ status: "loading" });

  // User-initiated refresh: flips back to "loading" then fetches.
  const refresh = useCallback(async () => {
    setListState({ status: "loading" });
    setListState(await fetchSnapshot());
  }, []);

  // Mount-only fetch. Cancelled if unmounted mid-flight.
  useEffect(() => {
    let cancelled = false;
    fetchSnapshot().then((next) => {
      if (!cancelled) setListState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        Admin registers pool and router addresses. <strong>Pools</strong> hold Total Mass, and vaulted
        accounts can still send them HITZ (selling into the vault is one). <strong>Routers</strong> are
        pass-through infrastructure: never mass, and vaulted accounts can&apos;t send to them. A registration
        binds the address&apos;s current Wasm: if its code changes, the token stops trusting it until it&apos;s
        re-registered. Never re-register the retired Aquarius pools (CCCDPF74…, CBMOEJUO…).
      </p>

      {/* Live registry: each row's Remove sends the removal itself, after a confirm step */}
      <RegistryPanel
        title="Registered Pools"
        kind="pool"
        state={listState}
        onRefresh={refresh}
        canSign={!!publicKey}
        onRemove={(addr) => removePoolAddress(publicKey!, addr, signTransaction)}
      />

      <RegistryPanel
        title="Registered Routers"
        kind="router"
        state={listState}
        onRefresh={refresh}
        canSign={!!publicKey}
        onRemove={(addr) => removeRouterAddress(publicKey!, addr, signTransaction)}
      />

      {/* Register Pool */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Register Pool Address (Admin)
        </h4>
        <input
          value={poolAddress}
          onChange={(e) => setPoolAddress(e.target.value)}
          placeholder="Pool contract address (C... or G...)"
        />
        <TxButton
          label="Register Pool"
          disabled={!publicKey || !poolAddress}
          onClick={async () => {
            const res = await registerPoolAddress(publicKey!, poolAddress, signTransaction);
            if (res.success) refresh();
            return res;
          }}
        />
      </div>

      {/* Remove Pool */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Remove Pool Address (Admin)
        </h4>
        <input
          value={removePoolAddr}
          onChange={(e) => setRemovePoolAddr(e.target.value)}
          placeholder="Pool address to remove"
        />
        <TxButton
          label="Remove Pool"
          disabled={!publicKey || !removePoolAddr}
          onClick={async () => {
            const res = await removePoolAddress(publicKey!, removePoolAddr, signTransaction);
            if (res.success) refresh();
            return res;
          }}
          variant="danger"
        />
      </div>

      {/* Register Router */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Register Router Address (Admin)
        </h4>
        <input
          value={routerAddress}
          onChange={(e) => setRouterAddress(e.target.value)}
          placeholder="Router contract address (C... or G...)"
        />
        <TxButton
          label="Register Router"
          disabled={!publicKey || !routerAddress}
          onClick={async () => {
            const res = await registerRouterAddress(publicKey!, routerAddress, signTransaction);
            if (res.success) refresh();
            return res;
          }}
        />
      </div>

      {/* Remove Router */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Remove Router Address (Admin)
        </h4>
        <input
          value={removeRouterAddr}
          onChange={(e) => setRemoveRouterAddr(e.target.value)}
          placeholder="Router address to remove"
        />
        <TxButton
          label="Remove Router"
          disabled={!publicKey || !removeRouterAddr}
          onClick={async () => {
            const res = await removeRouterAddress(publicKey!, removeRouterAddr, signTransaction);
            if (res.success) refresh();
            return res;
          }}
          variant="danger"
        />
      </div>

      {/* Check Address Type */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Check Address Type
        </h4>
        <input
          value={checkAddress}
          onChange={(e) => { setCheckAddress(e.target.value); setCheckResult(null); }}
          placeholder="Address to check"
        />
        <button
          className="btn btn-secondary text-sm"
          disabled={!checkAddress}
          onClick={async () => {
            try {
              const [poolResult, routerResult] = await Promise.all([
                isPool(checkAddress),
                isRouter(checkAddress),
              ]);
              if (poolResult) setCheckResult("✅ Approved Pool");
              else if (routerResult) setCheckResult("✅ Approved Router");
              else setCheckResult("❌ Not registered (regular address)");
            } catch (e) {
              setCheckResult(`Error: ${e}`);
            }
          }}
        >
          Check
        </button>
        {checkResult && (
          <p className="text-sm font-mono text-accent">{checkResult}</p>
        )}
      </div>

      {/* Burn */}
      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">Burn Tokens</h4>
        <input
          value={burnFrom}
          onChange={(e) => setBurnFrom(e.target.value)}
          placeholder="From address"
        />
        <input
          value={burnAmount}
          onChange={(e) => setBurnAmount(e.target.value)}
          placeholder="Amount to burn"
          type="text"
        />
        <TxButton
          label="Burn"
          disabled={!publicKey || !burnFrom || !burnAmount}
          onClick={() =>
            burn(publicKey!, burnFrom, parseHitz(burnAmount), signTransaction)
          }
          variant="danger"
        />
      </div>
    </div>
  );
}

// ─── Registry panel ──────────────────────────────────────────────────────────

function RegistryPanel({
  title,
  kind,
  state,
  onRefresh,
  canSign,
  onRemove,
}: {
  title: string;
  kind: "pool" | "router";
  state: ListState;
  onRefresh: () => void;
  canSign: boolean;
  onRemove: (addr: string) => Promise<TxResult>;
}) {
  const [removed, setRemoved] = useState<{ address: string; hash?: string } | null>(null);
  const addresses =
    state.status === "ready"
      ? kind === "pool"
        ? state.snapshot.pools
        : state.snapshot.routers
      : [];

  const accent = kind === "pool" ? "text-accent" : "text-purple";
  const dot = kind === "pool" ? "bg-accent" : "bg-purple";

  return (
    <div className="rounded-2xl border border-border bg-card/50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          {state.status === "ready" && (
            <span className="text-muted text-xs font-mono tabular-nums">
              {addresses.length}
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={state.status === "loading"}
          className="text-muted hover:text-foreground transition-colors text-xs cursor-pointer disabled:opacity-50"
          title="Refresh from chain"
        >
          {state.status === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 border-2 border-muted/30 border-t-muted rounded-full animate-spin" />
              Loading…
            </span>
          ) : (
            <span>↻ Refresh</span>
          )}
        </button>
      </div>

      {state.status === "error" && (
        <p className="text-xs rounded-lg px-3 py-2 bg-red/10 text-red font-mono break-all">
          {state.error}
        </p>
      )}

      {removed && (
        <p className="text-xs rounded-lg px-3 py-2 bg-green/10 text-green font-mono break-all">
          Removed {shorten(removed.address)}.{" "}
          {removed.hash && (
            <a
              href={`https://stellar.expert/explorer/public/tx/${removed.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View tx
            </a>
          )}
        </p>
      )}

      {state.status === "ready" && addresses.length === 0 && (
        <p className="text-muted text-xs italic">
          No {kind === "pool" ? "pools" : "routers"} registered yet.
        </p>
      )}

      {state.status === "ready" && addresses.length > 0 && (
        <ul className="space-y-1.5">
          {addresses.map((addr) => (
            <AddressRow
              key={addr}
              address={addr}
              kind={kind}
              accent={accent}
              label={state.labels.get(addr)}
              warning={removalWarning(kind, addr, state.admin)}
              canSign={canSign}
              onRemove={async () => {
                const res = await onRemove(addr);
                if (res.success) {
                  setRemoved({ address: addr, hash: res.hash });
                  onRefresh();
                }
                return res;
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

type RowStep =
  | { step: "idle" }
  | { step: "confirm" }
  | { step: "sending" }
  | { step: "failed"; error: string };

function AddressRow({
  address,
  kind,
  accent,
  label,
  warning,
  canSign,
  onRemove,
}: {
  address: string;
  kind: "pool" | "router";
  accent: string;
  label?: string;
  warning: string | null;
  canSign: boolean;
  onRemove: () => Promise<TxResult>;
}) {
  const [copied, setCopied] = useState(false);
  const [row, setRow] = useState<RowStep>({ step: "idle" });

  const confirmRemoval = async () => {
    setRow({ step: "sending" });
    try {
      const res = await onRemove();
      // On success the list refreshes and this row goes away.
      setRow(res.success ? { step: "idle" } : { step: "failed", error: res.error ?? "Transaction failed" });
    } catch (e: unknown) {
      setRow({ step: "failed", error: errorMessage(e) });
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  const explorerPath = address.startsWith("G") ? "account" : "contract";
  const explorerUrl = `https://stellar.expert/explorer/public/${explorerPath}/${address}`;

  return (
    <li className="rounded-lg border border-border bg-background/40 px-3 py-2 hover:border-muted transition-colors space-y-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          {label && <div className="text-[11px] text-muted truncate">{label}</div>}
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`font-mono text-xs truncate ${accent} hover:underline`}
            title={address}
          >
            {shorten(address)}
          </a>
        </div>

        <span className="flex-1" />

        <button
          onClick={copy}
          className="text-muted hover:text-foreground transition-colors text-[11px] cursor-pointer"
          title="Copy address"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>

        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted hover:text-foreground transition-colors text-[11px]"
          title="View on Stellar Expert"
        >
          ↗
        </a>

        {(row.step === "idle" || row.step === "failed") && (
          <button
            onClick={() => setRow({ step: "confirm" })}
            disabled={!canSign}
            className="text-muted hover:text-red transition-colors text-[11px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title={canSign ? `Remove this ${kind}` : "Connect the admin wallet to remove"}
          >
            Remove
          </button>
        )}
      </div>

      {row.step === "confirm" && (
        <div className="rounded-lg bg-red/10 px-3 py-2 space-y-2 text-xs">
          <p className="text-foreground">
            Remove {shorten(address)} from the registered {kind}s? You&apos;ll sign one transaction.
          </p>
          {warning && <p className="text-red">{warning}</p>}
          <div className="flex gap-2">
            <button
              onClick={confirmRemoval}
              className="bg-red/20 hover:bg-red/30 text-red border border-red/30 rounded-lg px-3 py-1.5 font-medium cursor-pointer"
            >
              Confirm removal
            </button>
            <button
              onClick={() => setRow({ step: "idle" })}
              className="text-muted hover:text-foreground rounded-lg px-3 py-1.5 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {row.step === "sending" && (
        <p className="text-xs text-muted">Sign in your wallet; submitting once signed…</p>
      )}

      {row.step === "failed" && (
        <p className="text-xs rounded-lg px-3 py-2 bg-red/10 text-red font-mono break-all">{row.error}</p>
      )}
    </li>
  );
}

function shorten(address: string, head = 6, tail = 6): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
