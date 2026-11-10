"use client";

/**
 * /sign: review a vault transaction built by the public API or the MCP
 * server (build_swap's `sign.web` link) and sign it with the user's own
 * wallet. Email accounts run the same swap through the gateway instead.
 *
 * The XDR arrives in the URL fragment (#xdr=…), which browsers never send to
 * a server. The page only accepts a single call to the vault's `swap` that
 * pays out to the account signing it, or the restore transaction a swap can
 * need first, so a link from a stranger can't get anything else signed here.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import * as StellarSdk from "@stellar/stellar-sdk";
import WalletButton from "./WalletButton";
import { useWallet } from "../contexts/WalletContext";
import { apiBase } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { NETWORK_PASSPHRASE } from "../lib/stellar";
import { formatStroops } from "../lib/swap";
import { getTokenInfo, type TokenInfo } from "../lib/tokens";
import { HITZ_ADDRESS, VAULT_ID, quoteOnChain, readPools } from "../lib/vault";

type Parsed =
  | {
      kind: "swap";
      source: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: bigint;
      minOut: bigint;
      args: StellarSdk.xdr.ScVal[];
      maxFee: bigint;
      validUntil: number | null;
    }
  | { kind: "restore"; source: string; maxFee: bigint; validUntil: number | null }
  | { kind: "invalid"; reason: string };

const invalid = (reason: string): Parsed => ({ kind: "invalid", reason });

function parse(xdr: string): Parsed {
  let tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
  try {
    tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  } catch {
    return invalid("This isn't a valid Stellar transaction.");
  }
  if (tx instanceof StellarSdk.FeeBumpTransaction) return invalid("Fee-bump transactions aren't signed here.");
  if (tx.operations.length !== 1) return invalid("This page only signs transactions with a single vault operation.");
  const op = tx.operations[0];
  if (op.source && op.source !== tx.source) return invalid("The operation's source differs from the transaction's.");
  const maxFee = BigInt(tx.fee);
  const validUntil = tx.timeBounds && tx.timeBounds.maxTime !== "0" ? Number(tx.timeBounds.maxTime) : null;
  if (op.type === "restoreFootprint") return { kind: "restore", source: tx.source, maxFee, validUntil };
  if (op.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeInvokeContract") {
    return invalid("This page only signs calls to the HITZ Sovereign Vault.");
  }
  const call = op.func.invokeContract();
  if (StellarSdk.Address.fromScAddress(call.contractAddress()).toString() !== VAULT_ID) {
    return invalid("This transaction doesn't call the HITZ Sovereign Vault.");
  }
  if (call.functionName().toString() !== "swap" || call.args().length !== 6) {
    return invalid("Only vault swaps can be signed here.");
  }
  if ((op.auth ?? []).some((a) => a.credentials().switch().name !== "sorobanCredentialsSourceAccount")) {
    return invalid("This transaction carries authorizations for other accounts.");
  }
  const [from, to, tokenIn, tokenOut, amountIn, minOut] = call.args().map((a) => StellarSdk.scValToNative(a));
  if (from !== tx.source || to !== tx.source) {
    return invalid("This swap pays out to a different account than the one that signs it. This page only signs swaps that pay the signer.");
  }
  return {
    kind: "swap",
    source: tx.source,
    tokenIn: String(tokenIn),
    tokenOut: String(tokenOut),
    amountIn: BigInt(amountIn as bigint),
    minOut: BigInt(minOut as bigint),
    args: call.args(),
    maxFee,
    validUntil,
  };
}

/** The transaction from the fragment (or query): base64 survives whether or not the link encoded it. */
function readXdr(): string {
  const m = /(?:^|[#?&])xdr=([^&]*)/.exec(window.location.hash) ?? /(?:^|[#?&])xdr=([^&]*)/.exec(window.location.search);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).replace(/ /g, "+").trim();
  } catch {
    return m[1];
  }
}

function onHashChange(notify: () => void): () => void {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const units = (v: bigint, decimals = 7) => formatStroops(v, decimals);

interface SubmitResult {
  status: string;
  hash?: string;
  explorer?: string;
  call?: { bought?: { amount: string; asset: string } };
}

export default function SignTransaction() {
  const { publicKey, connectionType, sign, callContract } = useWallet();
  // The URL fragment is the source of truth: links set it, and pasting writes it.
  const xdr = useSyncExternalStore(onHashChange, readXdr, () => "");
  const [pasted, setPasted] = useState("");
  const [tokens, setTokens] = useState<{ in: TokenInfo | null; out: TokenInfo | null }>({ in: null, out: null });
  const [current, setCurrent] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [step, setStep] = useState<"review" | "working" | "done">("review");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // HITZ and the vault's listed assets: a swap naming any other token is refused
  // (the vault would reject it too, but its symbol could mislead here first).
  const [listed, setListed] = useState<Set<string> | null>(null);

  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    readPools()
      .then((pools) => setListed(new Set([HITZ_ADDRESS, ...pools.map((p) => p.asset)])))
      .catch(() => setError("Couldn't read the vault's listed assets. Reload to try again."));
    return () => clearInterval(tick);
  }, []);

  const parsed: Parsed | null = xdr ? parse(xdr) : null;
  const swap = parsed?.kind === "swap" ? parsed : null;

  // Token names and a fresh quote for the same input, to compare against the signed minimum.
  const swapKey = swap ? `${swap.tokenIn}:${swap.tokenOut}:${swap.amountIn}` : "";
  useEffect(() => {
    if (!swap) return;
    let cancelled = false;
    Promise.all([getTokenInfo(swap.tokenIn), getTokenInfo(swap.tokenOut)]).then(([a, b]) => {
      if (!cancelled) setTokens({ in: a, out: b });
    });
    const refresh = () =>
      quoteOnChain(swap.tokenIn, swap.tokenOut, swap.amountIn)
        .then((q) => !cancelled && setCurrent(q))
        .catch(() => !cancelled && setCurrent(null));
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // swapKey captures every field the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapKey]);

  const signAndSubmit = useCallback(async () => {
    if (!parsed || parsed.kind === "invalid") return;
    setStep("working");
    setError(null);
    try {
      if (connectionType === "email") {
        if (parsed.kind !== "swap") throw new Error("Email accounts don't need a restore: the gateway does it. Build the swap again.");
        const r = await callContract(VAULT_ID, "swap", parsed.args);
        if (!r.success) throw new Error(r.error ?? "The swap failed.");
        setResult({ status: "SUCCESS", hash: r.hash, explorer: r.hash ? `https://stellar.expert/explorer/public/tx/${r.hash}` : undefined });
      } else {
        const signed = await sign(xdr, NETWORK_PASSPHRASE);
        const res = await fetch(`${apiBase()}/api/v1/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ xdr: signed }),
        });
        const body = (await res.json()) as SubmitResult & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `Submission failed (HTTP ${res.status}).`);
        setResult(body);
      }
      setStep("done");
    } catch (err) {
      setError(errorMessage(err));
      setStep("review");
    }
  }, [parsed, connectionType, callContract, sign, xdr]);

  if (!xdr) {
    return (
      <Card title="Sign a vault transaction">
        <p className="text-sm text-muted">
          Open this page from a link made by the HITZ API or MCP server, or paste the transaction (base64 XDR) here.
        </p>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={5}
          className="w-full mt-3 bg-background border border-border rounded-xl p-3 font-mono text-xs"
          placeholder="AAAAAgAAAAA…"
        />
        <button
          className="btn primary btn-sm mt-3"
          disabled={!pasted.trim()}
          onClick={() => {
            window.location.hash = `xdr=${encodeURIComponent(pasted.trim())}`;
          }}
        >
          Review
        </button>
      </Card>
    );
  }

  if (!parsed || parsed.kind === "invalid") {
    return (
      <Card title="Can't sign this">
        <p className="text-sm text-red">{parsed?.kind === "invalid" ? parsed.reason : "Unreadable transaction."}</p>
        <p className="text-sm text-muted mt-3">
          This page only signs HITZ Sovereign Vault swaps that pay out to your own account. <Link href="/" className="text-accent">Trade on skyhitz.io</Link> instead.
        </p>
      </Card>
    );
  }

  const expired = parsed.validUntil !== null && parsed.validUntil <= now;
  const wrongAccount = publicKey !== null && publicKey !== parsed.source;
  const failsNow = swap !== null && current !== null && current < swap.minOut;
  const looseMinimum = swap !== null && current !== null && swap.minOut * 10n < current * 9n;
  const expensiveFee = parsed.maxFee > 10_000_000n; // above 1 XLM
  const checking = swap !== null && listed === null;
  const unlisted = swap !== null && listed !== null && (!listed.has(swap.tokenIn) || !listed.has(swap.tokenOut));
  const blocked = expired || wrongAccount || failsNow || checking || unlisted || step !== "review";

  if (step === "done" && result) {
    return (
      <Card title={result.status === "SUCCESS" ? "Done" : "Submitted"}>
        {swap && result.call?.bought ? (
          <p className="text-sm">
            Sold {units(swap.amountIn, tokens.in?.decimals)} {tokens.in?.symbol}, bought{" "}
            <span className="font-mono text-green">{result.call.bought.amount}</span> {result.call.bought.asset}.
          </p>
        ) : (
          <p className="text-sm">{result.status === "SUCCESS" ? "The transaction succeeded." : "Waiting for the network to include it."}</p>
        )}
        {result.explorer && (
          <a className="text-accent text-sm mt-3 inline-block" href={result.explorer} target="_blank" rel="noopener noreferrer">
            View on Stellar Expert ↗
          </a>
        )}
        <p className="mt-4">
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            ← Back to skyhitz.io
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card title={swap ? "Review this swap" : "Restore archived data"}>
      {swap ? (
        <div className="space-y-3">
          <Row label="You sell" value={`${units(swap.amountIn, tokens.in?.decimals)} ${tokens.in?.symbol ?? short(swap.tokenIn)}`} />
          <Row
            label="You receive at least"
            value={`${units(swap.minOut, tokens.out?.decimals)} ${tokens.out?.symbol ?? short(swap.tokenOut)}`}
            strong
          />
          <Row
            label="Current quote"
            value={current === null ? "…" : `${units(current, tokens.out?.decimals)} ${tokens.out?.symbol ?? ""}`}
          />
        </div>
      ) : (
        <p className="text-sm text-muted">
          Some of this account&apos;s contract data was archived after a long time without use. Restoring it is needed
          before the swap, and costs a small fee. Afterwards, ask for the swap transaction again.
        </p>
      )}
      <div className="space-y-3 mt-3 pt-3 border-t border-border-soft">
        <Row label="Account" value={short(parsed.source)} mono title={parsed.source} />
        <Row label="Network fee, at most" value={`${units(parsed.maxFee)} XLM`} />
        <Row
          label="Valid until"
          value={parsed.validUntil ? new Date(parsed.validUntil * 1000).toLocaleTimeString() : "no limit"}
        />
        <Row label="Contract" value={`Sovereign Vault ${short(VAULT_ID)}`} mono title={VAULT_ID} />
      </div>

      <div className="space-y-2 mt-4">
        {unlisted && <Warn tone="red">This swap names a token the vault doesn&apos;t trade. Don&apos;t sign it.</Warn>}
        {expired && <Warn tone="red">This transaction has expired. Ask for a new one.</Warn>}
        {failsNow && (
          <Warn tone="red">
            The price has moved: the vault would now pay less than the minimum, so the swap would fail. Ask for a new
            transaction.
          </Warn>
        )}
        {looseMinimum && (
          <Warn tone="orange">The minimum is more than 10% below the current quote: you could receive as little as the minimum.</Warn>
        )}
        {expensiveFee && <Warn tone="orange">The network fee limit is unusually high.</Warn>}
        {wrongAccount && (
          <Warn tone="red">
            This transaction is for {short(parsed.source)}, but you&apos;re connected as {short(publicKey ?? "")}. Connect that
            account to sign it.
          </Warn>
        )}
        {error && <Warn tone="red">{error}</Warn>}
      </div>

      <div className="mt-5 flex items-center gap-3 flex-wrap">
        {publicKey ? (
          <button className="btn primary" disabled={blocked} onClick={signAndSubmit}>
            {step === "working"
              ? "Signing and submitting…"
              : checking
                ? "Checking the vault…"
                : connectionType === "email"
                  ? "Confirm swap"
                  : "Sign with wallet and submit"}
          </button>
        ) : (
          <>
            <WalletButton />
            <span className="text-xs text-muted">Connect {short(parsed.source)} to sign.</span>
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-soft mt-4">
        Your wallet shows the transaction again before signing. skyhitz.io never sees your key.
      </p>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">{title}</h1>
      {children}
    </div>
  );
}

function Row({ label, value, strong, mono, title }: { label: string; value: string; strong?: boolean; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted">{label}</span>
      <span title={title} className={`text-right ${mono ? "font-mono text-xs" : "font-mono"} ${strong ? "text-foreground text-base" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function Warn({ tone, children }: { tone: "red" | "orange"; children: React.ReactNode }) {
  const cls = tone === "red" ? "border-red/40 bg-red/5 text-red" : "border-orange/40 bg-orange/5 text-orange";
  return <div className={`border rounded-xl px-3 py-2 text-sm leading-relaxed ${cls}`}>{children}</div>;
}
