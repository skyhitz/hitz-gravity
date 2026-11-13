// Which plan an account has, folded from its purchases (D1 terminal_purchases, append-only) in the
// order they were paid. Nothing is ever updated, so two payments confirmed at once simply add up.
//
// The rules, applied to each purchase at the moment it was paid:
//   - nothing running: the plan starts then, for its periods
//   - the same plan running: its end moves out by the periods bought
//   - a higher plan: it starts then; the value left on the running plan becomes extra time at the new
//     plan's rate
//   - a lower plan while a higher one runs: the payment buys time on the higher plan at its rate
// Value is counted at the rate actually paid (twelve periods cost ten), so an upgrade never loses money.
//
// Pure and erasable TypeScript, run in Node by tests/terminal-billing.test.mjs.

import { PERIOD_MS, PLANS, type PlanId } from "./plans.ts";

export interface Purchase {
  plan: PlanId;
  periods: number;
  usd: number;
  /** ms */
  paid_at: number;
}

export interface PlanState {
  plan: PlanId;
  /** When the running plan started (ms); null on free. */
  since: number | null;
  /** When it ends (ms); null on free. */
  until: number | null;
  /** Dollars per ms of what is left. */
  rate: number;
}

const FREE: PlanState = { plan: "free", since: null, until: null, rate: 0 };

/** The state right after each purchase, folded in payment order, then read at `nowMs`. */
export function planAt(purchases: Purchase[], nowMs: number): PlanState {
  let s: PlanState = FREE;
  const sorted = [...purchases].filter((p) => p.paid_at <= nowMs).sort((a, b) => a.paid_at - b.paid_at);
  for (const p of sorted) {
    const t = p.paid_at;
    const length = p.periods * PERIOD_MS;
    const rate = p.usd / length;
    const running = s.until !== null && s.until > t;
    if (!running) {
      s = { plan: p.plan, since: t, until: t + length, rate };
      continue;
    }
    const left = s.until! - t;
    if (p.plan === s.plan) {
      // Keep the value: the blended rate over what is left plus what was bought.
      s = { plan: s.plan, since: s.since, until: s.until! + length, rate: (left * s.rate + p.usd) / (left + length) };
    } else if (PLANS[p.plan].rank > PLANS[s.plan].rank) {
      const credit = left * s.rate;
      const extra = rate > 0 ? Math.floor(credit / rate) : 0;
      s = { plan: p.plan, since: t, until: t + length + extra, rate: (p.usd + credit) / (length + extra) };
    } else {
      const extra = s.rate > 0 ? Math.floor(p.usd / s.rate) : 0;
      s = { plan: s.plan, since: s.since, until: s.until! + extra, rate: s.rate };
    }
  }
  if (s.until === null || s.until <= nowMs) return FREE;
  return s;
}
