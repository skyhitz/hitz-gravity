/**
 * traction.ts — protocol traction for the Monitor tab's traction card.
 *
 * Built hourly by the Worker cron (functions/_lib/traction-model.ts, which
 * also owns these types): active non-infrastructure accounts, how they
 * arrived (email gateway / own wallet / received), monthly history, and
 * the live holder distribution.
 */

import type { Channel, MonthTraction, TractionSnapshot } from "../../functions/_lib/traction-model";
import { fetchSnapshot } from "./api";

export type { Channel, MonthTraction, TractionSnapshot };

/** Resolves null while the snapshot is still being built. */
export function fetchTraction(): Promise<TractionSnapshot | null> {
  return fetchSnapshot<TractionSnapshot>("/api/traction");
}
