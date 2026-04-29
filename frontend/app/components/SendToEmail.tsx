"use client";

/**
 * SendToEmail — the "send anything to anyone" card.
 *
 * Despite the name it takes TWO kinds of recipient AND multiple asset
 * types in the same form:
 *
 *   Recipient (sniffed from input):
 *     (a) An email address — we derive the recipient's Stellar address,
 *         bootstrap it on-chain (with sponsored USDC trustline), transfer,
 *         then mail an auto-signin claim link.
 *     (b) A Stellar public key (G…) — direct transfer to the address.
 *
 *   Asset (chosen from a dropdown):
 *     - HITZ                — sent via the HITZ contract's `transfer`.
 *     - Native XLM          — sent via the native asset's SAC `transfer`.
 *     - Any classic trustline the sender holds (USDC, etc.) — via that
 *       asset's deterministic SAC contract id.
 *
 * The dropdown is populated from the sender's actual on-chain balances
 * (Horizon, via /api/gateway/balances). Nothing is hard-coded except
 * HITZ — that's the protocol's own token, always available.
 *
 * Per-asset transfer goes through the same `callContract` plumbing —
 * each SAC's `transfer(from, to, amount)` shape is identical to the HITZ
 * contract's, so we don't branch on asset type at submit time.
 *
 * Caveats:
 *   - For email recipients we only auto-add a USDC trustline. Sending an
 *     exotic trustline asset to a brand-new email derived account will
 *     fail at simulation ("trustline missing"). The error surfaces in the
 *     status row so the sender can switch to a different asset.
 *   - Native XLM uses its SAC, NOT a classic Payment op. The fee-bump
 *     gateway only signs Soroban inner txs, so going through the SAC
 *     keeps the email and wallet paths symmetric.
 */

import { useCallback, useEffect, useState } from "react";
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "../contexts/WalletContext";
import { useProtocol } from "../contexts/ProtocolContext";
import { NETWORK_PASSPHRASE } from "../lib/stellar";
import { HITZ_ADDRESS } from "../lib/aqua";
import {
  type BalanceLine,
  bootstrapAddress,
  getBalances,
  isValidEmail,
  notifyClaim,
  resolveEmail,
} from "../lib/gateway";
import { fmtFixed } from "../lib/format";

// ─── Asset model ─────────────────────────────────────────────────────────

/**
 * A row in the asset dropdown. `contractId` is the SAC the `transfer`
 * call will land on — for HITZ that's the HITZ contract itself, for
 * classic assets it's the deterministic SAC contract id derived from
 * (code, issuer) via `Asset.contractId(networkPassphrase)`.
 *
 * `balanceUnits` is the i128 amount in stroops (10^decimals); we use
 * that directly when building the transfer args. `displayBalance` is
 * the same number rendered for the UI.
 */
interface AssetOption {
  /** Stable key for React + select value. */
  key: string;
  /** Short symbol shown in the dropdown ("HITZ", "XLM", "USDC", etc.). */
  symbol: string;
  /** Asset issuer — undefined for native + HITZ. */
  issuer?: string;
  /** SAC contract id used in the transfer call. */
  contractId: string;
  /** Decimals for amount parsing. Stellar classic + HITZ both use 7. */
  decimals: number;
  /** On-chain balance, stroops. */
  balanceUnits: bigint;
  /** Display balance, decimal string. */
  displayBalance: string;
}

const HITZ_KEY = "hitz";
const NATIVE_KEY = "native";

/** SAC contract id for a given classic Asset on the configured network. */
function classicSacContractId(asset: StellarSdk.Asset): string {
  return asset.contractId(NETWORK_PASSPHRASE);
}

/** Parse a Horizon-style decimal balance string into stroops at `decimals`. */
function balanceToUnits(display: string, decimals: number): bigint {
  const trimmed = (display || "0").trim();
  const sign = trimmed.startsWith("-") ? -1n : 1n;
  const normalized = trimmed.replace(/^[+-]/, "");
  const [whole, frac = ""] = normalized.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  const stroops = BigInt(whole || "0") * BigInt(10 ** decimals) + BigInt(padded || "0");
  return sign * stroops;
}

/** Parse a user-typed decimal amount into stroops at `decimals`. Throws on invalid input. */
function parseAmount(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("invalid amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`max ${decimals} decimals`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(padded || "0");
}

/** Format stroops back into a display string (trailing zeros trimmed). */
function formatUnits(units: bigint, decimals: number): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const divisor = BigInt(10 ** decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  if (frac === 0n) return `${sign}${whole.toLocaleString()}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toLocaleString()}.${fracStr}`;
}

// What the user typed in the "recipient" field resolves to one of these.
type RecipientKind = "email" | "address" | "invalid";

function classifyRecipient(raw: string): RecipientKind {
  const trimmed = raw.trim();
  if (!trimmed) return "invalid";
  if (isValidEmail(trimmed)) return "email";
  if (StellarSdk.StrKey.isValidEd25519PublicKey(trimmed)) return "address";
  return "invalid";
}

type TxState =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "sending"; toAddr: string }
  | { kind: "notifying"; toAddr: string; hash: string }
  | {
      kind: "success";
      hash: string;
      toAddr: string;
      amountHuman: string;
      assetSymbol: string;
      toEmail?: string;
    }
  | { kind: "error"; message: string };

// ─── Component ───────────────────────────────────────────────────────────

export default function SendToEmail() {
  const {
    publicKey,
    connectionType,
    email: senderEmail,
    callContract,
  } = useWallet();
  const { balance: hitzBalance, refresh } = useProtocol();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<TxState>({ kind: "idle" });

  // Live asset list — refreshed on connect + after each successful send so
  // the displayed balance reflects what just left.
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  const [selectedAssetKey, setSelectedAssetKey] = useState<string>(HITZ_KEY);
  const [loadingAssets, setLoadingAssets] = useState(false);

  // ── Asset list construction ────────────────────────────────────────────
  // HITZ is synthetic — it's a Soroban contract token, not a classic
  // trustline, so it doesn't appear in Horizon's `balances`. We always
  // surface it (the connected user is "in HITZ" by definition). Other
  // entries come from Horizon: native XLM and any classic trustlines the
  // sender holds (USDC, plus anything they added themselves).

  const buildOptions = useCallback(
    (lines: BalanceLine[], hitzUnits: bigint | null): AssetOption[] => {
      const out: AssetOption[] = [
        {
          key: HITZ_KEY,
          symbol: "HITZ",
          contractId: HITZ_ADDRESS,
          decimals: 7,
          balanceUnits: hitzUnits ?? 0n,
          displayBalance: formatUnits(hitzUnits ?? 0n, 7),
        },
      ];

      const native = lines.find((b) => b.asset_type === "native");
      if (native) {
        const decimals = 7;
        const units = balanceToUnits(native.balance, decimals);
        out.push({
          key: NATIVE_KEY,
          symbol: "XLM",
          contractId: classicSacContractId(StellarSdk.Asset.native()),
          decimals,
          balanceUnits: units,
          displayBalance: native.balance,
        });
      }

      for (const line of lines) {
        if (
          line.asset_type !== "credit_alphanum4" &&
          line.asset_type !== "credit_alphanum12"
        ) {
          continue;
        }
        if (!line.asset_code || !line.asset_issuer) continue;
        const asset = new StellarSdk.Asset(line.asset_code, line.asset_issuer);
        const decimals = 7; // Stellar classic uses 7 decimals across the board.
        const units = balanceToUnits(line.balance, decimals);
        out.push({
          key: `${line.asset_code}:${line.asset_issuer}`,
          symbol: line.asset_code,
          issuer: line.asset_issuer,
          contractId: classicSacContractId(asset),
          decimals,
          balanceUnits: units,
          displayBalance: line.balance,
        });
      }

      return out;
    },
    []
  );

  const refreshAssets = useCallback(async () => {
    if (!publicKey) {
      setAssetOptions(buildOptions([], hitzBalance));
      return;
    }
    setLoadingAssets(true);
    try {
      const res = await getBalances(publicKey);
      const lines = res.ok && res.data.exists ? res.data.balances : [];
      setAssetOptions(buildOptions(lines, hitzBalance));
    } finally {
      setLoadingAssets(false);
    }
  }, [publicKey, hitzBalance, buildOptions]);

  // Re-run on connect change OR when the protocol context's HITZ balance
  // ticks (the periodic poll already keeps that fresh, so the dropdown's
  // HITZ row stays in sync without a separate timer here).
  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  // Reset selection if the previously-selected asset disappeared (e.g.
  // sender switched accounts to one without that trustline).
  useEffect(() => {
    if (assetOptions.length === 0) return;
    if (!assetOptions.some((a) => a.key === selectedAssetKey)) {
      setSelectedAssetKey(assetOptions[0].key);
    }
  }, [assetOptions, selectedAssetKey]);

  const selected =
    assetOptions.find((a) => a.key === selectedAssetKey) ?? assetOptions[0];

  const recipientKind = classifyRecipient(recipient);

  const amountUnits = (() => {
    if (!selected) return 0n;
    try {
      return amount ? parseAmount(amount, selected.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();

  const insufficient =
    selected !== undefined && amountUnits > selected.balanceUnits;

  const canSend =
    !!publicKey &&
    !!selected &&
    recipientKind !== "invalid" &&
    amountUnits > 0n &&
    !insufficient &&
    (state.kind === "idle" ||
      state.kind === "error" ||
      state.kind === "success");

  // ── Submit ────────────────────────────────────────────────────────────

  const send = useCallback(async () => {
    if (!publicKey || !selected) return;
    const trimmed = recipient.trim();
    const kind = classifyRecipient(trimmed);
    if (kind === "invalid") {
      setState({
        kind: "error",
        message: "Enter a valid email or Stellar G-address",
      });
      return;
    }

    // (1) Resolve + bootstrap recipient. SAC `transfer` rejects unfunded
    //     destinations regardless of asset, and non-native assets also
    //     require a destination trustline — for the email branch the
    //     gateway auto-adds a USDC trustline as part of bootstrap, but
    //     other classic assets won't have one (the simulation will fail
    //     with a clear "trustline missing" if so).
    let toAddr: string;
    let toEmailNormalized: string | null = null;
    setState({ kind: "resolving" });
    if (kind === "email") {
      const normalized = trimmed.toLowerCase();
      toEmailNormalized = normalized;
      const resolved = await resolveEmail(normalized);
      if (!resolved.ok) {
        setState({ kind: "error", message: resolved.error });
        return;
      }
      toAddr = resolved.data.publicKey;
    } else {
      const booted = await bootstrapAddress(trimmed);
      if (!booted.ok) {
        setState({ kind: "error", message: booted.error });
        return;
      }
      toAddr = booted.data.publicKey;
    }

    if (toAddr === publicKey) {
      setState({ kind: "error", message: "Recipient is your own account" });
      return;
    }

    // (2) Transfer via the asset's SAC. Same call shape for HITZ, native,
    //     and any classic — the gas-station path on the email side wraps
    //     this in a sponsor fee bump, the wallet path signs locally.
    setState({ kind: "sending", toAddr });
    const tx = await callContract(selected.contractId, "transfer", [
      StellarSdk.Address.fromString(publicKey).toScVal(),
      StellarSdk.Address.fromString(toAddr).toScVal(),
      StellarSdk.nativeToScVal(amountUnits, { type: "i128" }),
    ]);
    if (!tx.success || !tx.hash) {
      setState({ kind: "error", message: tx.error || "Transfer failed" });
      return;
    }

    // (3) Notify only on the email branch. We mirror the original copy:
    //     the claim link logs the recipient in to the same derived
    //     account that just received the asset.
    const amountHuman = formatUnits(amountUnits, selected.decimals);
    if (toEmailNormalized) {
      setState({ kind: "notifying", toAddr, hash: tx.hash });
      const fromLabel =
        connectionType === "email" && senderEmail ? senderEmail : "A HITZ user";
      await notifyClaim({
        toEmail: toEmailNormalized,
        amountHuman: `${amountHuman} ${selected.symbol}`,
        fromLabel,
        hash: tx.hash,
      });
    }

    setState({
      kind: "success",
      hash: tx.hash,
      toAddr,
      amountHuman,
      assetSymbol: selected.symbol,
      toEmail: toEmailNormalized ?? undefined,
    });
    setAmount("");
    setRecipient("");
    refresh();
    refreshAssets();
  }, [
    publicKey,
    selected,
    recipient,
    amountUnits,
    callContract,
    refresh,
    refreshAssets,
    connectionType,
    senderEmail,
  ]);

  const busy =
    state.kind === "resolving" ||
    state.kind === "sending" ||
    state.kind === "notifying";

  const statusText: string | null =
    state.kind === "resolving"
      ? "Preparing recipient account…"
      : state.kind === "sending"
      ? `Sending ${selected?.symbol ?? "asset"} on-chain…`
      : state.kind === "notifying"
      ? "Notifying recipient by email…"
      : null;

  const recipientHint: { text: string; tone: "muted" | "accent" | "warn" } =
    recipient.trim().length === 0
      ? { text: "Email or Stellar G-address", tone: "muted" }
      : recipientKind === "email"
      ? { text: "Email — we'll mail a claim link", tone: "accent" }
      : recipientKind === "address"
      ? { text: "Stellar address — direct transfer", tone: "accent" }
      : { text: "Not a valid email or Stellar address", tone: "warn" };
  const hintColor =
    recipientHint.tone === "warn"
      ? "var(--red)"
      : recipientHint.tone === "accent"
      ? "var(--accent)"
      : "var(--muted)";

  // Display balance for the selected asset — formatted with up to 7
  // decimals trimmed to 4 to match the pre-existing HITZ display style.
  const selectedBalanceDisplay = selected
    ? fmtFixed(selected.balanceUnits, 4, selected.decimals)
    : null;

  return (
    <div className="side-card" style={{ textAlign: "left" }}>
      <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>Send</h4>
      <p
        style={{
          margin: "0 0 14px",
          fontSize: 12,
          color: "var(--muted)",
          lineHeight: 1.5,
        }}
      >
        Send any asset on your account to anyone. For emails we derive the
        recipient&apos;s Stellar account and mail them a claim link — they
        sign in and the asset is already there.
      </p>

      <div className="field-group" style={{ marginBottom: 10 }}>
        <div className="field-label">Recipient</div>
        <input
          type="text"
          placeholder="friend@example.com or G…"
          className="inp"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
        <div style={{ fontSize: 11, color: hintColor, marginTop: 6 }}>
          {recipientHint.text}
        </div>
      </div>

      <div className="field-group" style={{ marginBottom: 10 }}>
        <div className="field-label">Asset</div>
        <select
          className="inp"
          value={selectedAssetKey}
          onChange={(e) => setSelectedAssetKey(e.target.value)}
          disabled={busy || loadingAssets || assetOptions.length === 0}
        >
          {assetOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.symbol} · {fmtFixed(opt.balanceUnits, 4, opt.decimals)}
            </option>
          ))}
        </select>
        {loadingAssets && (
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
            Loading balances…
          </div>
        )}
      </div>

      <div className="field-group" style={{ marginBottom: 14 }}>
        <div
          className="field-label"
          style={{ display: "flex", justifyContent: "space-between" }}
        >
          <span>Amount{selected ? ` (${selected.symbol})` : ""}</span>
          {selectedBalanceDisplay !== null && (
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>
              Balance: <span className="mono">{selectedBalanceDisplay}</span>
            </span>
          )}
        </div>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          className="inp mono"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          disabled={busy}
        />
        {insufficient && (
          <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>
            Amount exceeds your {selected?.symbol} balance.
          </div>
        )}
      </div>

      <button
        onClick={send}
        disabled={!canSend || busy}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-colors bg-accent hover:bg-accent-hover text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {!publicKey
          ? "Connect to send"
          : busy
          ? statusText || "Working…"
          : `Send${selected ? ` ${selected.symbol}` : ""} →`}
      </button>

      {state.kind === "success" && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 10,
            background: "rgba(48,209,88,.08)",
            border: "1px solid rgba(48,209,88,.25)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: "var(--green)", marginBottom: 4 }}>
            Sent {state.amountHuman} {state.assetSymbol} to{" "}
            {state.toEmail ?? (
              <span className="mono">
                {state.toAddr.slice(0, 6)}…{state.toAddr.slice(-4)}
              </span>
            )}
            .
          </div>
          {state.toEmail && (
            <div style={{ color: "var(--muted)" }}>
              Derived address{" "}
              <span className="mono" style={{ color: "var(--foreground)" }}>
                {state.toAddr.slice(0, 6)}…{state.toAddr.slice(-4)}
              </span>
              . They&apos;ll get a claim email shortly.
            </div>
          )}
          <a
            href={`https://stellar.expert/explorer/public/tx/${state.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--accent)",
              fontSize: 11,
              textDecoration: "none",
            }}
          >
            View tx ↗
          </a>
        </div>
      )}

      {state.kind === "error" && (
        <p style={{ color: "var(--red)", fontSize: 12, marginTop: 10 }}>
          {state.message}
        </p>
      )}
    </div>
  );
}
