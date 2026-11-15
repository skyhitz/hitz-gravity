// The SDK is loaded on demand (sdk.ts): this module is imported by every app
// page, so it takes the SDK's types only and awaits the code where it runs.
import type * as StellarSdk from "@stellar/stellar-sdk";
import { errorMessage } from "./errors";
import { loadSdk, toHex, type Sdk } from "./sdk";

const CONTRACT_ID =
  "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const RPC_URL = "https://soroban-rpc.mainnet.stellar.gateway.fm";

let rpcServer: StellarSdk.rpc.Server | null = null;

/** The SDK and one RPC client for the page, created on first use. */
async function rpc(): Promise<{ sdk: Sdk; server: StellarSdk.rpc.Server }> {
  const sdk = await loadSdk();
  rpcServer ??= new sdk.rpc.Server(RPC_URL);
  return { sdk, server: rpcServer };
}

// ─── Helpers ───────────────────────────────────────────

/** A contract argument as [type, value], turned into an ScVal once the SDK is there. */
type Arg = [type: "address" | "i128" | "u32" | "bytes32", value: string | number | bigint];

function toScVal(sdk: Sdk, [type, value]: Arg): StellarSdk.xdr.ScVal {
  switch (type) {
    case "address":
      return sdk.Address.fromString(value as string).toScVal();
    case "i128":
      return sdk.nativeToScVal(BigInt(value), { type: "i128" });
    case "u32":
      return sdk.nativeToScVal(Number(value), { type: "u32" });
    case "bytes32": {
      const hex = value as string;
      const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      return sdk.nativeToScVal(bytes, { type: "bytes" });
    }
    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

// ─── Read-only calls (no signing) ─────────────────────

/** Any existing account works as the source of a read-only simulation. */
const SIM_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/**
 * Simulate a read-only call on any contract and return its result. Nothing
 * is signed or sent. Simulation restores archived entries on its own, so a
 * view never fails for archival.
 */
export async function simulate(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<StellarSdk.xdr.ScVal> {
  const { sdk, server } = await rpc();
  const account = new sdk.Account(SIM_SOURCE, "0");
  const contract = new sdk.Contract(contractId);
  const tx = new sdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error: ${sim.error}`);
  }
  if (!sdk.rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation failed");
  }
  const result = sim.result;
  if (!result) throw new Error("No result from simulation");
  return result.retval;
}

/** A view of the HITZ token, as a native value. */
async function view(method: string, args: Arg[] = []): Promise<unknown> {
  const sdk = await loadSdk();
  return sdk.scValToNative(await simulate(CONTRACT_ID, method, args.map((a) => toScVal(sdk, a))));
}

export async function getSafetyLimit(): Promise<bigint> {
  return BigInt((await view("safety_limit")) as string | number | bigint);
}

export async function getTotalMass(): Promise<bigint> {
  return BigInt((await view("total_mass")) as string | number | bigint);
}

export async function getBalance(address: string): Promise<bigint> {
  return BigInt((await view("balance", [["address", address]])) as string | number | bigint);
}

/**
 * The stored vault flag. It's a cache: the token re-syncs it against the
 * live L on the account's next transfer, so prefer `isActuallyVaulted`.
 */
export async function isAccountVaulted(address: string): Promise<boolean> {
  return (await view("is_account_vaulted", [["address", address]])) as boolean;
}

/**
 * Whether the account is stuck right now: it holds more than the live L and
 * isn't a registered pool or router. This is what the token's sender gate
 * enforces, whatever the stored flag says.
 */
export async function isActuallyVaulted(address: string): Promise<boolean> {
  return (await view("is_actually_vaulted", [["address", address]])) as boolean;
}

export async function isPool(address: string): Promise<boolean> {
  return (await view("is_pool", [["address", address]])) as boolean;
}

export async function isRouter(address: string): Promise<boolean> {
  return (await view("is_router", [["address", address]])) as boolean;
}

/**
 * Enumerate every currently-registered pool. Backed by the contract's
 * `list_pools` view (V4 addition), which maintains a `Vec<Address>` in
 * instance storage in lockstep with every register / remove call.
 * Authoritative — no RPC event retention dependency.
 */
export async function listPools(): Promise<string[]> {
  return ((await view("list_pools")) as string[]) ?? [];
}

/** See `listPools`. */
export async function listRouters(): Promise<string[]> {
  return ((await view("list_routers")) as string[]) ?? [];
}

export async function getDecimals(): Promise<number> {
  return Number(await view("decimals"));
}

export async function getName(): Promise<string> {
  return (await view("name")) as string;
}

export async function getSymbol(): Promise<string> {
  return (await view("symbol")) as string;
}

/**
 * The token's admin (`admin()` view), or null once the role is renounced.
 *
 * Cached in-module after the first successful read: the admin changes so
 * rarely that re-polling on every render cycle would be wasteful.
 */
let adminCache: Promise<string | null> | null = null;

export async function getAdmin(): Promise<string | null> {
  if (adminCache) return adminCache;
  adminCache = (async () => {
    try {
      return (((await view("admin")) as string | null | undefined) ?? null);
    } catch {
      adminCache = null; // allow retry next call
      return null;
    }
  })();
  return adminCache;
}

export interface PendingUpgrade {
  /** Hex Wasm hash. */
  wasmHash: string;
  /** Unix seconds from which `upgrade` can run. */
  eta: number;
}

/** A proposed upgrade waiting out its 7-day timelock, if any. Works for the token and the vault. */
export async function getPendingUpgrade(contractId: string = CONTRACT_ID): Promise<PendingUpgrade | null> {
  const sdk = await loadSdk();
  const native = sdk.scValToNative(await simulate(contractId, "pending_upgrade")) as
    | { wasm_hash: Uint8Array; eta: bigint }
    | null
    | undefined;
  if (!native) return null;
  return { wasmHash: toHex(native.wasm_hash), eta: Number(native.eta) };
}

// ─── Write calls (require Freighter signing) ──────────

export interface TxResult {
  success: boolean;
  hash?: string;
  error?: string;
}

/**
 * If simulation comes back with a `restorePreamble`, some ledger entries
 * the call touches have expired out to cold storage (Soroban TTL — ~30
 * days of inactivity). We must submit a RestoreFootprintOp first; Soroban
 * is single-op per envelope so it cannot be bundled.
 *
 * For wallet users the user is the source AND fee payer — they'll see one
 * extra signature prompt ("restore archived state") before their actual
 * transfer/swap. We keep it explicit rather than routing through a
 * sponsor: wallet users opted out of gas sponsorship by connecting a key.
 *
 * Throws on failure; resolves when the restore has been finalized and
 * the original call can be re-simulated against live state.
 */
export async function restoreArchivedState(
  publicKey: string,
  preamble: StellarSdk.rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string; address?: string }
  ) => Promise<string>
): Promise<void> {
  const { sdk, server } = await rpc();
  const account = await server.getAccount(publicKey);
  const draft = new sdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(sdk.Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(draft);
  if (sdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`restore simulation failed: ${sim.error}`);
  }
  const assembled = sdk.rpc.assembleTransaction(draft, sim).build();
  const signedXdr = await signTransaction(assembled.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: publicKey,
  });
  const signedTx = sdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const resp = await server.sendTransaction(signedTx);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`restore submit failed${xdr ? `: ${xdr}` : ""}`);
  }
  // Poll to finalization — the next simulation needs the entries live.
  let getResponse = await server.getTransaction(resp.hash);
  while (getResponse.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getResponse = await server.getTransaction(resp.hash);
  }
  if (getResponse.status !== "SUCCESS") {
    throw new Error(`restore failed: ${getResponse.status}`);
  }
}

/**
 * Stellar's result code for a rejected or failed transaction, e.g. `txBadSeq`
 * or `txFailed (invokeHostFunctionTrapped)`. Null when there is nothing to read.
 */
function txResultCode(result: StellarSdk.xdr.TransactionResult | undefined): string | null {
  if (!result) return null;
  try {
    const inner = result.result();
    const code = inner.switch().name;
    if (code !== "txFailed") return code;
    const op = inner.results()[0];
    const opCode = op?.switch().name === "opInner" ? op.tr().value().switch().name : op?.switch().name;
    return opCode ? `${code} (${opCode})` : code;
  } catch {
    return null;
  }
}

async function buildAndSend(
  publicKey: string,
  method: string,
  callArgs: Arg[],
  signTransaction: (xdr: string, opts: { networkPassphrase: string; address?: string }) => Promise<string>
): Promise<TxResult> {
  try {
    const { sdk, server } = await rpc();
    const args = callArgs.map((a) => toScVal(sdk, a));
    const contract = new sdk.Contract(CONTRACT_ID);

    // Helper: fetch fresh account + build + simulate. Called twice in the
    // rare restore path (once to detect archival, once after restore).
    const buildAndSimulate = async () => {
      const account = await server.getAccount(publicKey);
      const tx = new sdk.TransactionBuilder(account, {
        fee: "10000000",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      return { tx, sim };
    };

    let { tx, sim } = await buildAndSimulate();
    if (sdk.rpc.Api.isSimulationError(sim)) {
      return { success: false, error: sim.error };
    }

    // Archived state? Restore first, then re-simulate. Invisible to the
    // UI aside from one extra wallet prompt.
    if (sdk.rpc.Api.isSimulationRestore(sim)) {
      await restoreArchivedState(publicKey, sim.restorePreamble, signTransaction);
      ({ tx, sim } = await buildAndSimulate());
      if (sdk.rpc.Api.isSimulationError(sim)) {
        return { success: false, error: sim.error };
      }
    }

    const prepared = sdk.rpc.assembleTransaction(tx, sim).build();

    const signedXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: publicKey,
    });

    const signedTx = sdk.TransactionBuilder.fromXDR(
      signedXdr,
      NETWORK_PASSPHRASE
    );

    const response = await server.sendTransaction(signedTx);

    if (response.status === "ERROR") {
      const code = txResultCode(response.errorResult);
      return { success: false, error: `Transaction submission failed${code ? `: ${code}` : ""}` };
    }

    // Poll for result
    let getResponse = await server.getTransaction(response.hash);
    while (getResponse.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await server.getTransaction(response.hash);
    }

    if (getResponse.status === "SUCCESS") {
      return { success: true, hash: response.hash };
    } else {
      const code = getResponse.status === "FAILED" ? txResultCode(getResponse.resultXdr) : null;
      return {
        success: false,
        hash: response.hash,
        error: `Transaction failed: ${code ?? getResponse.status}`,
      };
    }
  } catch (err: unknown) {
    return { success: false, error: errorMessage(err) };
  }
}

export async function mint(
  publicKey: string,
  to: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "mint", [
    ["address", to],
    ["i128", amount],
  ], signTransaction);
}

export async function transfer(
  publicKey: string,
  from: string,
  to: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "transfer", [
    ["address", from],
    ["address", to],
    ["i128", amount],
  ], signTransaction);
}

export async function approve(
  publicKey: string,
  from: string,
  spender: string,
  amount: bigint,
  expirationLedger: number,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "approve", [
    ["address", from],
    ["address", spender],
    ["i128", amount],
    ["u32", expirationLedger],
  ], signTransaction);
}

export async function transferFrom(
  publicKey: string,
  spender: string,
  from: string,
  to: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "transfer_from", [
    ["address", spender],
    ["address", from],
    ["address", to],
    ["i128", amount],
  ], signTransaction);
}

export async function burn(
  publicKey: string,
  from: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "burn", [
    ["address", from],
    ["i128", amount],
  ], signTransaction);
}

export async function registerPoolAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "register_pool_address", [
    ["address", address],
  ], signTransaction);
}

export async function removePoolAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "remove_pool_address", [
    ["address", address],
  ], signTransaction);
}

export async function registerRouterAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "register_router_address", [
    ["address", address],
  ], signTransaction);
}

export async function removeRouterAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "remove_router_address", [
    ["address", address],
  ], signTransaction);
}

// ─── Utilities ─────────────────────────────────────────

export function formatHitz(raw: bigint, decimals = 7): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr}`;
}

export function parseHitz(human: string, decimals = 7): bigint {
  const parts = human.split(".");
  const whole = BigInt(parts[0] || "0");
  let frac = 0n;
  if (parts[1]) {
    const fracStr = parts[1].padEnd(decimals, "0").slice(0, decimals);
    frac = BigInt(fracStr);
  }
  return whole * BigInt(10 ** decimals) + frac;
}

export { CONTRACT_ID, RPC_URL, NETWORK_PASSPHRASE };
