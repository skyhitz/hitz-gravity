"use client";

/**
 * VaultSwap: the Trade tab: swap HITZ, XLM and USDC (and any asset the
 * vault lists later) through the Sovereign Vault, HITZ's own exchange.
 *
 *  - HITZ ↔ asset is one hop through that asset's pool; asset ↔ asset is two
 *    hops through HITZ, still one `swap` call and one signature.
 *  - Quotes come from the exact port of the contract math (lib/vaultMath.ts)
 *    over a live `pools()` read, so the per-hop fees show instantly. The
 *    contract's own `quote` then confirms the amount; the button waits for it,
 *    and `min_out` is that amount minus the slippage budget.
 *  - The fee is 1% when the vault is calm. A hop that leaves one asset
 *    dislocated against another pays 1% × e^(100·D), capped at 10%, so the
 *    route panel shows each hop's fee and what the trade leaves behind.
 *  - Buying HITZ moves it out of the vault (a registered pool), which lowers
 *    S and L a little; the Event Horizon check uses the L the trade leaves.
 *  - Vaulted accounts can still trade: selling HITZ into the vault is a
 *    transfer to a registered pool, which the token always allows.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "../contexts/WalletContext";
import { useProtocol } from "../contexts/ProtocolContext";
import { useVaultPools } from "../lib/useVaultPools";
import {
  HITZ_ADDRESS,
  XLM_SAC,
  getTokenInfos,
  knownToken,
  readBalance,
  type BalanceRead,
  type TokenInfo,
} from "../lib/tokens";
import { explainVaultError, quoteOnChain, swapCall } from "../lib/vault";
import {
  FEE_CAP,
  FEE_FLOOR,
  VaultMathError,
  inputForOutput,
  poolsFromStates,
  swap as vaultSwap,
  type Hop,
  type PoolState,
} from "../lib/vaultMath";
import { applySlippage, formatStroops } from "../lib/swap";
import { fmtFixed } from "../lib/format";
import { limitFor } from "../lib/gravity";
import { isPool, isRouter } from "../lib/stellar";

type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "success"; hash: string }
  | { status: "error"; error: string };

interface LocalQuote {
  amountIn: bigint;
  amountOut: bigint;
  hops: Hop[];
  /** Output at the pools' current prices with no fee (float, raw units). */
  spotOut: number;
  /** amountOut / spotOut − 1: price impact including fees. */
  impact: number;
}

const ELEVATED_FEE = 15_000_000n; // 1.5%
const XLM_HEADROOM = 30_000_000n; // keep 3 XLM for reserves and fees on "Max"

/** Parse a decimal string into raw units; null when it isn't a number. */
function parseUnits(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!t) return 0n;
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const [whole = "", frac = ""] = t.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac.padEnd(decimals, "0").slice(0, decimals)) || "0");
}

const pct = (rate: bigint) => `${(Number(rate) / 1e7).toFixed(2)}%`;

function quoteLocally(states: PoolState[], tokenIn: string, tokenOut: string, amountIn: bigint): LocalQuote {
  const pools = poolsFromStates(states);
  const r = vaultSwap(pools, tokenIn, tokenOut, amountIn, 0n, HITZ_ADDRESS);
  let spot = Number(amountIn);
  for (const h of r.hops) {
    const p = states[h.pool];
    spot *= h.hitzIn ? Number(p.reserve) / Number(p.hitz) : Number(p.hitz) / Number(p.reserve);
  }
  return { amountIn, amountOut: r.amountOut, hops: r.hops, spotOut: spot, impact: Number(r.amountOut) / spot - 1 };
}

function describeMathError(err: unknown): string {
  if (err instanceof VaultMathError) {
    if (err.message === "TradeTooSmall") return "Trade too small: the output rounds to zero after the fee.";
    if (err.message === "NotSeeded") return "This asset is listed but its pool isn't seeded yet.";
    if (err.message === "UnsupportedPair") return "The vault doesn't trade this pair.";
  }
  return err instanceof Error ? err.message : String(err);
}

/** A token's balance for the connected account, re-read when `nonce` changes. */
function useTokenBalance(token: string, account: string | null, nonce: number): BalanceRead | null {
  const [state, setState] = useState<{ key: string; read: BalanceRead } | null>(null);
  const key = `${token}|${account}|${nonce}`;
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void readBalance(token, account).then((read) => {
      if (!cancelled) setState({ key, read });
    });
    return () => {
      cancelled = true;
    };
  }, [token, account, key]);
  return state && state.key === key ? state.read : null;
}

export default function VaultSwap() {
  const { publicKey, callContract } = useWallet();
  const {
    balance: hitzBalance,
    safetyLimit,
    totalMass,
    vaulted,
    refresh: refreshProtocol,
    setExpectedOut,
  } = useProtocol();
  const { pools: states, readAt, error: poolsError, refresh: refreshPools } = useVaultPools();

  // ─── Tokens ───────────────────────────────────────────────────────────────
  const tokens = useMemo(() => [HITZ_ADDRESS, ...(states?.map((p) => p.asset) ?? [XLM_SAC])], [states]);
  const tokensKey = tokens.join(",");
  const [infos, setInfos] = useState<Map<string, TokenInfo>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void getTokenInfos(tokensKey.split(",")).then((m) => {
      if (!cancelled) setInfos(m);
    });
    return () => {
      cancelled = true;
    };
  }, [tokensKey]);
  const info = useCallback(
    (t: string): TokenInfo => infos.get(t) ?? knownToken(t) ?? { address: t, symbol: `${t.slice(0, 4)}…`, decimals: 7, color: "var(--muted)" },
    [infos]
  );

  const [tokenIn, setTokenIn] = useState<string>(XLM_SAC);
  const [tokenOut, setTokenOut] = useState<string>(HITZ_ADDRESS);
  const inInfo = info(tokenIn);
  const outInfo = info(tokenOut);
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  // Registered pools and routers (the treasury, for one) are never vaulted.
  const [exempt, setExempt] = useState<{ account: string; exempt: boolean } | null>(null);
  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    void Promise.all([isPool(publicKey), isRouter(publicKey)])
      .then(([p, r]) => {
        if (!cancelled) setExempt({ account: publicKey, exempt: p || r });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [publicKey]);
  const isExempt = exempt?.account === publicKey && exempt.exempt;

  const pick = (side: "in" | "out", t: string) => {
    const other = side === "in" ? tokenOut : tokenIn;
    if (t === other) {
      // Picking the other side's token flips the pair.
      setTokenIn(tokenOut);
      setTokenOut(tokenIn);
    } else if (side === "in") {
      setTokenIn(t);
    } else {
      setTokenOut(t);
    }
    setTyped("");
    setTx({ status: "idle" });
  };

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setTyped("");
    setDirection("exact-in");
    setTx({ status: "idle" });
  };

  // ─── Amounts ──────────────────────────────────────────────────────────────
  // One typed field drives the other: exact-in quotes forward, exact-out
  // finds the smallest input that pays at least the typed output.
  const [typed, setTyped] = useState("");
  const [direction, setDirection] = useState<"exact-in" | "exact-out">("exact-in");
  const [slippageBps, setSlippageBps] = useState(50);

  const derived = useMemo((): { quote: LocalQuote | null; error: string | null; inStroops: bigint } => {
    const dec = direction === "exact-in" ? inInfo.decimals : outInfo.decimals;
    const amount = parseUnits(typed, dec);
    if (amount === null) return { quote: null, error: "Enter a number, like 12.5", inStroops: 0n };
    if (amount === 0n || !states) return { quote: null, error: null, inStroops: 0n };
    try {
      let amountIn = amount;
      if (direction === "exact-out") {
        const need = inputForOutput(poolsFromStates(states), tokenIn, tokenOut, amount, 0n, HITZ_ADDRESS);
        if (need === null) {
          return { quote: null, error: `The vault can't pay out that much ${outInfo.symbol}.`, inStroops: 0n };
        }
        amountIn = need;
      }
      return { quote: quoteLocally(states, tokenIn, tokenOut, amountIn), error: null, inStroops: amountIn };
    } catch (err) {
      return { quote: null, error: describeMathError(err), inStroops: 0n };
    }
  }, [typed, direction, states, tokenIn, tokenOut, inInfo.decimals, outInfo.decimals, outInfo.symbol]);
  const { quote, inStroops } = derived;

  // ─── On-chain confirmation ────────────────────────────────────────────────
  const quoteKey = `${tokenIn}|${tokenOut}|${inStroops}|${readAt}`;
  const [chain, setChain] = useState<{ key: string; out: bigint | null; error: string | null } | null>(null);
  useEffect(() => {
    if (inStroops <= 0n || !quote) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      quoteOnChain(tokenIn, tokenOut, inStroops)
        .then((out) => {
          if (!cancelled) setChain({ key: quoteKey, out, error: null });
        })
        .catch((err) => {
          if (!cancelled) setChain({ key: quoteKey, out: null, error: explainVaultError(err instanceof Error ? err.message : String(err)) });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [quoteKey, tokenIn, tokenOut, inStroops, quote]);
  const confirmed = chain && chain.key === quoteKey ? chain : null;
  const confirmedOut = confirmed?.out ?? null;
  // A trade landed since our read: re-read the pools so the breakdown
  // matches the chain again. Decay alone moves quotes by far less than
  // 0.1% between ledgers, so it doesn't count; and at most every 5 s.
  const drifted =
    confirmedOut !== null &&
    quote !== null &&
    (confirmedOut > quote.amountOut ? confirmedOut - quote.amountOut : quote.amountOut - confirmedOut) * 1000n > quote.amountOut;
  useEffect(() => {
    if (drifted && readAt !== null && Date.now() - readAt > 5_000) void refreshPools();
  }, [drifted, readAt, refreshPools]);

  const amountOut = confirmedOut ?? quote?.amountOut ?? 0n;
  const displayIn = direction === "exact-in" ? typed : inStroops > 0n ? formatStroops(inStroops, inInfo.decimals) : "";
  const displayOut = direction === "exact-out" ? typed : amountOut > 0n ? formatStroops(amountOut, outInfo.decimals) : "";

  // ─── Balances ─────────────────────────────────────────────────────────────
  const [balanceNonce, setBalanceNonce] = useState(0);
  const payRead = useTokenBalance(tokenIn, tokenIn === HITZ_ADDRESS ? null : publicKey, balanceNonce);
  const receiveRead = useTokenBalance(tokenOut, tokenOut === HITZ_ADDRESS ? null : publicKey, balanceNonce);
  const payBalance: bigint | null =
    tokenIn === HITZ_ADDRESS ? hitzBalance : payRead?.status === "ok" ? payRead.amount : payRead?.status === "no-trustline" ? 0n : null;
  const missingTrustline =
    !!publicKey && publicKey.startsWith("G") && (receiveRead?.status === "no-trustline" || payRead?.status === "no-trustline");
  const insufficient = payBalance !== null && inStroops > payBalance;

  const setMax = () => {
    if (payBalance === null) return;
    const max = tokenIn === XLM_SAC ? (payBalance > XLM_HEADROOM ? payBalance - XLM_HEADROOM : 0n) : payBalance;
    setDirection("exact-in");
    setTyped(max > 0n ? formatStroops(max, inInfo.decimals).replace(/,/g, "") : "");
  };

  // ─── Gravity ──────────────────────────────────────────────────────────────
  const buying = tokenOut === HITZ_ADDRESS && !isExempt;
  const selling = tokenIn === HITZ_ADDRESS;
  const hitzDelta = tokenOut === HITZ_ADDRESS ? amountOut : selling ? -inStroops : 0n;
  // HITZ leaving the vault lowers S; HITZ entering it raises S. A pool or
  // router trading with the vault moves HITZ between pools: S stays.
  const limitAfter = totalMass > 0n && !isExempt ? limitFor(totalMass - hitzDelta) : safetyLimit;
  const balanceAfter = hitzBalance !== null ? hitzBalance + hitzDelta : null;
  const willVault = buying && amountOut > 0n && balanceAfter !== null && limitAfter > 0n && balanceAfter > limitAfter;
  const releases = selling && vaulted === true && balanceAfter !== null && inStroops > 0n && balanceAfter <= limitAfter;
  const pressurePct =
    buying && limitAfter > 0n && balanceAfter !== null ? Number((balanceAfter * 10_000n) / limitAfter) / 100 : 0;

  // Mirror the what-if into the Pulse bar while buying.
  useEffect(() => {
    setExpectedOut(buying ? amountOut : 0n);
    return () => setExpectedOut(0n);
  }, [buying, amountOut, setExpectedOut]);

  const heroState: "safe" | "warn" | "horizon" = willVault ? "horizon" : pressurePct > 75 ? "warn" : "safe";
  const heroLabel = willVault ? "Crossing Horizon" : heroState === "warn" ? "Near Event Horizon" : "Safe Orbit";

  // ─── Execute ──────────────────────────────────────────────────────────────
  const handleSwap = useCallback(async () => {
    if (!publicKey || confirmedOut === null || inStroops <= 0n) return;
    setTx({ status: "signing" });
    try {
      const call = swapCall({ account: publicKey, tokenIn, tokenOut, amountIn: inStroops, expectedOut: confirmedOut, slippageBps });
      const res = await callContract(call.contractId, call.method, call.args);
      if (res.success && res.hash) {
        setTx({ status: "success", hash: res.hash });
        setTyped("");
        setDirection("exact-in");
        void refreshPools();
        void refreshProtocol();
        setBalanceNonce((n) => n + 1);
      } else {
        setTx({ status: "error", error: explainVaultError(res.error || "Transaction failed") });
      }
    } catch (err) {
      setTx({ status: "error", error: explainVaultError(err instanceof Error ? err.message : String(err)) });
    }
  }, [publicKey, confirmedOut, inStroops, tokenIn, tokenOut, slippageBps, callContract, refreshPools, refreshProtocol]);

  const minOut = confirmedOut !== null ? applySlippage(confirmedOut, slippageBps) : null;
  const busy = tx.status === "signing";
  const ctaDisabled =
    !publicKey || busy || !quote || confirmedOut === null || insufficient || missingTrustline || inStroops <= 0n;
  const ctaLabel = (() => {
    if (!publicKey) return "Connect to swap";
    if (busy) return "Awaiting signature…";
    if (inStroops <= 0n) return "Enter an amount";
    if (insufficient) return `Not enough ${inInfo.symbol}`;
    if (missingTrustline) return "Add the trustline first";
    if (!quote) return "No quote";
    if (confirmedOut === null) return confirmed?.error ? "Quote failed" : "Confirming quote…";
    if (willVault) return "CROSS EVENT HORIZON";
    return `Swap · min ${formatStroops(minOut ?? 0n, outInfo.decimals)} ${outInfo.symbol}`;
  })();

  return (
    <div className={`hero ${heroState} fade-in`}>
      <div className="hero-header">
        <div className="hero-status">
          <span className="hero-status-dot" />
          <span className="hero-status-label">{heroLabel}</span>
        </div>
        <span className="hero-title">Swap · Sovereign Vault</span>
      </div>
      <div className="hero-body">
        <p className="swap-intro">
          HITZ&apos;s own exchange: one pool per trusted asset, all against HITZ. XLM ↔ USDC trades through HITZ in one call. The fee is 1% when the
          vault is calm; a trade that pushes one asset away from the other pays more, up to 10%.
        </p>

        {vaulted === true && (
          <div className="alert info" style={{ marginBottom: 14 }}>
            <span className="icon">⬡</span>
            <div>
              <strong>Your account is vaulted.</strong> You can still sell HITZ into the vault: it&apos;s a registered pool. Selling enough to bring
              your balance under the Event Horizon releases you; the Vault tab computes the amount.
            </div>
          </div>
        )}

        <TokenField
          label={direction === "exact-in" ? "You pay" : "You pay (est.)"}
          token={tokenIn}
          tokens={tokens}
          info={info}
          onPick={(t) => pick("in", t)}
          value={displayIn}
          onValue={(v) => {
            setTyped(v);
            setDirection("exact-in");
          }}
          balance={payBalance}
          onMax={publicKey && payBalance !== null && payBalance > 0n ? setMax : undefined}
          danger={insufficient}
        />

        <div className="swap-arrow">
          <button type="button" onClick={flip} aria-label="Swap direction" className="swap-arrow-inner" style={{ padding: 0, font: "inherit" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 3v13m0 0l-4-4m4 4l4-4M17 21V8m0 0l-4 4m4-4l4 4" />
            </svg>
          </button>
        </div>

        <TokenField
          label={direction === "exact-out" ? "You receive" : "You receive (est.)"}
          token={tokenOut}
          tokens={tokens}
          info={info}
          onPick={(t) => pick("out", t)}
          value={displayOut}
          onValue={(v) => {
            setTyped(v);
            setDirection("exact-out");
          }}
          danger={willVault}
        />

        {derived.error && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            <span className="icon">!</span>
            <div>{derived.error}</div>
          </div>
        )}
        {!states && poolsError && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>Couldn&apos;t read the vault: {poolsError}</div>
          </div>
        )}
        {confirmed?.error && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{confirmed.error}</div>
          </div>
        )}

        {quote && states && (
          <RoutePanel quote={quote} states={states} info={info} tokenIn={tokenIn} tokenOut={tokenOut} confirmedOut={confirmedOut} />
        )}

        <div style={{ marginTop: 14 }} className="slippage">
          <div className="slippage-head">
            <span className="lbl">Slippage tolerance</span>
            <span className="val">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          <input type="range" min={10} max={300} step={10} value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))} />
          <div className="slippage-ticks">
            <span>0.10%</span>
            <span>1.50%</span>
            <span>3.00%</span>
          </div>
        </div>

        {buying && (
          <div className="pressure-detail">
            <div className="pressure-row">
              <span className="lbl">Live Pressure</span>
              <span className="val" style={{ color: willVault ? "var(--red)" : "var(--foreground)" }}>
                {pressurePct.toFixed(1)}% of L
              </span>
            </div>
            <div className="pressure-track">
              <div
                className={`pressure-fill ${willVault ? "danger" : pressurePct > 75 ? "warn" : "safe"}`}
                style={{ width: `${Math.min(100, pressurePct)}%` }}
              />
            </div>
            <div className="pressure-stats">
              <Stat label="Balance" value={fmtFixed(hitzBalance, 4)} />
              <Stat label="After swap" value={amountOut > 0n && balanceAfter !== null ? fmtFixed(balanceAfter, 4) : "–"} red={willVault} />
              <Stat label="Event Horizon" value={limitAfter > 0n ? fmtFixed(limitAfter, 4) : "–"} />
            </div>
          </div>
        )}

        {selling && vaulted === true && inStroops > 0n && (
          <div className={`alert ${releases ? "info" : "warn"}`} style={{ marginTop: 14 }}>
            <span className="icon">{releases ? "✓" : "!"}</span>
            <div>
              {releases
                ? "This sale brings your balance under the Event Horizon: your account is released."
                : "After this sale you'd still hold more than the Event Horizon. The Vault tab computes the amount that releases you."}
            </div>
          </div>
        )}

        {willVault && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div>
              <strong>GRAVITY DISTORTION.</strong> This purchase takes you over the Event Horizon. Your account will be <strong>Vaulted</strong>:
              you can still sell HITZ into the vault, but you can&apos;t send it anywhere else until your balance is back under L.
            </div>
          </div>
        )}

        {missingTrustline && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            <span className="icon">!</span>
            <div>
              Your account has no trustline for {receiveRead?.status === "no-trustline" ? outInfo.symbol : inInfo.symbol}. Add it in your wallet,
              then come back.
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button onClick={handleSwap} disabled={ctaDisabled} className={`btn ${willVault ? "danger" : "primary"}`}>
            {ctaLabel}
          </button>
        </div>

        {tx.status === "success" && (
          <div className="alert info" style={{ marginTop: 14 }}>
            <span className="icon">✓</span>
            <div>
              Swap confirmed ·{" "}
              <a
                href={`https://stellar.expert/explorer/public/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                view tx
              </a>
            </div>
          </div>
        )}
        {tx.status === "error" && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{tx.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Route panel ─────────────────────────────────────────────────────────────

function RoutePanel({
  quote,
  states,
  info,
  tokenIn,
  tokenOut,
  confirmedOut,
}: {
  quote: LocalQuote;
  states: PoolState[];
  info: (t: string) => TokenInfo;
  tokenIn: string;
  tokenOut: string;
  confirmedOut: bigint | null;
}) {
  const inSym = info(tokenIn).symbol;
  const outSym = info(tokenOut).symbol;
  const worstFee = quote.hops.reduce((m, h) => (h.feeRate > m ? h.feeRate : m), 0n);
  const capped = worstFee >= FEE_CAP;
  const elevated = worstFee > ELEVATED_FEE;
  // Was the vault already dislocated before this trade? Then waiting helps;
  // otherwise the trade's own size sets the fee.
  const alreadyDislocated = quote.hops.some((h) => states[h.pool].fee > FEE_FLOOR + 100_000n);
  const last = quote.hops[quote.hops.length - 1];
  const rate = Number(quote.amountOut) / Number(quote.amountIn);
  const spotRate = quote.spotOut / Number(quote.amountIn);
  const fmtRate = (r: number) => (r >= 1000 ? r.toLocaleString("en-US", { maximumFractionDigits: 2 }) : r.toPrecision(5));

  return (
    <div className="route-card">
      <div className="route-head">
        <span className="route-title">Route</span>
        <span className={`route-impact ${quote.impact < -0.03 ? "high" : ""}`}>
          impact {(quote.impact * 100).toFixed(2)}%
        </span>
      </div>
      <ul className="route-hops">
        {quote.hops.map((h, i) => {
          const asset = info(h.asset);
          const from = h.hitzIn ? "HITZ" : asset.symbol;
          const to = h.hitzIn ? asset.symbol : "HITZ";
          // The fee is withheld from the hop's output and stays in the pool.
          const feeToken = h.hitzIn ? asset : info(HITZ_ADDRESS);
          return (
            <li key={i}>
              <span className="route-dot" style={{ background: asset.color }} />
              <span className="route-pair">
                {from} → {to}
              </span>
              <span className="route-pool">{asset.symbol} pool</span>
              <span className={`route-fee ${h.feeRate >= FEE_CAP ? "cap" : h.feeRate > ELEVATED_FEE ? "high" : ""}`}>fee {pct(h.feeRate)}</span>
              <span className="route-amt mono">
                {formatStroops(h.feeAmount, feeToken.decimals)} {feeToken.symbol}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="route-rows">
        <div>
          <span>You get</span>
          <span className="mono">
            1 {inSym} = {fmtRate(rate)} {outSym}
          </span>
        </div>
        <div>
          <span>Vault price, no fee</span>
          <span className="mono">
            1 {inSym} = {fmtRate(spotRate)} {outSym}
          </span>
        </div>
        <div>
          <span>Leaves behind</span>
          <span className="mono">D {(Number(last.dislocation) / 1e16).toFixed(2)}%</span>
        </div>
        {confirmedOut === null && (
          <div>
            <span>On-chain quote</span>
            <span className="mono">confirming…</span>
          </div>
        )}
      </div>
      {(elevated || capped) && (
        <div className="alert warn" style={{ fontSize: 11, marginTop: 10 }}>
          <span className="icon">!</span>
          <div>
            {capped ? <strong>Fee capped at 10%.</strong> : <strong>Elevated fee.</strong>}{" "}
            {alreadyDislocated
              ? "The vault is already dislocated from recent trades. Its fees fall back toward 1% over a few hours as the 2-hour average catches up."
              : `This trade moves ${quote.hops.length === 2 ? `${inSym} against ${outSym}` : `the ${info(last.asset).symbol} pool against the others`}, and each hop pays for the dislocation it leaves behind. A smaller trade pays less.`}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Fields ──────────────────────────────────────────────────────────────────

function TokenField({
  label,
  token,
  tokens,
  info,
  onPick,
  value,
  onValue,
  balance,
  onMax,
  danger = false,
}: {
  label: string;
  token: string;
  tokens: string[];
  info: (t: string) => TokenInfo;
  onPick: (t: string) => void;
  value: string;
  onValue: (v: string) => void;
  balance?: bigint | null;
  onMax?: () => void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ti = info(token);
  return (
    <div className={`token-field ${danger ? "danger" : ""}`}>
      <div className="token-field-label" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{label}</span>
        {balance !== undefined && balance !== null && (
          <span style={{ textTransform: "none", letterSpacing: 0 }}>
            Balance <span className="mono">{fmtFixed(balance, 4, ti.decimals)}</span>
            {onMax && (
              <button type="button" className="max-btn" onClick={onMax}>
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className="token-field-row">
        <input
          className="token-input"
          value={value}
          onChange={(e) => onValue(e.target.value.replace(/,/g, ""))}
          placeholder="0.00"
          inputMode="decimal"
        />
        <div style={{ position: "relative" }}>
          <button type="button" className="token-pill select" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
            <span className="dot" style={{ background: ti.color }} />
            <span>{ti.symbol}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, marginLeft: 2 }}>
              <path d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {open && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
              <div className="token-menu" role="listbox">
                {tokens.map((t) => {
                  const x = info(t);
                  return (
                    <button
                      key={t}
                      role="option"
                      aria-selected={t === token}
                      className={t === token ? "on" : ""}
                      onClick={() => {
                        onPick(t);
                        setOpen(false);
                      }}
                    >
                      <span className="dot" style={{ background: x.color }} />
                      <span>{x.symbol}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, red = false }: { label: string; value: string; red?: boolean }) {
  return (
    <div className="pressure-stat">
      <span className="k">{label}</span>
      <span className={`v ${red ? "red" : ""}`}>{value}</span>
    </div>
  );
}
