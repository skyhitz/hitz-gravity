/**
 * Which plan reaches further back than the viewer's, read from the plan table (GET /api/terminal/plans,
 * functions/_lib/terminal/plans.ts), so the panels' plan notes never name a plan the table doesn't.
 *
 * Pure and erasable TypeScript, run in Node by tests/terminal-plan-reach.test.mjs. House style: no em-dashes.
 */

/** What a plan says about history: days back, or null for all of it. A subset of PublicPlan. */
export interface PlanReach {
  id: string;
  name: string;
  intraday_days: number | null;
  daily_days: number | null;
}

const reach = (days: number | null) => (days === null ? Infinity : days);

/**
 * The first plan, cheapest first, that reaches further back than `plan` for intraday or daily series;
 * `all` when it has all of the history. Null when none does, or the plans or the plan aren't known.
 */
export function furtherPlan(plans: readonly PlanReach[] | null, plan: string, kind: "intraday_days" | "daily_days"): { name: string; all: boolean } | null {
  const mine = plans?.find((p) => p.id === plan);
  if (!plans || !mine) return null;
  const next = plans.find((p) => reach(p[kind]) > reach(mine[kind]));
  return next ? { name: next.name, all: next[kind] === null } : null;
}
