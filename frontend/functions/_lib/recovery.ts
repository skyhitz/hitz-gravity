// Reclaiming reserves the sponsor holds for email accounts that were never
// used.
//
// The gateway's first account flow created every email account with a
// starting balance of 1 XLM, and the sponsor took on its reserves: 1 XLM for
// the account entry and 0.5 XLM for its USDC trustline. A batch of accounts
// created that way was never used: they still hold exactly that 1 XLM and
// have never sent a transaction.
//
// For those, the sponsor can act alone. RevokeSponsorship on the account
// entry hands its reserve to the account, which can afford it with its
// starting balance. That frees 1 XLM of the sponsor's balance per account,
// and the starting balance becomes the account's own locked reserve. An
// account that no longer holds it can't pay a reserve, so its sponsorship
// can't be revoked this way.
//
// One transaction carries the revocations and a payment of exactly what they
// free to the HITZ admin, so the sponsor's spendable balance never rises
// in between.
//
// Erasable TypeScript over plain fetch, so tests/recovery.test.mjs runs it in
// Node against a stand-in for Horizon and the RPC.

import * as StellarSdk from "@stellar/stellar-sdk";
import { fromStroops, toStroops } from "./reserves.ts";

/** The ledgers in which the accounts this job is for were created. Accounts from outside the range are left alone. */
export const RECOVERY_RANGE = { fromLedger: 64_105_992, toLedger: 64_138_234 };

/** Accounts per transaction: 99 revocations and the payment make the 100 operations a transaction can hold. */
export const MAX_PER_TX = 99;

/** The balance each account was created with, and the reserve its account entry needs: 1 XLM. */
const STARTING_BALANCE = 10_000_000n;
/** Inclusion bid per operation, in stroops. */
const FEE_PER_OP = "1000";

export interface RecoveryConfig {
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** The gas sponsor's address. */
  sponsor: string;
  fromLedger: number;
  toLedger: number;
}

/** The part of a Horizon account record the rules read. */
export interface SponsoredAccount {
  account_id: string;
  sequence: string;
  num_sponsoring?: number;
  /** Who pays the account entry's reserve, when it isn't the account. */
  sponsor?: string;
  balances: { asset_type: string; balance: string; selling_liabilities?: string }[];
}

/**
 * Why the sponsorship of this account must not be revoked, or null when it
 * may be: the sponsor pays for the account entry, the account was created in
 * the recovery range, has never sent a transaction, and holds exactly the
 * 1 XLM it was created with and nothing else.
 */
export function whyNotRecoverable(account: SponsoredAccount, cfg: Pick<RecoveryConfig, "sponsor" | "fromLedger" | "toLedger">): string | null {
  if (account.sponsor !== cfg.sponsor) return "account entry is not sponsored by the sponsor";
  if ((account.num_sponsoring ?? 0) > 0) return "account sponsors other entries";
  // An account starts at sequence (creation ledger << 32) and adds one per transaction it sends.
  const sequence = BigInt(account.sequence);
  const created = Number(sequence >> 32n);
  if (created < cfg.fromLedger || created > cfg.toLedger) return "created outside the recovery range";
  if ((sequence & 0xffff_ffffn) !== 0n) return "has sent transactions";
  const native = account.balances.find((b) => b.asset_type === "native");
  if (!native || toStroops(native.balance) !== STARTING_BALANCE || toStroops(native.selling_liabilities ?? "0") !== 0n) {
    return "does not hold exactly its 1 XLM starting balance";
  }
  if (account.balances.some((b) => b.asset_type !== "native" && toStroops(b.balance) !== 0n)) return "holds other assets";
  return null;
}

/** Which of these addresses appear in our holder index (D1 `holders`): they have held HITZ at some point. */
export async function heldHitz(db: D1Database, addresses: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < addresses.length; i += 90) {
    const chunk = addresses.slice(i, i + 90);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(", ");
    const rows = await db.prepare(`SELECT address FROM holders WHERE address IN (${marks})`).bind(...chunk).all<{ address: string }>();
    for (const row of rows.results) found.add(row.address);
  }
  return found;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`horizon ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

interface AccountsPage {
  _links: { next: { href: string } };
  _embedded: { records: SponsoredAccount[] };
}

/** Every account with an entry the sponsor pays the reserve for. */
async function listSponsored(cfg: RecoveryConfig): Promise<SponsoredAccount[]> {
  const out: SponsoredAccount[] = [];
  let url = `${cfg.horizonUrl}/accounts?sponsor=${cfg.sponsor}&limit=200&order=asc`;
  for (let page = 0; page < 100; page++) {
    const body = await getJson<AccountsPage>(url);
    if (!body._embedded.records.length) return out;
    out.push(...body._embedded.records);
    url = body._links.next.href;
  }
  throw new Error("the list of sponsored accounts did not end");
}

export interface RecoveryPlan {
  /** Accounts with an entry the sponsor pays for. */
  sponsored: number;
  /** Accounts whose sponsorship can be revoked, sorted. */
  eligible: string[];
  /** 1 XLM per eligible account. */
  recoverableXlm: string;
  /** Why the others are left alone, with counts. */
  skipped: Record<string, number>;
}

export async function planRecovery(cfg: RecoveryConfig, db: D1Database): Promise<RecoveryPlan> {
  const accounts = await listSponsored(cfg);
  const skipped: Record<string, number> = {};
  const candidates: string[] = [];
  for (const account of accounts) {
    const why = whyNotRecoverable(account, cfg);
    if (why) skipped[why] = (skipped[why] ?? 0) + 1;
    else candidates.push(account.account_id);
  }
  // Someone who claimed or was sent HITZ is a person, whatever else matches.
  const held = await heldHitz(db, candidates);
  if (held.size) skipped["has held HITZ"] = held.size;
  const eligible = candidates.filter((a) => !held.has(a)).sort();
  return { sponsored: accounts.length, eligible, recoverableXlm: fromStroops(BigInt(eligible.length) * STARTING_BALANCE), skipped };
}

/**
 * The recovery transaction, unsigned: one RevokeSponsorship per account,
 * then a payment to `admin` of the 1 XLM each of them frees. It is atomic: if
 * any account can't take over its reserve, nothing happens.
 */
export function buildRecoveryTx(args: {
  /** The sponsor, at its current sequence number. */
  sponsor: StellarSdk.Account;
  accounts: string[];
  admin: string;
  networkPassphrase: string;
}): StellarSdk.Transaction {
  const { accounts } = args;
  if (!accounts.length) throw new Error("no accounts to recover");
  if (accounts.length > MAX_PER_TX) throw new Error(`at most ${MAX_PER_TX} accounts per transaction`);
  if (new Set(accounts).size !== accounts.length) throw new Error("an account is listed twice");
  const builder = new StellarSdk.TransactionBuilder(args.sponsor, { fee: FEE_PER_OP, networkPassphrase: args.networkPassphrase });
  for (const account of accounts) builder.addOperation(StellarSdk.Operation.revokeAccountSponsorship({ account }));
  builder.addOperation(
    StellarSdk.Operation.payment({
      destination: args.admin,
      asset: StellarSdk.Asset.native(),
      amount: fromStroops(BigInt(accounts.length) * STARTING_BALANCE),
    })
  );
  return builder.setTimeout(180).build();
}

export interface RecoveryResult {
  /** SUCCESS: revoked and paid. FAILED / REJECTED: nothing changed. PENDING: outcome unknown, check the hash before another run. */
  status: "SUCCESS" | "FAILED" | "REJECTED" | "PENDING" | "NOTHING_TO_DO";
  hash?: string;
  ledger?: number;
  /** Result code when it did not succeed, and the first operation that failed. */
  code?: string;
  failedAccount?: string;
  /** Accounts whose sponsorship was revoked. */
  revoked: string[];
  /** XLM paid to the admin. */
  paidXlm: string;
  admin?: string;
  /** Eligible accounts left after this run. */
  remaining: number;
}

async function rpc<T>(cfg: RecoveryConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

/** The transaction's result code and, for a failed one, the first operation that did not succeed. */
function failure(resultXdr: string | undefined, accounts: string[]): { code: string; failedAccount?: string } {
  if (!resultXdr) return { code: "unknown" };
  try {
    const result = StellarSdk.xdr.TransactionResult.fromXDR(resultXdr, "base64").result();
    const code: string = result.switch().name;
    if (code !== "txFailed") return { code };
    const ops = result.results();
    for (let i = 0; i < ops.length; i++) {
      const name: string = ops[i].switch().name === "opInner" ? ops[i].tr().value().switch().name : ops[i].switch().name;
      if (!/Success$/.test(name)) return { code: `${code} (operation ${i}: ${name})`, failedAccount: accounts[i] };
    }
    return { code };
  } catch {
    return { code: "unknown" };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Revoke the sponsorship of up to `limit` eligible accounts (99 at most) in
 * one transaction signed by the sponsor, and pay what that frees to `admin`.
 */
export async function runRecovery(
  cfg: RecoveryConfig,
  db: D1Database,
  args: { signer: StellarSdk.Keypair; admin: string; limit: number }
): Promise<RecoveryResult> {
  if (args.signer.publicKey() !== cfg.sponsor) throw new Error("the signing key is not the sponsor's");
  const plan = await planRecovery(cfg, db);
  const batch = plan.eligible.slice(0, Math.max(0, Math.min(Math.floor(args.limit), MAX_PER_TX)));
  const nothing = { revoked: [] as string[], paidXlm: fromStroops(0n), admin: args.admin };
  if (!batch.length) return { status: "NOTHING_TO_DO", ...nothing, remaining: plan.eligible.length };

  const record = await getJson<{ sequence: string }>(`${cfg.horizonUrl}/accounts/${cfg.sponsor}`);
  const tx = buildRecoveryTx({
    sponsor: new StellarSdk.Account(cfg.sponsor, record.sequence),
    accounts: batch,
    admin: args.admin,
    networkPassphrase: cfg.networkPassphrase,
  });
  tx.sign(args.signer);

  const sent = await rpc<{ status: string; hash: string; errorResultXdr?: string }>(cfg, "sendTransaction", { transaction: tx.toXDR() });
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    const why = sent.status === "ERROR" ? failure(sent.errorResultXdr, batch) : { code: sent.status };
    return { status: "REJECTED", hash: sent.hash, ...why, ...nothing, remaining: plan.eligible.length };
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const res = await rpc<{ status: string; ledger?: number; resultXdr?: string }>(cfg, "getTransaction", { hash: sent.hash });
    if (res.status === "NOT_FOUND") continue;
    if (res.status === "SUCCESS") {
      return {
        status: "SUCCESS",
        hash: sent.hash,
        ledger: res.ledger,
        revoked: batch,
        paidXlm: fromStroops(BigInt(batch.length) * STARTING_BALANCE),
        admin: args.admin,
        remaining: plan.eligible.length - batch.length,
      };
    }
    return { status: "FAILED", hash: sent.hash, ledger: res.ledger, ...failure(res.resultXdr, batch), ...nothing, remaining: plan.eligible.length };
  }
  return { status: "PENDING", hash: sent.hash, ...nothing, remaining: plan.eligible.length };
}
