"use client";

/**
 * PulseBar — condensed protocol state, pinned under the nav.
 *
 *   [S · Total Mass] [L · Event Horizon] [Your Orbit — live gauge]
 *
 * Always visible on every tab. Reads from ProtocolContext so it reflects
 * the same numbers the Monitor tab shows, plus any in-flight Smart Swap
 * preview (expectedOut) so the gauge animates while the user types.
 */

import { useProtocol } from "../contexts/ProtocolContext";
import { fmtFixed, pressureRatioPct } from "../lib/format";
import { orbitState } from "./Orbit";
import { addToken } from "@stellar/freighter-api";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "../lib/stellar";
import { useWallet } from "../contexts/WalletContext";

export default function PulseBar() {
  const { totalMass, safetyLimit, balance, vaulted, expectedOut } = useProtocol();
  const state = orbitState(balance, expectedOut, safetyLimit, vaulted);
  const ratio = pressureRatioPct(balance, expectedOut, safetyLimit);
  const visualRatio = Math.min(100, ratio);
  const cls = ratio > 100 ? "danger" : ratio > 75 ? "warn" : "safe";
  const { publicKey } = useWallet();

  // No connected wallet → the orbit is un-knowable; show a placeholder gauge
  // but keep S / L visible so visitors can still read the protocol state.
  const hasOrbit = balance !== null && safetyLimit > 0n;

  const handleAddHitzToWallet = async () => {
  try {    
    // The API prompts the Freighter extension to open a modal
    const result = await addToken({contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE});

    if (result.error) {
       console.warn("Failed to add token:", result.error);
       // Handle user rejection (e.g., they clicked 'Cancel' in Freighter)
    } else {
       console.log("Token successfully added!", result);
       // Show a success toast: "HITZ added to Freighter!"
    }
  } catch (error) {
    console.error("Unexpected error:", error);
  }
};


  return (
    <div className="pulse-wrap">
      <div className="pulse-inner">
        <div className="pulse-cell">
          <div className="pulse-label">
            <span style={{ color: "var(--purple)" }} className="mono">
              S
            </span>
            Total Mass
          </div>
          <div className="pulse-value mono">
            {fmtFixed(totalMass, 2)}
            <span className="pulse-symbol">HITZ</span>
          </div>
        </div>
        <div className="pulse-cell">
          <div className="pulse-label">
            <span style={{ color: "var(--accent)" }} className="mono">
              L
            </span>
            Event Horizon
          </div>
          <div className="pulse-value mono">
            {fmtFixed(safetyLimit, 4)}
            <span className="pulse-symbol">HITZ</span>
          </div>
        </div>
        <div className="pulse-cell">
          <div className="pulse-label">
            <span style={{ color: vaulted ? "var(--red)": "var(--green)"}} className="mono">
              B
            </span>
            Balance
          </div>
          <div className="pulse-value mono">
            {fmtFixed(balance, 2)}
            <span className="pulse-symbol">HITZ</span>
            {publicKey && (
              <span onClick={handleAddHitzToWallet} className="pulse-symbol cursor-pointer" style={{ color: "var(--accent)" }}>(Add Asset)</span>
            )}
          </div>
        </div>
        <div className="pulse-gauge">
          <div className="pulse-label">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                display: "inline-block",
                background:
                  state === "safe"
                    ? "var(--green)"
                    : state === "warn"
                      ? "var(--orange)"
                      : state === "horizon"
                        ? "var(--red)"
                        : "var(--purple)",
              }}
            />
            Your Orbit
            <span
              className="mono"
              style={{ marginLeft: "auto", color: "var(--foreground)", letterSpacing: 0 }}
            >
              {hasOrbit ? `${ratio.toFixed(1)}% of L` : "–"}
            </span>
          </div>
          <div className="pulse-bar">
            <div
              className={`pulse-bar-fill ${cls}`}
              style={{ width: hasOrbit ? `${visualRatio}%` : "0%" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
