"use client";

/**
 * Orbit — circular balance visualization.
 *
 * Dot radius scales with (balance + expected) / L, capped at 1.4x so an
 * over-horizon account visibly breaks orbit without flying off the card.
 * The ring rotates slowly on safe / warn / horizon states, freezes when
 * vaulted (the account is trapped).
 */

import { fmtFixed } from "../lib/format";

type OrbitState = "safe" | "warn" | "horizon" | "vaulted";

interface Props {
  balance: bigint | null;
  expectedOut?: bigint;
  eventHorizon: bigint;
  state: OrbitState;
}

export default function Orbit({ balance, expectedOut = 0n, eventHorizon, state }: Props) {
  const bal = balance ?? 0n;
  const after = bal + expectedOut;
  const ratio =
    eventHorizon > 0n
      ? Math.min(1.4, Number((after * 1000n) / eventHorizon) / 1000)
      : 0;
  const radius = ratio * 80; // max ~112px, matches the hand-tuned design value
  const angle = -45;
  const rad = (angle * Math.PI) / 180;
  const cx = 90 + radius * Math.cos(rad);
  const cy = 90 + radius * Math.sin(rad);

  const dotCls =
    state === "safe" ? "" : state === "warn" ? "warn" : state === "horizon" ? "danger" : "vaulted";

  return (
    <div
      className="orbit slow-spin"
      style={{ animationPlayState: state === "vaulted" ? "paused" : "running" }}
    >
      <div className="orbit-ring" />
      <div className="orbit-ring inner" style={{ inset: "36%" }} />
      <div className="orbit-horizon" />
      <div style={{ position: "absolute", left: cx, top: cy }}>
        <div className={`orbit-dot ${dotCls}`} />
      </div>
      {/* Counter-rotate the center so digits stay upright while the orbit spins */}
      <div className="orbit-center" style={{ animation: "none" }}>
        <div className="lbl">Balance</div>
        <div className="big">{fmtFixed(balance, 2)}</div>
        <div className="lbl" style={{ marginTop: 2, opacity: 0.6 }}>
          / {fmtFixed(eventHorizon, 0)}
        </div>
      </div>
    </div>
  );
}

/** Derive the visual state from raw protocol numbers. */
export function orbitState(
  balance: bigint | null,
  expectedOut: bigint,
  eventHorizon: bigint,
  vaulted: boolean | null
): OrbitState {
  if (vaulted) return "vaulted";
  if (eventHorizon <= 0n) return "safe";
  const after = (balance ?? 0n) + expectedOut;
  if (after > eventHorizon) return "horizon";
  // Compute 75% threshold without floats: 4 * after > 3 * L  ⇔  after / L > 0.75
  if (after * 4n > eventHorizon * 3n) return "warn";
  return "safe";
}
