"use client";

/**
 * AccountPulse — orbit + ledger, used on the Monitor tab.
 *
 * The ledger shows S, L, balance, headroom (L − balance, red if negative),
 * and vault status — enough for a returning user to parse their standing at
 * a glance without opening Smart Swap.
 */

import { useProtocol } from "../contexts/ProtocolContext";
import { useWallet } from "../contexts/WalletContext";
import { fmtFixed } from "../lib/format";
import Orbit, { orbitState } from "./Orbit";

export default function AccountPulse() {
  const { totalMass, safetyLimit, balance, vaulted, expectedOut } = useProtocol();
  const { publicKey } = useWallet();
  const state = orbitState(balance, expectedOut, safetyLimit, vaulted);

  const headroom =
    balance === null ? null : safetyLimit - balance;
  const headroomRed = headroom !== null && headroom < 0n;

  return (
    <div className="side-card">
      <h4>Account Pulse</h4>

      {publicKey ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <Orbit
              balance={balance}
              expectedOut={expectedOut}
              eventHorizon={safetyLimit}
              state={state}
            />
          </div>
          <div className="ledger">
            <LedgerRow k="Balance" v={fmtFixed(balance, 4)} />
            <LedgerRow k="Event Horizon (L)" v={fmtFixed(safetyLimit, 4)} />
            <LedgerRow
              k="Headroom"
              v={fmtFixed(headroom, 4)}
              valueColor={headroomRed ? "var(--red)" : undefined}
            />
            <LedgerRow k="Total Mass (S)" v={fmtFixed(totalMass, 2)} />
            <LedgerRow
              k="Vault status"
              v={vaulted ? "VAULTED" : "Free"}
              valueColor={vaulted ? "var(--purple)" : "var(--green)"}
            />
          </div>
        </>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Connect a wallet to see your orbit, headroom, and vault status.
        </p>
      )}
    </div>
  );
}

function LedgerRow({
  k,
  v,
  valueColor,
}: {
  k: string;
  v: string;
  valueColor?: string;
}) {
  return (
    <div className="ledger-row">
      <span className="k">{k}</span>
      <span className="v" style={valueColor ? { color: valueColor } : undefined}>
        {v}
      </span>
    </div>
  );
}
