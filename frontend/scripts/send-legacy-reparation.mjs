#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as StellarSdk from "@stellar/stellar-sdk";

function parseArgs(argv) {
  const args = {
    file: "/Users/alejomendoza/Downloads/reparation_program.csv",
    endpoint: "",
    token: "",
    dryRun: false,
    delayMs: 250,
    contractId: "",
    rpcUrl: "",
    networkPassphrase: StellarSdk.Networks.PUBLIC,
    sponsorSecret: "",
    skipOnchain: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const next = argv[i + 1];
    if ((arg === "--file" || arg === "-f") && next) {
      args.file = next;
      i += 1;
      continue;
    }
    if ((arg === "--endpoint" || arg === "-e") && next) {
      args.endpoint = next;
      i += 1;
      continue;
    }
    if ((arg === "--token" || arg === "-t") && next) {
      args.token = next;
      i += 1;
      continue;
    }
    if (arg === "--delay-ms" && next) {
      args.delayMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--contract-id" && next) {
      args.contractId = next;
      i += 1;
      continue;
    }
    if (arg === "--rpc-url" && next) {
      args.rpcUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--network-passphrase" && next) {
      args.networkPassphrase = next;
      i += 1;
      continue;
    }
    if (arg === "--sponsor-secret" && next) {
      args.sponsorSecret = next;
      i += 1;
      continue;
    }
    if (arg === "--skip-onchain") {
      args.skipOnchain = true;
      continue;
    }
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/send-legacy-reparation.mjs --endpoint https://skyhitz.io/api/admin/legacy-reparation --token <token> --contract-id <id> --rpc-url <rpc> --sponsor-secret <S...> [--file /Users/.../reparation_program_v6_xlm_49.csv] [--network-passphrase 'Public Global Stellar Network ; September 2015'] [--delay-ms 250] [--dry-run]",
      "",
      "Input file format (v6+):",
      "  - Optional leading title line(s) (no commas) — auto-skipped.",
      "  - Header row: publicKey,email,new_hitz_amount,reparation_xlm_amount",
      "    (reparation_xlm_amount is optional; pre-v6 files without it still work)",
      "Behavior:",
      "  - email present    => POST { email, amount, xlmAmount? } to admin",
      "                        endpoint; endpoint records pending reparation in",
      "                        KV (HITZ + optional XLM) and sends magic-link.",
      "                        Both legs move only on first successful click",
      "                        of /api/auth/verify.",
      "  - email missing    => transfer new_hitz_amount directly to publicKey",
      "                        via SAC, then (if reparation_xlm_amount > 0)",
      "                        send a classic native Payment from sponsor.",
      "                        Requires the publicKey to already exist on chain.",
      "",
      "Pre-flight (one-time, before running this script for a campaign):",
      "  1. Register sponsor as a router on the HITZ contract:",
      "       register_router_address(sponsor_address)",
      "  2. Fund sponsor with the total HITZ reparation pool:",
      "       transfer(admin, sponsor, sum(new_hitz_amount))",
      "  3. Top up sponsor XLM. Required total =",
      "       sum(reparation_xlm_amount)               // user payouts",
      "       + ~1 XLM × email-row count               // bootstrap reserves",
      "       + buffer (fees + base reserve + slack)   // ~50 XLM is plenty",
    ].join("\n")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCampaignRows(content) {
  // Some CSVs ship with a title/version line at the top (e.g.
  // "reparation_program_v6_xlm_49"). It has no commas, so we skip any
  // leading lines that don't look like CSV before locating the header.
  const rawLines = content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  // Find the first line that contains a comma — that's the header.
  const headerIdx = rawLines.findIndex((line) => line.includes(","));
  if (headerIdx === -1 || rawLines.length <= headerIdx + 1) return [];
  const headers = rawLines[headerIdx].split(",").map((v) => v.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  const publicKeyIdx = headers.indexOf("publickey");
  const amountIdx = headers.indexOf("new_hitz_amount");
  // Optional — pre-v6 CSVs don't have this column. -1 means "no XLM leg".
  const xlmIdx = headers.indexOf("reparation_xlm_amount");
  if (emailIdx === -1 || publicKeyIdx === -1 || amountIdx === -1) {
    throw new Error("CSV requires publicKey, email, and new_hitz_amount columns");
  }
  const out = [];
  for (const [lineIndex, line] of rawLines.slice(headerIdx + 1).entries()) {
    const cols = line.split(",").map((v) => v.trim());
    out.push({
      // +2 to account for: the header line itself, and 1-based numbering.
      // Rough approximation when we skipped a title line — line numbers in
      // logs are still close enough to grep the source CSV.
      lineNumber: headerIdx + lineIndex + 2,
      publicKey: cols[publicKeyIdx] || "",
      email: (cols[emailIdx] || "").toLowerCase(),
      amountHuman: cols[amountIdx] || "0",
      xlmAmountHuman: xlmIdx >= 0 ? cols[xlmIdx] || "" : "",
    });
  }
  return out;
}

function parseHitz(human, decimals = 7) {
  const raw = human.trim();
  if (!raw) return 0n;
  const sign = raw.startsWith("-") ? -1n : 1n;
  const normalized = raw.replace(/^[+-]/, "");
  const parts = normalized.split(".");
  const whole = BigInt(parts[0] || "0");
  const fracPart = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  const frac = BigInt(fracPart || "0");
  const units = whole * BigInt(10 ** decimals) + frac;
  return sign * units;
}

async function sendEmail(endpoint, token, email, amountHuman, xlmAmountHuman, dryRun) {
  if (dryRun) return { ok: true, dryRun: true };
  const payload = { email, amount: amountHuman };
  if (xlmAmountHuman) payload.xlmAmount = xlmAmountHuman;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body && typeof body.error === "string" && body.error) ||
        (body && typeof body.message === "string" && body.message) ||
        `HTTP ${res.status}`,
    };
  }
  return { ok: true };
}

async function accountExists(server, publicKey) {
  try {
    await server.getAccount(publicKey);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not\s*found|404/i.test(message)) return false;
    throw err;
  }
}

async function pollForSuccess(server, hash) {
  for (let i = 0; i < 40; i += 1) {
    const tx = await server.getTransaction(hash);
    if (tx.status === "SUCCESS") return;
    if (tx.status === "FAILED") {
      const xdr = tx.resultXdr?.toXDR("base64");
      throw new Error(`tx ${hash} failed${xdr ? `: ${xdr}` : ""}`);
    }
    await sleep(1000);
  }
  throw new Error(`tx ${hash} timed out waiting for finalization`);
}

async function transferHitz({
  dryRun,
  server,
  sponsor,
  networkPassphrase,
  contractId,
  destination,
  amountUnits,
}) {
  if (dryRun) return { ok: true, dryRun: true };
  const source = await server.getAccount(sponsor.publicKey());
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "10000000",
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "transfer",
        StellarSdk.Address.fromString(sponsor.publicKey()).toScVal(),
        StellarSdk.Address.fromString(destination).toScVal(),
        StellarSdk.nativeToScVal(amountUnits, { type: "i128" })
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    return { ok: false, error: `simulation failed: ${sim.error}` };
  }
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sponsor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    const xdr = sent.errorResult?.toXDR("base64");
    return { ok: false, error: `submit failed${xdr ? `: ${xdr}` : ""}` };
  }
  await pollForSuccess(server, sent.hash);
  return { ok: true, hash: sent.hash };
}

// Classic native Payment from the sponsor. Used on the on-chain branch
// (no email) when reparation_xlm_amount > 0. Submitted as a separate tx
// from the SAC HITZ transfer because Soroban + classic ops can't share
// a transaction.
async function sendXlm({
  dryRun,
  server,
  sponsor,
  networkPassphrase,
  destination,
  amountHuman,
}) {
  if (dryRun) return { ok: true, dryRun: true };
  const source = await server.getAccount(sponsor.publicKey());
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "1000",
    networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: amountHuman,
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(sponsor);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    const xdr = sent.errorResult?.toXDR("base64");
    return { ok: false, error: `submit failed${xdr ? `: ${xdr}` : ""}` };
  }
  await pollForSuccess(server, sent.hash);
  return { ok: true, hash: sent.hash };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file || !args.endpoint || (!args.token && !args.dryRun)) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!args.skipOnchain && (!args.contractId || !args.rpcUrl || (!args.sponsorSecret && !args.dryRun))) {
    usage();
    process.exitCode = 1;
    return;
  }

  const filePath = path.resolve(process.cwd(), args.file);
  const input = await fs.readFile(filePath, "utf8");
  const rows = parseCampaignRows(input);
  if (rows.length === 0) {
    console.error("No rows found in input file.");
    process.exitCode = 1;
    return;
  }

  const server = args.skipOnchain ? null : new StellarSdk.rpc.Server(args.rpcUrl);
  const sponsor = args.dryRun || args.skipOnchain
    ? null
    : StellarSdk.Keypair.fromSecret(args.sponsorSecret);

  console.log(`Processing ${rows.length} rows (${args.dryRun ? "dry-run" : "live"})`);

  let emailSent = 0;
  let chainSent = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, row] of rows.entries()) {
    const prefix = `[${index + 1}/${rows.length}] line=${row.lineNumber}`;
    try {
      if (row.email) {
        // Skip rows with non-positive amounts — the server rejects them
        // anyway and we don't want to send "claim 0 HITZ" emails.
        const amountUnits = parseHitz(row.amountHuman);
        if (amountUnits <= 0n) {
          skipped += 1;
          console.log(`${prefix} email=${row.email} -> SKIP (amount <= 0)`);
        } else {
          // Only forward xlmAmount if it parses to > 0; the server rejects
          // zero/negative anyway and we don't want to thread an empty
          // string through a strict regex.
          const xlmUnits = row.xlmAmountHuman
            ? parseHitz(row.xlmAmountHuman)
            : 0n;
          const xlmAmountToSend = xlmUnits > 0n ? row.xlmAmountHuman : "";
          const result = await sendEmail(
            args.endpoint,
            args.token,
            row.email,
            row.amountHuman,
            xlmAmountToSend,
            args.dryRun
          );
          if (result.ok) {
            emailSent += 1;
            const xlmTag = xlmAmountToSend ? ` xlm=${xlmAmountToSend}` : "";
            console.log(
              `${prefix} email=${row.email} amount=${row.amountHuman}${xlmTag} -> EMAIL OK${result.dryRun ? " (dry-run)" : ""}`
            );
          } else {
            failed += 1;
            console.error(`${prefix} email=${row.email} -> EMAIL FAIL: ${result.error}`);
          }
        }
      } else {
        if (args.skipOnchain) {
          skipped += 1;
          console.log(`${prefix} publicKey=${row.publicKey} -> SKIP (on-chain disabled)`);
        } else if (!StellarSdk.StrKey.isValidEd25519PublicKey(row.publicKey)) {
          skipped += 1;
          console.log(`${prefix} publicKey=${row.publicKey} -> SKIP (invalid ed25519 public key)`);
        } else {
          const exists = await accountExists(server, row.publicKey);
          if (!exists) {
            skipped += 1;
            console.log(`${prefix} publicKey=${row.publicKey} -> SKIP (account not found on-chain)`);
          } else {
            const amountUnits = parseHitz(row.amountHuman);
            if (amountUnits <= 0n) {
              skipped += 1;
              console.log(`${prefix} publicKey=${row.publicKey} -> SKIP (amount <= 0)`);
            } else {
              const transfer = await transferHitz({
                dryRun: args.dryRun,
                server,
                sponsor,
                networkPassphrase: args.networkPassphrase,
                contractId: args.contractId,
                destination: row.publicKey,
                amountUnits,
              });
              if (transfer.ok) {
                chainSent += 1;
                console.log(
                  `${prefix} publicKey=${row.publicKey} amount=${row.amountHuman} -> CHAIN OK${transfer.dryRun ? " (dry-run)" : ""}`
                );
                // Optional XLM leg. Sequential after the HITZ transfer so
                // the failure modes are unambiguous (and so a partial
                // failure here doesn't double-pay HITZ on rerun — we've
                // already moved HITZ; only the XLM leg still owes).
                const xlmUnits = row.xlmAmountHuman
                  ? parseHitz(row.xlmAmountHuman)
                  : 0n;
                if (xlmUnits > 0n) {
                  const xlmRes = await sendXlm({
                    dryRun: args.dryRun,
                    server,
                    sponsor,
                    networkPassphrase: args.networkPassphrase,
                    destination: row.publicKey,
                    amountHuman: row.xlmAmountHuman,
                  });
                  if (xlmRes.ok) {
                    console.log(
                      `${prefix} publicKey=${row.publicKey} xlm=${row.xlmAmountHuman} -> XLM OK${xlmRes.dryRun ? " (dry-run)" : ""}`
                    );
                  } else {
                    failed += 1;
                    console.error(
                      `${prefix} publicKey=${row.publicKey} -> XLM FAIL: ${xlmRes.error} (HITZ already sent — rerun will retry XLM only if you remove the row or guard upstream)`
                    );
                  }
                }
              } else {
                failed += 1;
                console.error(`${prefix} publicKey=${row.publicKey} -> CHAIN FAIL: ${transfer.error}`);
              }
            }
          }
        }
      }
    } catch (err) {
      failed += 1;
      console.error(`${prefix} -> FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (index < rows.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  console.log(
    `Done. email_sent=${emailSent} chain_sent=${chainSent} skipped=${skipped} failed=${failed}`
  );
  if (failed > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
