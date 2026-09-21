/**
 * Shared Holder Ecosystem types. Kept free of three.js imports so the React
 * side can use them without pulling the renderer into the main bundle —
 * `scene.ts` is only ever loaded via dynamic import.
 */

export type EcoStatus = "safe" | "near" | "vaulted" | "pool";

export interface EcoNode {
  id: string;
  kind: "account" | "pool";
  /** Balance in whole HITZ (renderer only — never for displayed amounts). */
  balance: number;
  /** Pools only: share of S, 0..1. */
  share?: number;
  status: EcoStatus;
}

export interface EcoTweaks {
  /** Body radius multiplier. */
  size: number;
  /** Tight halo, proportional term. */
  bloom: number;
  /** Wide soft glow, proportional term. */
  corona: number;
  /** Overall glow opacity multiplier. */
  glow: number;
  /** HITZ core scale. */
  core: number;
  /** Turntable speed. */
  spin: number;
}

export const DEFAULT_TWEAKS: EcoTweaks = {
  size: 1,
  bloom: 2.6,
  corona: 7,
  glow: 1,
  core: 1,
  spin: 0.35,
};
