-- The HITZ Terminal: plans given, not bought (the operator's own account for testing, a partner's
-- trial). While a grant runs, the account has the higher of its grant and what its purchases fold to
-- (functions/_lib/terminal/billing.ts, planWith). A grant never lowers a paid plan, never touches
-- terminal_purchases (which stays the ledger of payments) and is never emailed as a payment.
--
-- Nothing public writes here: a grant is a row inserted with `wrangler d1 execute` (frontend/README.md,
-- HITZ Terminal), changed by updating it and ended by deleting it.
CREATE TABLE terminal_grants (
  account    TEXT PRIMARY KEY,                 -- G...
  plan       TEXT NOT NULL CHECK (plan IN ('trader', 'pro', 'institutional')),
  until      INTEGER,                          -- ms; null for no end
  note       TEXT,                             -- who it is for and why
  created_at INTEGER NOT NULL                  -- ms: the grant counts from here
);
