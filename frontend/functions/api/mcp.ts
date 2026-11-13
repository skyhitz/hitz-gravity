// MCP server at https://skyhitz.io/mcp, so AI agents can trade HITZ without
// writing Stellar contract code. Streamable HTTP transport, stateless: every
// POST carries JSON-RPC and gets a JSON answer; there are no sessions and no
// server-sent streams (GET answers 405, as the transport allows).
//
// The tools call the same functions as the REST API (_lib/vault-api.ts). None
// of them touches a key: build_swap returns an unsigned transaction that the
// user signs in their own wallet.

import {
  ApiError,
  accountSummary,
  buildSwap,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  quote,
  submitTransaction,
  transactionStatus,
  vaultInfo,
} from "../_lib/vault-api";
import type { Env } from "../_lib/types";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_INFO = {
  name: "hitz-vault",
  title: "HITZ Sovereign Vault",
  version: "1.0.0",
  websiteUrl: "https://skyhitz.io/integrate/",
};

const INSTRUCTIONS = [
  "Trade HITZ, the token of HITZ Protocol on Stellar mainnet, through its own exchange, the Sovereign Vault: protocol-owned pools against XLM and USDC, with no oracle.",
  "Flow: get_vault for prices and fees; quote to price a trade (pass account to check balances, trustlines and the Event Horizon);",
  "build_swap for an unsigned transaction from the user's own account; the user signs it in their Stellar wallet, or opens the",
  "sign.web link, a skyhitz.io page that signs with their wallet and submits; submit_transaction with a signed XDR; get_transaction to follow it.",
  "This server never sees or needs a secret key. Never ask the user for a secret key or seed phrase.",
  "Amounts are decimal strings in token units (7 decimals). The fee is 1% per hop when calm and rises to 10% while the vault's",
  "XLM/USDC rate is dislocated. An account holding more HITZ than the Event Horizon (about 9,900 HITZ; see get_vault) becomes",
  "vaulted: it can only send HITZ back into the vault until it holds less. quote and build_swap warn before a trade does that;",
  "tell the user before building such a trade.",
].join(" ");

const assetArg = {
  type: "string",
  description: "HITZ, XLM, USDC (any case), or a token contract address (C…).",
};
const amountArg = (description: string) => ({ type: "string", pattern: "^\\d+(\\.\\d+)?$", description });
const accountArg = (description: string) => ({ type: "string", pattern: "^G[A-Z2-7]{55}$", description });

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: Tool[] = [
  {
    name: "get_vault",
    title: "Vault state",
    description:
      "Live state of the HITZ Sovereign Vault: each pool's reserves, HITZ price, current fee and dislocation, USD values, " +
      "and the HITZ Event Horizon (the most HITZ an account can hold and still send it anywhere).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Vault state", readOnlyHint: true, openWorldHint: true },
    run: (env) => vaultInfo(env),
  },
  {
    name: "get_account",
    title: "Account",
    description:
      "A Stellar account's XLM, USDC and HITZ balances, its trustlines, whether it is vaulted, and how much HITZ it can buy before being vaulted.",
    inputSchema: {
      type: "object",
      properties: { address: accountArg("Stellar account address (G…).") },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: { title: "Account", readOnlyHint: true, openWorldHint: true },
    run: (env, args) => accountSummary(env, args.address),
  },
  {
    name: "quote",
    title: "Quote a trade",
    description:
      "Exact quote from the contract's own math: the amount out, price, fees per hop and price impact. Give amount (what is sold) " +
      "or buy_amount (what should come out; the quote finds the input). Pass account to check its balances, trustlines and " +
      "whether the trade would push it over the Event Horizon.",
    inputSchema: {
      type: "object",
      properties: {
        sell: assetArg,
        buy: assetArg,
        amount: amountArg("Amount of sell to trade, e.g. \"100\"."),
        buy_amount: amountArg("Instead of amount: how much of buy to receive."),
        account: accountArg("Optional: the account that would trade."),
      },
      required: ["sell", "buy"],
      additionalProperties: false,
    },
    annotations: { title: "Quote a trade", readOnlyHint: true, openWorldHint: true },
    run: (env, args) => quote(env, args),
  },
  {
    name: "build_swap",
    title: "Build a swap transaction",
    description:
      "Build an unsigned, simulated swap transaction for the user's own Stellar account, ready to sign. Returns the XDR, the " +
      "expected and minimum amounts, the network fee, warnings, and sign links: sign.web opens a skyhitz.io page where the " +
      "user signs with their own wallet and the swap is submitted; sign.sep7 is a SEP-7 link for wallets that support it. " +
      "Nothing moves until the user signs. Show the user the amounts and warnings first.",
    inputSchema: {
      type: "object",
      properties: {
        account: accountArg("The user's account: it pays, signs and (unless to is set) receives."),
        sell: assetArg,
        buy: assetArg,
        amount: amountArg("Exact amount of sell to trade."),
        slippage_bps: {
          type: "integer",
          minimum: 0,
          maximum: MAX_SLIPPAGE_BPS,
          default: DEFAULT_SLIPPAGE_BPS,
          description: "How far below the quote the output may land, in basis points (100 = 1%).",
        },
        to: { type: "string", description: "Optional recipient (G… or C…) instead of account." },
        valid_for: { type: "integer", minimum: 30, maximum: 3600, default: 300, description: "Seconds the transaction stays valid." },
      },
      required: ["account", "sell", "buy", "amount"],
      additionalProperties: false,
    },
    annotations: { title: "Build a swap transaction", readOnlyHint: true, openWorldHint: true },
    run: (env, args) => buildSwap(env, args),
  },
  {
    name: "submit_transaction",
    title: "Submit a signed transaction",
    description:
      "Submit a signed vault transaction (from build_swap, signed by the user) to Stellar mainnet and wait for the result: " +
      "status, hash, explorer link and the amount bought. Only relays calls to the vault.",
    inputSchema: {
      type: "object",
      properties: { xdr: { type: "string", description: "The signed transaction envelope, base64." } },
      required: ["xdr"],
      additionalProperties: false,
    },
    annotations: {
      title: "Submit a signed transaction",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: (env, args) => submitTransaction(env, args.xdr),
  },
  {
    name: "get_transaction",
    title: "Transaction status",
    description: "Status of a transaction by hash, with a vault swap decoded (what was sold and bought).",
    inputSchema: {
      type: "object",
      properties: { hash: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "Transaction hash." } },
      required: ["hash"],
      additionalProperties: false,
    },
    annotations: { title: "Transaction status", readOnlyHint: true, openWorldHint: true },
    run: (env, args) => transactionStatus(env, args.hash),
  },
];

const listedTools = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations,
}));

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

type Id = string | number | null;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

async function callTool(env: Env, params: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");
  try {
    const data = (await tool.run(env, args)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (err) {
    const payload =
      err instanceof ApiError
        ? { error: err.message, code: err.code, ...(err.details ?? {}) }
        : { error: err instanceof Error ? err.message : String(err), code: "internal_error" };
    if (!(err instanceof ApiError)) console.error("[mcp]", params.name, err);
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
  }
}

async function handle(env: Env, message: unknown): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = message as { id?: Id; method?: unknown; params?: Record<string, unknown> };
  // Responses from the client, and notifications (initialized, cancelled…), need no answer.
  if (typeof method !== "string" || id === undefined) return null;
  try {
    let result: unknown;
    switch (method) {
      case "initialize": {
        const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        result = {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: listedTools };
        break;
      case "tools/call":
        result = await callTool(env, params ?? {});
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    const text = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id, error: { code, message: text } };
  }
}

export async function POST(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(payload);
  const messages = batch ? (payload as unknown[]) : [payload];
  if (!messages.length) return reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
  const answers = (await Promise.all(messages.map((m) => handle(env, m)))).filter((a): a is Record<string, unknown> => a !== null);
  if (!answers.length) return new Response(null, { status: 202, headers: CORS });
  return reply(batch ? answers : answers[0]);
}

/** No server-initiated stream and no sessions: GET and DELETE are 405, with a pointer for people who open the URL. */
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify(
      {
        name: SERVER_INFO.title,
        mcp: "Streamable HTTP endpoint. Add https://skyhitz.io/mcp to your MCP client as a remote server; no key needed.",
        tools: listedTools.map((t) => t.name),
        docs: SERVER_INFO.websiteUrl,
      },
      null,
      2
    ),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS", ...CORS } }
  );
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
