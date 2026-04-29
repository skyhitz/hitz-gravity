"use client";

/**
 * SmartSwap — Multi-path liquidity aggregator for the HITZ ↔ XLM/USDC/AQUA
 * pair, in either direction.
 *
 * Behaviour
 * ─────────
 *  1. The trade always involves HITZ on one side. `mode` says which:
 *        buy  → pay XLM/USDC/AQUA, receive HITZ
 *        sell → pay HITZ,          receive XLM/USDC/AQUA
 *     Clicking the central swap-arrow flips `mode` and clears the amounts.
 *  2. We discover pools, enumerate direct + 2-hop paths, and ask Aqua for
 *     the single-path quote on each in parallel, then search for the
 *     optimal 10%-increment split between the top two.
 *  3. In buy mode, the UI surfaces a live Pressure Detail showing how
 *     close the trade pushes the user to the Event Horizon. In sell mode
 *     there's no pressure to track (balance decreases, no vault risk) so
 *     those panels hide.
 *  4. Crossing the Horizon (buy only) flips the hero to the crimson
 *     HORIZON state and swaps the CTA for CROSS EVENT HORIZON.
 *  5. Execution runs the single best path (Soroban's one-InvokeHostFunction
 *     constraint prevents bundling two router calls into one signed tx);
 *     if splitting would have gained significantly more output, the Route
 *     Map discloses it.
 *
 * The visual shell is the new design's `hero` + `token-field` + `pressure-
 * detail` + `slippage` + `btn` primitives.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applySlippage,
  formatStroops,
  parseAmount,
  pressureRatio,
  willCrossEventHorizon,
} from "../../lib/swap";
import {
  AQUA_ROUTER,
  buildSwapArgs,
  discoverPoolsFromRegistry,
  getAmountInForPath,
  getTokenInfos,
  HITZ_ADDRESS,
  hitzPairTokens,
  refreshPools,
  type PoolInfo,
  type TokenInfo,
} from "../../lib/aqua";
import { listPools } from "../../lib/stellar";
import { aggregate, generatePaths, type AggregationResult, type Path } from "../../lib/aggregator";
import { isRouter } from "../../lib/stellar";
import { useWallet } from "../../contexts/WalletContext";
import { useProtocol } from "../../contexts/ProtocolContext";
import { fmtFixed } from "../../lib/format";

// Props are intentionally empty: we read the wallet + protocol state from
// context so the Pulse bar / Account Pulse stay in sync. The /page.tsx
// Trade panel wraps us directly — no need to thread publicKey down.

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: AggregationResult }
  | { status: "error"; error: string };

type TxState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "success"; hash: string }
  | { status: "error"; error: string };

// The HITZ side is fixed; the alt side is derived purely from which
// pools the admin has registered on the HITZ contract (see `altTokens`
// below). A fresh testnet with only a USDC/HITZ pool shows just USDC
// in the dropdown; registering XLM/HITZ makes XLM appear; etc. Token
// metadata (symbol, decimals, color) is fetched live per-address so
// any SAC the admin trusts renders correctly — including SAC-wrapped
// classic assets whose issuer differs from a hardcoded canon.

/**
 * Derive the list of alt-token addresses from discovered pools.
 * Returns [] while pools are still loading so TokenField falls back
 * to a single-option read-only render.
 */
function useAltTokens(pools: PoolInfo[] | null): string[] {
  return useMemo(() => (pools ? hitzPairTokens(pools) : []), [pools]);
}

type Mode = "buy" | "sell";

const HIGH_IMPACT_THRESHOLD = 3; // percent
const SAVINGS_DISCLOSURE_THRESHOLD = 10n; // stroops — below this don't crow about it

export default function SmartSwap() {
  const { publicKey, callContract } = useWallet();
  const {
    balance,
    safetyLimit,
    vaulted,
    refresh: refreshProtocol,
    setExpectedOut: setCtxExpectedOut,
  } = useProtocol();

  // ─── Form state ───────────────────────────────────────────────────────────
  // `mode` determines which side of the pair is HITZ; `altToken` is the
  // non-HITZ token the user has selected. Together they uniquely determine
  // tokenIn/tokenOut:
  //   buy  → tokenIn = altToken, tokenOut = HITZ
  //   sell → tokenIn = HITZ,     tokenOut = altToken
  const [mode, setMode] = useState<Mode>("buy");
  // `altToken` holds a *contract address* — the canonical identity for
  // a token. Symbols are display-only and resolved via `tokenInfos`.
  // Null until we've loaded at least one registered alt-token.
  const [altToken, setAltToken] = useState<string | null>(null);
  const tokenIn: string | null =
    mode === "buy" ? altToken : altToken ? HITZ_ADDRESS : null;
  const tokenOut: string | null =
    mode === "buy" ? (altToken ? HITZ_ADDRESS : null) : altToken;

  // We carry both sides of the form as editable strings plus a `direction`
  // flag that remembers which field the user last touched. The non-driving
  // field is overwritten by the active quote (forward or reverse). This lets
  // the user type either "I want to pay X" or "I want to receive Y" without
  // losing their place when the quote round-trip returns.
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [direction, setDirection] = useState<"exact-in" | "exact-out">("exact-in");
  const [reverseLoading, setReverseLoading] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [slippageBps, setSlippageBps] = useState(50); // 0.5%

  // Flip buy ↔ sell. Clears the amounts + quote because the reverse pair
  // almost certainly produces a different optimal path, and keeping stale
  // numbers on screen during the re-quote is confusing.
  const flipMode = useCallback(() => {
    setMode((m) => (m === "buy" ? "sell" : "buy"));
    setAmountIn("");
    setAmountOut("");
    setDirection("exact-in");
  }, []);

  // ─── Pools + whitelist (one-off on mount) ────────────────────────────────
  const [pools, setPools] = useState<PoolInfo[] | null>(null);
  const [routerWhitelisted, setRouterWhitelisted] = useState<boolean | null>(null);

  // Alt-token addresses surfaced by the registry. While pools are
  // still loading this is [] and the dropdown falls back to a single-
  // option read-only render.
  const altTokens = useAltTokens(pools);

  // Token metadata — symbol, decimals, color — for every address that
  // appears in any pool. Loaded once per pool-set and looked up
  // synchronously thereafter. Tokens that fail to resolve are absent
  // from the map; UI falls back to a truncated address in that case.
  const [tokenInfos, setTokenInfos] = useState<Map<string, TokenInfo>>(new Map());

  useEffect(() => {
    if (!pools) return;
    let cancelled = false;
    const addrs = new Set<string>([HITZ_ADDRESS]);
    for (const p of pools) {
      addrs.add(p.tokenA);
      addrs.add(p.tokenB);
    }
    void getTokenInfos([...addrs]).then((m) => {
      if (!cancelled) setTokenInfos(m);
    });
    return () => {
      cancelled = true;
    };
  }, [pools]);

  // Pick a default alt-token once the registry list lands. If the user
  // had a different one selected and it survived the refresh, keep it;
  // otherwise jump to the first available.
  useEffect(() => {
    if (altTokens.length === 0) return;
    if (altToken === null || !altTokens.includes(altToken)) {
      setAltToken(altTokens[0]);
      setAmountIn("");
      setAmountOut("");
      setDirection("exact-in");
    }
  }, [altTokens, altToken]);

  // ─── Async state ──────────────────────────────────────────────────────────
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: "idle" });
  const [txState, setTxState] = useState<TxState>({ status: "idle" });

  // ─── Load pools + whitelist ───────────────────────────────────────────────
  //
  // The swap's pool set is derived from what the admin has registered
  // on the HITZ contract itself — that's the single source of truth
  // the user interacts with ("register a pool → see its alt token
  // appear here"). For each registered C-address we call
  // `get_tokens()`, then cross-reference Aqua's router to get a
  // tradable `pool_index`. Non-AMM or non-Aqua-indexed pools are
  // dropped silently — they're valid for TotalMass but not for
  // SmartSwap routing.
  //
  // Reloads on mount + on every window-focus (covers "registered a
  // new pool in another tab, came back"). `refreshPools()` blows the
  // module cache so each reload hits the chain afresh.
  const loadPools = useCallback(async () => {
    try {
      refreshPools();
      const [registered, whitelisted] = await Promise.all([
        listPools().catch(() => []),
        isRouter(AQUA_ROUTER).catch(() => false),
      ]);
      const p = await discoverPoolsFromRegistry(registered);
      setPools(p);
      setRouterWhitelisted(whitelisted);
    } catch {
      // Leave loaders at null — UI shows a neutral fallback.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [registered, whitelisted] = await Promise.all([
          listPools().catch(() => []),
          isRouter(AQUA_ROUTER).catch(() => false),
        ]);
        if (cancelled) return;
        const p = await discoverPoolsFromRegistry(registered);
        if (cancelled) return;
        setPools(p);
        setRouterWhitelisted(whitelisted);
      } catch {
        /* swallow — fallback handled above */
      }
    })();

    const onFocus = () => {
      if (!cancelled) void loadPools();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [loadPools]);

  // ─── Forward quote (exact-in): debouncer + race-guard ────────────────────
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (direction !== "exact-in") return;
    const amountStroops = parseAmount(amountIn);
    if (amountStroops <= 0n || !pools || !tokenIn || !tokenOut) {
      setQuoteState({ status: "idle" });
      if (amountIn === "") setAmountOut("");
      return;
    }

    const seq = ++quoteSeq.current;
    setQuoteState({ status: "loading" });

    const handle = setTimeout(async () => {
      try {
        const result = await aggregate({
          tokenIn,
          tokenOut,
          amountIn: amountStroops,
          pools,
        });
        if (seq !== quoteSeq.current) return;
        setQuoteState({ status: "ready", result });
        // Mirror the authoritative output into the display field so the user
        // sees the split-optimised total, not just the target they typed.
        setAmountOut(formatStroops(result.distribution.totalOut));
      } catch (err) {
        if (seq !== quoteSeq.current) return;
        setQuoteState({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 400);

    return () => clearTimeout(handle);
  }, [amountIn, tokenIn, tokenOut, pools, direction]);

  // ─── Reverse quote (exact-out): find min amountIn for target output ─────
  // Aqua has no reverse primitive, so we ask each path what input yields the
  // target HITZ output (via `getAmountInForPath`, a Newton-style invert of
  // `estimate_swap`), pick the path requiring the smallest input, then let
  // the forward aggregator take over from that computed amountIn. This keeps
  // the route-map, split search, and pressure-detail logic on a single code
  // path — reverse-mode is just "compute amountIn, then forward-quote it".
  const reverseSeq = useRef(0);
  useEffect(() => {
    if (direction !== "exact-out") return;
    const targetOut = parseAmount(amountOut);
    if (targetOut <= 0n || !pools || !tokenIn || !tokenOut) {
      setQuoteState({ status: "idle" });
      setReverseLoading(false);
      setReverseError(null);
      if (amountOut === "") setAmountIn("");
      return;
    }

    const seq = ++reverseSeq.current;
    setReverseLoading(true);
    setReverseError(null);

    const handle = setTimeout(async () => {
      try {
        const paths = generatePaths(tokenIn, tokenOut, pools);
        if (paths.length === 0) throw new Error(`No paths from ${tokenIn} to ${tokenOut}`);

        const reverseQuotes = await Promise.all(
          paths.map(async (p) => ({
            path: p,
            amountIn: await getAmountInForPath(p.hops, targetOut, pools),
          }))
        );
        if (seq !== reverseSeq.current) return;

        const live = reverseQuotes.filter(
          (q): q is { path: Path; amountIn: bigint } => q.amountIn !== null
        );
        if (live.length === 0) throw new Error("No live liquidity on any path");

        // Cheapest input wins.
        const best = live.reduce((m, q) => (q.amountIn < m.amountIn ? q : m));

        // Hand the input to the forward aggregator so the route-map reflects
        // the split-optimum at that size. Switch direction back to exact-in
        // so subsequent edits of amountIn behave normally.
        setAmountIn(formatStroops(best.amountIn));
        setDirection("exact-in");
        setReverseLoading(false);
      } catch (err) {
        if (seq !== reverseSeq.current) return;
        setReverseError(err instanceof Error ? err.message : String(err));
        setReverseLoading(false);
        setQuoteState({ status: "idle" });
      }
    }, 500);

    return () => clearTimeout(handle);
  }, [amountOut, tokenIn, tokenOut, pools, direction]);

  // ─── Derived physics ──────────────────────────────────────────────────────
  const currentResult = quoteState.status === "ready" ? quoteState.result : null;
  const totalOut = currentResult?.distribution.totalOut ?? 0n;

  // Push the live what-if into ProtocolContext so the Pulse bar + Orbit
  // reflect it. Only when BUYING HITZ — selling reduces balance and has no
  // bearing on the Event Horizon gauge.
  useEffect(() => {
    if (mode !== "buy") {
      setCtxExpectedOut(0n);
      return;
    }
    setCtxExpectedOut(totalOut);
    return () => {
      // Clearing on unmount so leaving the Trade tab doesn't leave a ghost gauge.
      setCtxExpectedOut(0n);
    };
  }, [totalOut, setCtxExpectedOut, mode]);

  const willVault = useMemo(() => {
    if (mode !== "buy") return false;
    if (!currentResult || safetyLimit === 0n || balance === null) return false;
    return willCrossEventHorizon(balance, totalOut, safetyLimit);
  }, [mode, currentResult, totalOut, safetyLimit, balance]);

  const pressurePct = useMemo(() => {
    if (mode !== "buy") return 0;
    if (safetyLimit === 0n) return 0;
    return pressureRatio(balance ?? 0n, totalOut, safetyLimit);
  }, [mode, balance, totalOut, safetyLimit]);

  const heroStateKey: "safe" | "warn" | "horizon" =
    willVault ? "horizon" : pressurePct > 75 ? "warn" : "safe";
  const heroStateLabel: string =
    heroStateKey === "horizon"
      ? "Crossing Horizon"
      : heroStateKey === "warn"
        ? "Near Event Horizon"
        : "Safe Orbit";

  // ─── Execute swap — single best path ──────────────────────────────────────
  //
  // Builds just the {method, args} tuple, then hands it to callContract —
  // which routes to the wallet flow (sim + sign + submit locally) for
  // wallet users, or to the gateway (fee-bumped by the sponsor) for email
  // users. The UI state machine is identical in both cases.
  const handleSwap = useCallback(async () => {
    if (!publicKey || !currentResult) return;
    setTxState({ status: "building" });

    try {
      const legs = [...currentResult.distribution.legs].sort(
        (a, b) => (b.amountOut > a.amountOut ? 1 : -1)
      );
      const primary = legs[0];
      if (!primary) throw new Error("No executable leg in distribution");

      if (!pools) throw new Error("Pool graph not loaded");
      const call = await buildSwapArgs({
        userAddress: publicKey,
        path: primary.path.hops,
        amountIn: parseAmount(amountIn),
        amountOut: currentResult.bestSinglePathOut,
        slippageBps,
        // Thread the same registry-backed pool graph the UI displayed
        // — the swap call binds to exactly the registered pools.
        pools,
      });

      setTxState({ status: "signing" });
      const result = await callContract(call.contractId, call.method, call.args);

      if (result.success && result.hash) {
        setTxState({ status: "success", hash: result.hash });
        // Clear the form so the user doesn't read the just-quoted numbers
        // as their *next* trade — leaving the amounts populated after a
        // successful swap made the screen look like the user was about to
        // re-cross the Event Horizon.
        setAmountIn("");
        setAmountOut("");
        setDirection("exact-in");
        setQuoteState({ status: "idle" });
        refreshProtocol();
      } else {
        setTxState({
          status: "error",
          error: result.error || "Transaction failed",
        });
      }
    } catch (err) {
      setTxState({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [publicKey, currentResult, callContract, amountIn, slippageBps, refreshProtocol, pools]);

  // ─── Vaulted short-circuit ─────────────────────────────────────────────────
  // A vaulted account cannot execute non-sacrifice transfers anyway; show the
  // explicit "locked" state instead of a misleading disabled form.
  if (vaulted) {
    return (
      <div className="hero vaulted fade-in">
        <div className="hero-header">
          <div className="hero-status">
            <span className="hero-status-dot" />
            <span className="hero-status-label">Vaulted · Trade locked</span>
          </div>
          <span className="hero-title">Smart Swap</span>
        </div>
        <div className="hero-body">
          <div className="alert danger">
            <span className="icon">⛔</span>
            <div>
              Your account is Vaulted. Outbound transfers are blocked until
              you Sacrifice to an audited pool (which grows <strong>S</strong>{" "}
              and raises <strong>L</strong>) or the Event Horizon rises on
              its own. Head to the <strong>Vault</strong> tab to run the
              ritual.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={`hero ${heroStateKey} fade-in`}>
      <div className="hero-header">
        <div className="hero-status">
          <span className="hero-status-dot" />
          <span className="hero-status-label">{heroStateLabel}</span>
        </div>
        <span className="hero-title">Smart Swap</span>
      </div>
      <div className="hero-body">
        <p
          style={{
            fontSize: 12,
            color: "var(--muted)",
            lineHeight: 1.6,
            margin: "0 0 16px",
          }}
        >
          Multi-path aggregator. The engine enumerates every direct and 2-hop
          route to HITZ, asks Aqua for on-chain quotes in parallel, and splits
          your trade across the pools that together yield the most output.
        </p>

        {/* ── Input + output + arrow ──────────────────────────────────────── */}
        {/*
         * Only the non-HITZ side of the pair gets a token dropdown; the HITZ
         * side is locked. In buy mode the dropdown is on the top field; in
         * sell mode it's on the bottom. Picking a new altToken inside the
         * dropdown also flips `direction` back to exact-in so the reverse
         * inverter doesn't race against the token change.
         */}
        <TokenField
          label={direction === "exact-in" ? "You pay" : "You pay (est.)"}
          tokenAddress={tokenIn}
          tokenInfos={tokenInfos}
          onTokenChange={
            mode === "buy"
              ? (t) => {
                  setAltToken(t);
                  if (direction === "exact-out") setDirection("exact-in");
                }
              : undefined
          }
          value={amountIn}
          onValueChange={(v) => {
            setAmountIn(v);
            setDirection("exact-in");
          }}
          availableTokens={mode === "buy" ? altTokens : [HITZ_ADDRESS]}
          editable
          loading={direction === "exact-out" && reverseLoading}
        />

        <SwapArrow onClick={flipMode} />

        <TokenField
          label={direction === "exact-out" ? "You receive" : "You receive (est.)"}
          tokenAddress={tokenOut}
          tokenInfos={tokenInfos}
          onTokenChange={
            mode === "sell"
              ? (t) => {
                  setAltToken(t);
                  if (direction === "exact-out") setDirection("exact-in");
                }
              : undefined
          }
          value={amountOut}
          onValueChange={(v) => {
            setAmountOut(v);
            setDirection("exact-out");
          }}
          availableTokens={mode === "sell" ? altTokens : [HITZ_ADDRESS]}
          editable
          loading={direction === "exact-in" && quoteState.status === "loading"}
          danger={willVault}
        />

        {/* ── Route map ───────────────────────────────────────────────────── */}
        {currentResult && tokenIn && tokenOut && (
          <div style={{ marginTop: 14 }}>
            <RouteMap
              result={currentResult}
              tokenInAddress={tokenIn}
              tokenOutAddress={tokenOut}
              tokenInfos={tokenInfos}
            />
          </div>
        )}

        {quoteState.status === "error" && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{quoteState.error}</div>
          </div>
        )}

        {reverseError && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>
              Couldn&apos;t compute required input: {reverseError}
            </div>
          </div>
        )}

        {/* ── Slippage ────────────────────────────────────────────────────── */}
        <div style={{ marginTop: 14 }} className="slippage">
          <div className="slippage-head">
            <span className="lbl">Slippage tolerance</span>
            <span className="val">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          <input
            type="range"
            min={10}
            max={300}
            step={10}
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
          />
          <div className="slippage-ticks">
            <span>0.10%</span>
            <span>1.50%</span>
            <span>3.00%</span>
          </div>
        </div>

        {/* ── Pressure detail ─────────────────────────────────────────────── */}
        {/* Pressure/Event-Horizon only meaningful when BUYING HITZ. Selling
            reduces balance, which only lowers pressure, so the panel
            would always read "safer" — noisy and misleading. Hide it. */}
        {mode === "buy" && (
          <PressureDetail
            pressurePct={pressurePct}
            willVault={willVault}
            balance={balance}
            totalOut={totalOut}
            safetyLimit={safetyLimit}
          />
        )}

        {/* Sell mode: show HITZ balance so the user knows their ceiling. */}
        {mode === "sell" && balance !== null && (
          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              color: "var(--muted)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>HITZ balance</span>
            <span className="mono" style={{ color: "var(--foreground)" }}>
              {fmtFixed(balance, 4)}
            </span>
          </div>
        )}

        {/* ── Physics alerts ──────────────────────────────────────────────── */}
        {willVault && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div>
              <strong>GRAVITY DISTORTION.</strong> Aggregate output crosses the
              Event Horizon. Your account will be permanently{" "}
              <strong>Vaulted</strong>, with outbound transfers blocked until a
              non-refundable Sacrifice is made or the Horizon shifts outward.
            </div>
          </div>
        )}

        {mode === "buy" && routerWhitelisted === false && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div>
              The Aqua router is not whitelisted on the HITZ contract. Incoming
              HITZ from this swap will be treated as a silent-trap Vaulting.
            </div>
          </div>
        )}

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <div style={{ marginTop: 16 }}>
          <SwapButton
            publicKey={publicKey}
            disabled={!currentResult || quoteState.status !== "ready"}
            willVault={willVault}
            txState={txState}
            onClick={handleSwap}
            amountOutMin={
              currentResult
                ? applySlippage(currentResult.bestSinglePathOut, slippageBps)
                : 0n
            }
          />
        </div>

        {/* ── Tx status ───────────────────────────────────────────────────── */}
        {txState.status === "success" && (
          <div className="alert info" style={{ marginTop: 14 }}>
            <span className="icon">✓</span>
            <div>
              Swap confirmed ·{" "}
              <a
                href={`https://stellar.expert/explorer/public/tx/${txState.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                view tx
              </a>
            </div>
          </div>
        )}
        {txState.status === "error" && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{txState.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TokenField ──────────────────────────────────────────────────────────────

function TokenField({
  label,
  tokenAddress,
  tokenInfos,
  onTokenChange,
  value,
  onValueChange,
  availableTokens,
  editable,
  loading = false,
  danger = false,
}: {
  label: string;
  tokenAddress: string | null;
  tokenInfos: Map<string, TokenInfo>;
  onTokenChange?: (addr: string) => void;
  value: string;
  onValueChange: (v: string) => void;
  availableTokens: string[];
  editable: boolean;
  loading?: boolean;
  danger?: boolean;
}) {
  const info = tokenAddress ? tokenInfos.get(tokenAddress) ?? null : null;
  const symbol = info?.symbol ?? (tokenAddress ? truncateAddr(tokenAddress) : "–");
  const dot = info?.color ?? "var(--muted)";
  const canSwitch = editable && availableTokens.length > 1 && onTokenChange;
  const [open, setOpen] = useState(false);

  return (
    <div className={`token-field ${danger ? "danger" : ""}`}>
      <div className="token-field-label">{label}</div>
      <div className="token-field-row">
        <input
          className="token-input"
          value={loading ? "…" : value}
          onChange={(e) => onValueChange(e.target.value)}
          readOnly={!editable}
          placeholder="0.00"
          inputMode="decimal"
          style={loading ? { opacity: 0.5 } : undefined}
        />
        {canSwitch ? (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="token-pill select"
              onClick={() => setOpen((o) => !o)}
            >
              <span className="dot" style={{ background: dot }} />
              <span>{symbol}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.6, marginLeft: 2 }}
              >
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 40 }}
                  onClick={() => setOpen(false)}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 6px)",
                    zIndex: 50,
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    minWidth: 180,
                    padding: 4,
                    boxShadow: "0 20px 40px -10px rgba(0,0,0,0.8)",
                  }}
                >
                  {availableTokens.map((t) => {
                    const ti = tokenInfos.get(t);
                    const sym = ti?.symbol ?? truncateAddr(t);
                    const c = ti?.color ?? "var(--muted)";
                    return (
                      <button
                        key={t}
                        onClick={() => {
                          onTokenChange!(t);
                          setOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          width: "100%",
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: 0,
                          background: t === tokenAddress ? "var(--bg-2)" : "transparent",
                          color: "var(--foreground)",
                          fontSize: 13,
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            background: c,
                          }}
                        />
                        <span style={{ fontWeight: 500 }}>{sym}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="token-pill">
            <span className="dot" style={{ background: dot }} />
            <span>{symbol}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function truncateAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function SwapArrow({ onClick }: { onClick: () => void }) {
  // Rendered as a <button> so keyboard users get native focus/activate
  // semantics. The .swap-arrow-inner class already styles the 34px dark
  // circle + hover — we just clear the user-agent <button> defaults so the
  // class's visual survives (otherwise browsers paint their own border).
  return (
    <div className="swap-arrow">
      <button
        type="button"
        onClick={onClick}
        aria-label="Swap direction"
        className="swap-arrow-inner"
        style={{ padding: 0, font: "inherit" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 3v13m0 0l-4-4m4 4l4-4M17 21V8m0 0l-4 4m4-4l4 4" />
        </svg>
      </button>
    </div>
  );
}

// ─── RouteMap ────────────────────────────────────────────────────────────────

function RouteMap({
  result,
  tokenInAddress,
  tokenOutAddress,
  tokenInfos,
}: {
  result: AggregationResult;
  tokenInAddress: string;
  tokenOutAddress: string;
  tokenInfos: Map<string, TokenInfo>;
}) {
  const { distribution, savings, isSplit, priceImpactPct, bestSinglePathOut } = result;
  const tokenInSymbol =
    tokenInfos.get(tokenInAddress)?.symbol ?? truncateAddr(tokenInAddress);
  const tokenOutSymbol =
    tokenInfos.get(tokenOutAddress)?.symbol ?? truncateAddr(tokenOutAddress);

  // Bridges in this aggregation = any non-endpoint hop appearing in any leg.
  // Derived from the actual chosen paths so the label reflects what the
  // engine routed through, not a hardcoded list.
  const bridgeAddrs = new Set<string>();
  for (const leg of distribution.legs) {
    for (let i = 1; i < leg.path.hops.length - 1; i++) {
      bridgeAddrs.add(leg.path.hops[i]);
    }
  }
  const bridgeLabels = Array.from(bridgeAddrs).map(
    (a) => tokenInfos.get(a)?.symbol ?? truncateAddr(a)
  );

  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "rgba(15,15,17,0.4)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header with badges */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: "0.15em",
            }}
          >
            Route
          </span>
          {isSplit && <Badge color="var(--accent)" label="Split" dot />}
          {savings > SAVINGS_DISCLOSURE_THRESHOLD && bestSinglePathOut > 0n && (
            <Badge
              color="var(--green)"
              label={`★ Best price · +${formatStroops(savings)} ${tokenOutSymbol}`}
            />
          )}
        </div>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color:
              priceImpactPct >= HIGH_IMPACT_THRESHOLD
                ? "var(--orange)"
                : "var(--muted)",
          }}
        >
          impact {priceImpactPct.toFixed(2)}%
        </span>
      </div>

      {/* Stacked bar */}
      <div
        style={{
          display: "flex",
          height: 6,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--border)",
        }}
      >
        {distribution.legs.map((leg, i) => (
          <div
            key={i}
            style={{
              height: "100%",
              width: `${leg.percent}%`,
              background: legColor(i),
              transition: "width 300ms ease-out",
            }}
            title={`${leg.percent}% via ${leg.path.hops
              .map((a) => tokenInfos.get(a)?.symbol ?? truncateAddr(a))
              .join(" → ")}`}
          />
        ))}
      </div>

      {/* Per-leg breakdown */}
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {distribution.legs.map((leg, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 11,
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: legColor(i),
                  flexShrink: 0,
                }}
              />
              <span
                className="mono"
                style={{
                  width: 36,
                  flexShrink: 0,
                  color: "var(--foreground)",
                }}
              >
                {leg.percent}%
              </span>
              <PathDisplay path={leg.path} tokenInfos={tokenInfos} />
            </span>
            <span
              className="mono"
              style={{ color: "var(--muted)", flexShrink: 0 }}
            >
              → {formatStroops(leg.amountOut)} {tokenOutSymbol}
            </span>
          </li>
        ))}
      </ul>

      {/* High-impact warning */}
      {priceImpactPct >= HIGH_IMPACT_THRESHOLD && (
        <div className="alert warn" style={{ fontSize: 11 }}>
          <span className="icon">!</span>
          <div>
            <strong>High slippage.</strong> Aggregate impact is{" "}
            {priceImpactPct.toFixed(2)}%. Total pool liquidity is thin for
            this size. Consider splitting your trade over time.
          </div>
        </div>
      )}

      {/* Soroban single-path disclosure */}
      {isSplit && (
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.5,
            padding: "8px 10px",
            background: "rgba(255,255,255,0.02)",
            borderRadius: 8,
          }}
        >
          Soroban allows one host-function call per transaction, so execution
          runs the best single path. The split above is the optimum if you
          wish to trade each leg separately.
        </div>
      )}

      {/* Input / bridges echo */}
      <div
        style={{
          fontSize: 10,
          color: "var(--muted-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingTop: 8,
          borderTop: "1px solid var(--border-soft)",
        }}
      >
        <span style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>
          Input
        </span>
        <span className="mono">{tokenInSymbol}</span>
        <span>·</span>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>
          Bridges
        </span>
        <span className="mono">
          {bridgeLabels.length > 0 ? bridgeLabels.join(", ") : "none"}
        </span>
      </div>
    </div>
  );
}

function Badge({
  color,
  label,
  dot = false,
}: {
  color: string;
  label: string;
  dot?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 9,
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        border: `1px solid ${color}4D`,
        background: `${color}1A`,
        color,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: color,
          }}
        />
      )}
      {label}
    </span>
  );
}

function PathDisplay({
  path,
  tokenInfos,
}: {
  path: Path;
  tokenInfos: Map<string, TokenInfo>;
}) {
  return (
    <span
      style={{
        color: "var(--muted)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {path.hops.map((addr, i) => {
        const sym = tokenInfos.get(addr)?.symbol ?? truncateAddr(addr);
        return (
          <span key={i}>
            {i > 0 && (
              <span style={{ color: "var(--muted-soft)", margin: "0 4px" }}>
                →
              </span>
            )}
            <span
              style={{
                color:
                  i === 0 || i === path.hops.length - 1
                    ? "var(--foreground)"
                    : "var(--muted)",
              }}
            >
              {sym}
            </span>
          </span>
        );
      })}
      <span style={{ color: "var(--muted-soft)", marginLeft: 8 }}>
        · {path.kind}
      </span>
    </span>
  );
}

const LEG_COLORS = ["var(--accent)", "var(--purple)", "var(--orange)"] as const;
function legColor(i: number): string {
  return LEG_COLORS[i % LEG_COLORS.length];
}

// ─── PressureDetail ──────────────────────────────────────────────────────────

function PressureDetail({
  pressurePct,
  willVault,
  balance,
  totalOut,
  safetyLimit,
}: {
  pressurePct: number;
  willVault: boolean;
  balance: bigint | null;
  totalOut: bigint;
  safetyLimit: bigint;
}) {
  const safeBalance = balance ?? 0n;
  const after = safeBalance + totalOut;
  const cls = willVault ? "danger" : pressurePct > 75 ? "warn" : "safe";
  const visual = Math.min(100, pressurePct);

  return (
    <div className="pressure-detail">
      <div className="pressure-row">
        <span className="lbl">Live Pressure</span>
        <span
          className="val"
          style={{ color: willVault ? "var(--red)" : "var(--foreground)" }}
        >
          {pressurePct.toFixed(1)}% of L
        </span>
      </div>
      <div className="pressure-track">
        <div
          className={`pressure-fill ${cls}`}
          style={{ width: `${visual}%` }}
        />
      </div>
      <div className="pressure-stats">
        <Stat label="Balance" value={fmtFixed(balance, 4)} />
        <Stat
          label="After swap"
          value={totalOut > 0n ? fmtFixed(after, 4) : "–"}
          red={willVault}
        />
        <Stat
          label="Event Horizon"
          value={safetyLimit > 0n ? fmtFixed(safetyLimit, 4) : "–"}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  red = false,
}: {
  label: string;
  value: string;
  red?: boolean;
}) {
  return (
    <div className="pressure-stat">
      <span className="k">{label}</span>
      <span className={`v ${red ? "red" : ""}`}>{value}</span>
    </div>
  );
}

// ─── SwapButton ──────────────────────────────────────────────────────────────

function SwapButton({
  publicKey,
  disabled,
  willVault,
  txState,
  onClick,
  amountOutMin,
}: {
  publicKey: string | null;
  disabled: boolean;
  willVault: boolean;
  txState: TxState;
  onClick: () => void;
  amountOutMin: bigint;
}) {
  const busy = ["building", "signing", "submitting"].includes(txState.status);
  const isDisabled = !publicKey || disabled || busy;

  const label = (() => {
    if (!publicKey) return "Connect wallet to swap";
    if (disabled) return "Enter an amount";
    if (txState.status === "building") return "Building transaction…";
    if (txState.status === "signing") return "Awaiting signature…";
    if (txState.status === "submitting") return "Submitting…";
    if (willVault) return "CROSS EVENT HORIZON";
    return amountOutMin > 0n
      ? `Swap · min ${formatStroops(amountOutMin)}`
      : "Swap";
  })();

  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`btn ${willVault ? "danger" : "primary"}`}
    >
      {busy ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            justifyContent: "center",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 14,
              height: 14,
              border: "2px solid rgba(255,255,255,0.3)",
              borderTopColor: "white",
              borderRadius: "50%",
              animation: "slow-spin 0.8s linear infinite",
            }}
          />
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
