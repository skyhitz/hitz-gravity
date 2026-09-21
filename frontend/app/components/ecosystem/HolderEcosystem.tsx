"use client";

/**
 * HolderEcosystem — 3D overview of every HITZ holder, live from the ledger.
 *
 * Two variants share one stage:
 *   • "card"       — the first section of the Monitor tab, with the
 *                    "Open fullscreen" link.
 *   • "fullscreen" — the /ecosystem route, edge to edge.
 *
 * three.js (and the scene class) is loaded on mount via dynamic import, so
 * the ~600KB renderer never lands in the bundle for the Trade / Vault tabs.
 * All per-frame work lives in `EcosystemScene`; this component only feeds it
 * chain state and renders the HTML overlay (stats, legend, tooltip, detail
 * panel, appearance tweaks).
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { fmtFixed, truncAddr } from "../../lib/format";
import { useWallet } from "../../contexts/WalletContext";
import type { EcosystemScene } from "./scene";
import { DEFAULT_TWEAKS, type EcoStatus, type EcoTweaks } from "./types";
import { useEcosystemData, type EcoHolder, type EcosystemData } from "./useEcosystemData";

const STATUSES: EcoStatus[] = ["safe", "near", "vaulted", "pool"];

const LABEL: Record<EcoStatus, string> = {
  safe: "Safe Orbit",
  near: "Near Horizon",
  vaulted: "Vaulted",
  pool: "Registered Pool",
};

const LEGEND: Record<EcoStatus, string> = { ...LABEL, pool: "Registered Pools" };

const COLOR: Record<EcoStatus, string> = {
  safe: "var(--green)",
  near: "var(--orange)",
  vaulted: "var(--purple)",
  pool: "var(--accent)",
};

const SLIDERS: {
  k: keyof EcoTweaks;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}[] = [
  { k: "size", label: "Body size", min: 0.3, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) + "×" },
  { k: "bloom", label: "Star bloom", min: 0.5, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + "×" },
  { k: "corona", label: "Corona reach", min: 1, max: 18, step: 0.5, fmt: (v) => v.toFixed(1) + "×" },
  { k: "glow", label: "Glow power", min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) + "×" },
  { k: "core", label: "HITZ core", min: 0.4, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) + "×" },
  { k: "spin", label: "Drift speed", min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
];

const PRESETS: Record<string, EcoTweaks> = {
  Starfield: { size: 0.85, bloom: 2.6, corona: 7, glow: 1, core: 1, spin: 0.35 },
  Planets: { size: 1.7, bloom: 1.4, corona: 3.5, glow: 0.5, core: 1.1, spin: 0.35 },
  Nebula: { size: 0.6, bloom: 4, corona: 14, glow: 1.5, core: 1.3, spin: 0.2 },
};

/** Whole HITZ as a float — for the renderer only, never for displayed amounts. */
function toHitz(raw: bigint): number {
  return Number(raw) / 1e7;
}

/** `part / whole` as a percentage with 2dp of bigint precision. */
function pct(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 10_000n) / whole) / 100;
}

function ago(ms: number | null, now: number): string {
  if (ms == null || !now) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 60) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / (86_400 * 30))}mo ago`;
}

function explorerUrl(address: string): string {
  const kind = address.startsWith("G") ? "account" : "contract";
  return `https://stellar.expert/explorer/public/${kind}/${address}`;
}

// ─── Public component ────────────────────────────────────────────────────────

export default function HolderEcosystem({
  variant = "card",
}: {
  variant?: "card" | "fullscreen";
}) {
  const data = useEcosystemData();

  if (variant === "fullscreen") {
    return (
      <div className="eco-full">
        <EcosystemStage data={data} />
      </div>
    );
  }

  const badge = data.sync === "live" ? "Live" : data.sync === "error" ? "Offline" : "Syncing";
  return (
    <div className="eco-card">
      <div className="eco-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: "var(--purple)" }} />
          <h4>Holder Ecosystem</h4>
          <span className={`count ${data.sync === "live" ? "" : "idle"}`}>{badge}</span>
        </div>
        <Link className="eco-expand" href="/ecosystem" target="_blank" rel="noopener noreferrer">
          Open fullscreen ↗
        </Link>
      </div>
      <div className="eco-frame">
        <EcosystemStage data={data} />
      </div>
    </div>
  );
}

// ─── Stage ───────────────────────────────────────────────────────────────────

function EcosystemStage({ data }: { data: EcosystemData }) {
  const { holders, totalMass, safetyLimit, sync, indexError, fetchedAt } = data;
  const { publicKey } = useWallet();

  const mountRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<EcosystemScene | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<EcoStatus>>(() => new Set());
  const [tweaks, setTweaks] = useState<EcoTweaks>(DEFAULT_TWEAKS);
  const [preset, setPreset] = useState<string | null>(null);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Mount the renderer. three.js is pulled in here, on demand.
  useEffect(() => {
    let cancelled = false;
    let instance: EcosystemScene | null = null;
    import("./scene").then(({ EcosystemScene }) => {
      if (cancelled || !mountRef.current) return;
      try {
        instance = new EcosystemScene(mountRef.current, {
          onHover: (id, x, y) => {
            setHoverId(id);
            const tip = tipRef.current;
            if (tip) {
              tip.style.left = `${x + 14}px`;
              tip.style.top = `${y + 14}px`;
            }
          },
          onSelect: setSelectedId,
        });
        setScene(instance);
      } catch {
        setWebglFailed(true);
      }
    });
    return () => {
      cancelled = true;
      instance?.dispose();
    };
  }, []);

  // Chain state → scene.
  useEffect(() => {
    if (!scene || !holders || safetyLimit <= 0n) return;
    const S = toHitz(totalMass);
    scene.sync(
      holders.map((h) => ({
        id: h.id,
        kind: h.kind,
        balance: toHitz(h.balance),
        share: h.kind === "pool" && S > 0 ? toHitz(h.balance) / S : undefined,
        status: h.status,
      })),
      toHitz(safetyLimit)
    );
  }, [scene, holders, totalMass, safetyLimit]);

  useEffect(() => {
    if (!scene) return;
    for (const st of STATUSES) scene.setHidden(st, hidden.has(st));
  }, [scene, hidden]);

  useEffect(() => {
    scene?.setTweaks(tweaks);
  }, [scene, tweaks]);

  const close = () => {
    scene?.select(null);
    setSelectedId(null);
  };

  const counts: Record<EcoStatus, number> = { safe: 0, near: 0, vaulted: 0, pool: 0 };
  for (const h of holders ?? []) counts[h.status]++;

  const hovered = hoverId ? holders?.find((h) => h.id === hoverId) : undefined;
  const selected = selectedId ? holders?.find((h) => h.id === selectedId) : undefined;

  let overlay: string | null = null;
  if (webglFailed) overlay = "3D view unavailable: this browser has WebGL disabled.";
  else if (!holders && sync === "error") overlay = "Couldn't reach Soroban RPC. Retrying…";
  else if (!holders) overlay = "Reading the ledger…";

  return (
    <div className="eco">
      <div className="eco-stage" ref={mountRef} />

      <div className="eco-hd">
        <div>
          <div className="t">Holder Ecosystem</div>
          <div className="s">
            Every HITZ account as a body in orbit. Distance from the core is proximity to the
            Event Horizon — cross it and you are flung outside, vaulted.
          </div>
          {indexError && holders && (
            <div className="s warn">Holder index unreachable — showing registered pools only.</div>
          )}
        </div>
        <div className="eco-stats">
          <div className="eco-stat">
            <div className="k">Bodies</div>
            <div className="v">{holders ? holders.length : "—"}</div>
          </div>
          <div className="eco-stat">
            <div className="k">Total Mass</div>
            <div className="v" style={{ color: "var(--purple)" }}>
              {totalMass > 0n ? fmtFixed(totalMass, 2) : "—"}
            </div>
          </div>
          <div className="eco-stat">
            <div className="k">Horizon L</div>
            <div className="v" style={{ color: "var(--accent)" }}>
              {safetyLimit > 0n ? fmtFixed(safetyLimit, 4) : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className={`eco-tk ${tweaksOpen ? "open" : ""}`}>
        <button
          className="eco-tk-toggle"
          onClick={() => setTweaksOpen((o) => !o)}
          aria-expanded={tweaksOpen}
        >
          <span>Appearance</span>
          <svg
            className="cv"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {tweaksOpen && (
          <div className="eco-tk-panel">
            <div className="eco-tk-hd">Preset</div>
            <div className="eco-tk-presets">
              {Object.entries(PRESETS).map(([name, values]) => (
                <button
                  key={name}
                  className={preset === name ? "on" : ""}
                  onClick={() => {
                    setTweaks(values);
                    setPreset(name);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="eco-tk-hd">Fine tune</div>
            {SLIDERS.map((s) => (
              <div className="eco-tk-row" key={s.k}>
                <div className="eco-tk-l">
                  <span>{s.label}</span>
                  <span className="eco-tk-v mono">{s.fmt(tweaks[s.k])}</span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={tweaks[s.k]}
                  aria-label={s.label}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setTweaks((t) => ({ ...t, [s.k]: v }));
                    setPreset(null);
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="eco-lg">
        {STATUSES.map((st) => (
          <button
            key={st}
            className={hidden.has(st) ? "off" : ""}
            aria-pressed={!hidden.has(st)}
            onClick={() =>
              setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(st)) next.delete(st);
                else next.add(st);
                return next;
              })
            }
          >
            <span className="d" style={{ background: COLOR[st] }} />
            {LEGEND[st]}
            <span className="n">{holders ? counts[st] : "—"}</span>
          </button>
        ))}
      </div>

      <div className="eco-ctl">
        <span className="hint">Drag to orbit · scroll to zoom · click a body</span>
        <button onClick={() => scene?.resetView()}>Reset view</button>
      </div>

      <div className="eco-tip" ref={tipRef} style={{ display: hovered ? "block" : "none" }}>
        {hovered && (
          <>
            <b>{hovered.kind === "pool" ? hovered.label ?? truncAddr(hovered.id, 5, 5) : truncAddr(hovered.id, 5, 5)}</b>
            <span>
              {fmtFixed(hovered.balance, 2)} HITZ · {LABEL[hovered.status]}
            </span>
          </>
        )}
      </div>

      {selected && (
        <DetailPanel
          holder={selected}
          L={safetyLimit}
          S={totalMass}
          now={fetchedAt}
          isYou={selected.id === publicKey}
          onClose={close}
        />
      )}

      {overlay && <div className="eco-loading">{overlay}</div>}
    </div>
  );
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function DetailPanel({
  holder: h,
  L,
  S,
  now,
  isYou,
  onClose,
}: {
  holder: EcoHolder;
  L: bigint;
  S: bigint;
  now: number;
  isYou: boolean;
  onClose: () => void;
}) {
  const isPool = h.kind === "pool";
  const ratio = pct(h.balance, L);
  const headroom = L - h.balance;
  const title = isPool
    ? h.label ?? "Registered Pool"
    : isYou
      ? "Your Account"
      : "Holder Account";

  // The stored flag lags physics until the account's next transfer.
  const flagStale = !isPool && h.vaultFlag && h.status !== "vaulted";
  const flagPending = !isPool && !h.vaultFlag && h.status === "vaulted";

  return (
    <div className="eco-panel">
      <button className="x" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="ph">
        <span className="pd" style={{ background: COLOR[h.status] }} />
        <div>
          <div className="pt">{title}</div>
          <div className="ps">{LABEL[h.status]}</div>
        </div>
      </div>
      <div className="pa mono">{h.id}</div>
      <div className="pg">
        <div>
          <span className="k">Balance</span>
          <span className="v">{fmtFixed(h.balance, 4)}</span>
        </div>
        <div>
          <span className="k">{isPool ? "Share of S" : "% of L"}</span>
          <span
            className="v"
            style={{ color: !isPool && ratio > 100 ? "var(--red)" : undefined }}
          >
            {isPool ? `${pct(h.balance, S).toFixed(2)}%` : `${ratio.toFixed(1)}%`}
          </span>
        </div>
        <div>
          <span className="k">{isPool ? "Contributes mass" : "Headroom"}</span>
          <span className="v" style={{ color: !isPool && headroom < 0n ? "var(--red)" : undefined }}>
            {isPool ? "Yes" : fmtFixed(headroom, 2)}
          </span>
        </div>
        <div>
          <span className="k">{isPool ? "Vault exempt" : "Last active"}</span>
          <span className="v">{isPool ? "Yes" : ago(h.lastActive, now)}</span>
        </div>
      </div>
      {h.status === "vaulted" && (
        <div className="pw">
          Exit welded shut — {fmtFixed(h.balance - L, 2)} HITZ over the Horizon. Requires a
          Sacrifice or ecosystem growth to release.
        </div>
      )}
      {h.status === "near" && (
        <div className="pn">Within {(100 - ratio).toFixed(1)}% of the Event Horizon.</div>
      )}
      {flagStale && (
        <div className="pi">
          The on-chain vault flag is still set, but L has risen past this balance. It clears on
          the account&apos;s next transfer.
        </div>
      )}
      {flagPending && (
        <div className="pi">
          L has fallen below this balance. The contract re-checks on every transfer, so outbound
          moves are already blocked; the stored flag catches up on the next one.
        </div>
      )}
      {h.archived && (
        <div className="pi">
          Dormant — this balance entry&apos;s ledger TTL has lapsed. It is restored the next time
          a transaction touches it.
        </div>
      )}
      <a className="pl" href={explorerUrl(h.id)} target="_blank" rel="noopener noreferrer">
        View on Stellar Expert →
      </a>
    </div>
  );
}
