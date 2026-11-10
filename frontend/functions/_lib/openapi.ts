// OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json for
// agent frameworks and API tools. Keep it in step with api/v1.ts and
// _lib/vault-api.ts.

import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, VAULT_ID } from "./vault-api";
import type { Env } from "./types";

const asset = {
  type: "string",
  description: "HITZ, XLM, USDC (any case), or a contract address (C…).",
  examples: ["XLM", "HITZ", "USDC"],
};
const decimal = (description: string, example: string) => ({
  type: "string",
  pattern: "^\\d+(\\.\\d+)?$",
  description,
  examples: [example],
});
const account = { type: "string", pattern: "^G[A-Z2-7]{55}$", description: "Stellar account address (G…)." };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors = {
  "400": json(ref("Error"), "Invalid input."),
  "422": json(ref("Error"), "The trade can't be done as asked (insufficient balance, slippage, too small…)."),
  "502": json(ref("Error"), "The Stellar network didn't answer; retry."),
};

export function openapi(env: Env) {
  return {
    openapi: "3.1.0",
    info: {
      title: "HITZ Sovereign Vault API",
      version: "1.0.0",
      description:
        "Trade HITZ on Stellar mainnet through its own exchange, the Sovereign Vault " +
        `(${VAULT_ID}): constant-product pools against XLM and USDC, with a fee of 1% per hop when calm, ` +
        "rising to 10% while one asset is dislocated against another.\n\n" +
        "No API key. The API never holds keys: POST /swap returns an unsigned transaction for your own account, " +
        "you sign it with your wallet, and POST /submit relays it.\n\n" +
        "Amounts are decimal strings in token units (7 decimals for HITZ, XLM and USDC), with the raw integer alongside. " +
        "An account holding more HITZ than the Event Horizon (GET /vault: hitz.event_horizon) is vaulted: it can only " +
        "send HITZ to a registered pool, such as back into the vault. Quotes and swaps warn before a trade does that.",
      contact: { url: `${env.APP_URL}/integrate/` },
    },
    externalDocs: { description: "Contract integration guide", url: "https://docs.skyhitz.io/vault/integration" },
    servers: [{ url: `${env.APP_URL}/api/v1` }],
    paths: {
      "/vault": {
        get: {
          operationId: "getVault",
          summary: "Pools, prices, fees and the Event Horizon",
          responses: { "200": json(ref("Vault"), "Live vault state."), "502": errors["502"] },
        },
      },
      "/quote": {
        get: {
          operationId: "getQuote",
          summary: "Exact quote for a trade",
          description:
            "Runs the contract's own swap math on the pools as of the latest ledger. Give amount (exact input) or " +
            "buy_amount (the smallest input that pays at least that much). With account, also checks balances, " +
            "trustlines and the Event Horizon.",
          parameters: [
            { name: "sell", in: "query", required: true, schema: asset },
            { name: "buy", in: "query", required: true, schema: asset },
            { name: "amount", in: "query", schema: decimal("Amount sold.", "100") },
            { name: "buy_amount", in: "query", schema: decimal("Amount wanted out, instead of amount.", "5000") },
            { name: "account", in: "query", schema: account },
          ],
          responses: { "200": json(ref("Quote"), "The quote."), ...errors },
        },
      },
      "/swap": {
        post: {
          operationId: "buildSwap",
          summary: "Build a swap transaction, ready to sign",
          description:
            "Returns a simulated, fee-assembled transaction (base64 XDR) whose source is account. It calls the vault's " +
            "swap with min_out set from the quote and slippage_bps. Sign it with the account's key, then POST /submit " +
            "(or send it to any Stellar RPC) before valid_until. A 409 restore_required carries a restore transaction " +
            "to sign and submit first.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["account", "sell", "buy", "amount"],
                  properties: {
                    account: account,
                    sell: asset,
                    buy: asset,
                    amount: decimal("Exact amount sold.", "100"),
                    slippage_bps: {
                      type: "integer",
                      minimum: 0,
                      maximum: MAX_SLIPPAGE_BPS,
                      default: DEFAULT_SLIPPAGE_BPS,
                      description: "How far below the quote the output may land, in basis points.",
                    },
                    to: { type: "string", description: "Pay out to this address (G… or C…) instead of account." },
                    valid_for: { type: "integer", minimum: 30, maximum: 3600, default: 300, description: "Seconds the transaction stays valid." },
                  },
                },
              },
            },
          },
          responses: {
            "200": json(ref("BuiltSwap"), "Unsigned transaction and what it does."),
            "404": json(ref("Error"), "The account doesn't exist on mainnet."),
            "409": json(ref("Error"), "Archived account data must be restored first (restore_xdr)."),
            ...errors,
          },
        },
      },
      "/submit": {
        post: {
          operationId: "submitTransaction",
          summary: "Submit a signed vault transaction",
          description:
            "Relays a signed, single-operation call to the vault (or its restore transaction) and waits up to 25 seconds for the result.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["xdr"],
                  properties: { xdr: { type: "string", description: "Signed transaction envelope, base64." } },
                },
              },
            },
          },
          responses: {
            "200": json(ref("Submitted"), "Included and successful."),
            "202": json(ref("Submitted"), "Submitted, not final yet: follow it with GET /tx."),
            "422": json(ref("Error"), "Rejected by the network, or included and failed (status FAILED)."),
            "400": errors["400"],
            "502": errors["502"],
            "503": json(ref("Error"), "The network asked to resubmit shortly."),
          },
        },
      },
      "/tx": {
        get: {
          operationId: "getTransaction",
          summary: "Status of a transaction",
          parameters: [{ name: "hash", in: "query", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }],
          responses: { "200": json({ type: "object" }, "SUCCESS, FAILED or NOT_FOUND, with a vault swap decoded."), "400": errors["400"] },
        },
      },
      "/account": {
        get: {
          operationId: "getAccount",
          summary: "Balances, trustlines and the account's room under the Event Horizon",
          parameters: [{ name: "address", in: "query", required: true, schema: account }],
          responses: { "200": json({ type: "object" }, "The account."), "400": errors["400"] },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: {
            error: { type: "string", description: "What went wrong, in words." },
            code: { type: "string", description: "Stable machine code, e.g. insufficient_balance, slippage, no_trustline." },
          },
        },
        Amount: {
          type: "object",
          properties: {
            asset: { type: "string" },
            contract: { type: "string" },
            amount: { type: "string", description: "Exact decimal amount." },
            raw: { type: "string", description: "Integer amount in the token's smallest unit." },
          },
        },
        Vault: {
          type: "object",
          properties: {
            ledger: { type: "integer" },
            vault: { type: "string" },
            hitz: {
              type: "object",
              properties: {
                contract: { type: "string" },
                total_mass: { type: "string" },
                event_horizon: { type: "string", description: "The most HITZ an account can hold and still send it anywhere." },
              },
            },
            pools: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  asset: { type: "string" },
                  contract: { type: "string" },
                  hitz: { type: "string" },
                  reserve: { type: "string" },
                  price: { type: "number", description: "Asset per HITZ." },
                  fee_pct: { type: "number", description: "Fee a very small hop through this pool pays now." },
                  dislocation_pct: { type: "number" },
                },
              },
            },
            usd: { type: ["object", "null"] },
          },
        },
        Quote: {
          type: "object",
          properties: {
            ledger: { type: "integer" },
            sell: ref("Amount"),
            buy: ref("Amount"),
            price: { type: "number", description: "Units of buy per unit of sell, for this size." },
            spot_price: { type: "number", description: "The same for a very small trade, after fees." },
            price_impact_pct: { type: "number" },
            route: { type: "array", items: { type: "string" } },
            hops: { type: "array", items: { type: "object" } },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        BuiltSwap: {
          type: "object",
          properties: {
            xdr: { type: "string", description: "Unsigned transaction envelope, base64." },
            network_passphrase: { type: "string" },
            sell: ref("Amount"),
            buy: { type: "object", properties: { expected: ref("Amount"), minimum: ref("Amount") } },
            network_fee_xlm: { type: "string", description: "The most the transaction can be charged." },
            valid_until: { type: "string", format: "date-time" },
            warnings: { type: "array", items: { type: "string" } },
            sign: {
              type: "object",
              properties: {
                web: {
                  type: "string",
                  description: "skyhitz.io page that signs with the user's wallet and submits. Present when the swap pays the signing account.",
                },
                sep7: { type: "string", description: "SEP-7 URI for wallets that support it." },
              },
            },
          },
        },
        Submitted: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["SUCCESS", "PENDING"] },
            hash: { type: "string" },
            ledger: { type: "integer" },
            explorer: { type: "string" },
            call: { type: "object", description: "The swap, decoded, with the amount bought." },
          },
        },
      },
    },
  };
}
