// The gateway's rate limits, in one place. Counted in D1 by rate-limit.ts.
//
// Sized for people: a handful of sign-ins and sends per hour each. The
// "all" buckets bound what everyone together can make the Worker do (emails
// sent, fees the sponsor pays), whatever the number of addresses or emails
// an abuser brings.
//
// Each function returns groups of limits in the order `hit` checks them: the
// caller's own first, the shared ones last, so a request refused by the
// caller's own limit never counts against a shared one.
//
// Emails appear in bucket names only as their digest (derive.ts), never in
// the clear.

import type { Limit } from "./rate-limit.ts";

const MINUTES = 60;
const HOUR = 3600;
const DAY = 86_400;

/**
 * Transactions the sponsor pays for per day, all accounts together. A
 * transfer to a new holder costs the sponsor about 0.03 XLM, so this bounds
 * a day's fees at roughly 15 XLM whatever anyone does.
 */
export const EXECUTE_PER_DAY = 500;
export const LOGIN_EMAILS_PER_HOUR = 300;
export const NOTIFY_EMAILS_PER_HOUR = 200;
/** New email accounts per day unless GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY says otherwise. */
export const NEW_ACCOUNTS_PER_DAY = 30;

/** Magic-link emails: POST /api/auth/login. Every hit that passes sends one email. */
export function loginLimits(ip: string, emailDigest: string): Limit[][] {
  return [
    [
      { bucket: `login:ip:${ip}`, limit: 5, windowSeconds: 10 * MINUTES },
      { bucket: `login:ip:${ip}`, limit: 30, windowSeconds: DAY },
    ],
    [
      { bucket: `login:email:${emailDigest}`, limit: 3, windowSeconds: 10 * MINUTES },
      { bucket: `login:email:${emailDigest}`, limit: 10, windowSeconds: DAY },
    ],
    [{ bucket: "login:all", limit: LOGIN_EMAILS_PER_HOUR, windowSeconds: HOUR }],
  ];
}

/** Claim emails, POST /api/gateway/notify: what one address may ask for, checked before anything is looked up. */
export function notifyCallerLimits(ip: string): Limit[][] {
  return [[{ bucket: `notify:ip:${ip}`, limit: 10, windowSeconds: HOUR }]];
}

/**
 * Claim emails: what one recipient gets, and everyone together. Charged only
 * once the transfer has been found on chain, so requests that name no real
 * transfer can't use up a recipient's emails.
 */
export function notifyTransferLimits(emailDigest: string): Limit[][] {
  return [
    [{ bucket: `notify:email:${emailDigest}`, limit: 5, windowSeconds: DAY }],
    [{ bucket: "notify:all", limit: NOTIFY_EMAILS_PER_HOUR, windowSeconds: HOUR }],
  ];
}

/** Address lookups: POST /api/gateway/resolve. */
export function resolveLimits(ip: string): Limit[][] {
  return [[{ bucket: `resolve:ip:${ip}`, limit: 60, windowSeconds: 10 * MINUTES }]];
}

/** Attempts by one account: POST /api/gateway/execute, whether or not the call ends up being sent. */
export function executeLimits(account: string): Limit[][] {
  return [
    [
      { bucket: `execute:account:${account}`, limit: 30, windowSeconds: HOUR },
      { bucket: `execute:account:${account}`, limit: 100, windowSeconds: DAY },
    ],
  ];
}

/**
 * Transactions the sponsor pays for, all accounts together. Charged when the
 * sponsor is about to pay for a call that simulated successfully (stellar.ts),
 * so calls that could never be sent don't use it up.
 */
export function sponsoredLimits(): Limit[][] {
  return [[{ bucket: "execute:all", limit: EXECUTE_PER_DAY, windowSeconds: DAY }]];
}

/** New email accounts: per caller address when it is known, and `perDay` for everyone together. */
export function newAccountLimits(ip: string | undefined, perDay: number): Limit[][] {
  return [
    ...(ip ? [[{ bucket: `create:ip:${ip}`, limit: 5, windowSeconds: DAY }]] : []),
    [{ bucket: "create:all", limit: perDay, windowSeconds: DAY }],
  ];
}
