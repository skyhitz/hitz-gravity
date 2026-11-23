// An email to the operator for every plan payment, sent by the cron (functions/api/terminal.ts).
//
// A payment is a row in terminal_purchases, written when a checkout is confirmed, by the buyer's page
// (confirmCheckout) or by the cron (reconcileCheckouts). Each run reads the purchases after the last
// one emailed, oldest first, sends one email for each and moves the cursor (terminal_state) after
// each send. A send that fails ends the run and is tried again on the next one, so no payment is
// skipped; a payment confirmed twice is still one row, so none is emailed twice.
//
// Erasable TypeScript, run in Node against a real SQLite by tests/terminal-notify.test.mjs.

import { isPlanId, PLANS } from "./plans.ts";
import { getState, setState } from "./store.ts";

/** terminal_state key: the id of the last purchase emailed. */
const CURSOR = "purchase_mail";
/** At most this many emails a run; the rest go on the next one. */
const PER_RUN = 20;
const PERIOD_DAYS = 30;

export interface OperatorMail {
  subject: string;
  text: string;
}

interface PaymentRow {
  id: number;
  account: string;
  plan: string;
  periods: number;
  usd: number;
  paid_at: number;
  tx_hash: string;
  asset: string | null;
  amount: string | null;
  hitz_bought: string | null;
}

const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function paymentMail(p: PaymentRow): OperatorMail {
  const plan = isPlanId(p.plan) ? PLANS[p.plan].name : p.plan;
  const lines = ["Someone paid for the HITZ Terminal.", "", `Plan: ${plan}, ${p.periods * PERIOD_DAYS} days`, `Price: ${dollars(p.usd)}`];
  if (p.amount && p.asset) lines.push(`Paid: ${p.amount} ${p.asset}`);
  if (p.hitz_bought) lines.push(`HITZ to the treasury: ${p.hitz_bought}`);
  lines.push(`Account: ${p.account}`, `When: ${utc(p.paid_at)}`, `Transaction: https://stellar.expert/explorer/public/tx/${p.tx_hash}`);
  return { subject: `[HITZ] Terminal payment: ${plan}, ${dollars(p.usd)}`, text: lines.join("\n") };
}

/** Email each payment not emailed yet; `mail` sends one message to the operator and throws when it can't. */
export async function notifyPurchases(deps: { db: D1Database; mail: (m: OperatorMail) => Promise<void> }): Promise<{ sent: number; error?: string }> {
  const after = Number((await getState(deps.db, CURSOR)) ?? 0);
  const { results } = await deps.db
    .prepare(
      "SELECT p.id, p.account, p.plan, p.periods, p.usd, p.paid_at, p.tx_hash, c.asset, c.amount, c.hitz_bought " +
        "FROM terminal_purchases p LEFT JOIN terminal_checkouts c ON c.id = p.checkout_id WHERE p.id > ?1 ORDER BY p.id LIMIT ?2"
    )
    .bind(after, PER_RUN)
    .all<PaymentRow>();
  let sent = 0;
  for (const p of results ?? []) {
    try {
      await deps.mail(paymentMail(p));
    } catch (err) {
      return { sent, error: err instanceof Error ? err.message : String(err) };
    }
    await setState(deps.db, CURSOR, String(p.id));
    sent += 1;
  }
  return { sent };
}
