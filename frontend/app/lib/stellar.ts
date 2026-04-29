import * as StellarSdk from "@stellar/stellar-sdk";

const CONTRACT_ID =
  "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const RPC_URL = "https://soroban-rpc.mainnet.stellar.gateway.fm";

const server = new StellarSdk.rpc.Server(RPC_URL);

// ─── Helpers ───────────────────────────────────────────

function toScVal(type: string, value: string | number | bigint): StellarSdk.xdr.ScVal {
  switch (type) {
    case "address":
      return StellarSdk.Address.fromString(value as string).toScVal();
    case "i128":
      return StellarSdk.nativeToScVal(BigInt(value), { type: "i128" });
    case "u32":
      return StellarSdk.nativeToScVal(Number(value), { type: "u32" });
    case "bytes32": {
      const hex = value as string;
      const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
    }
    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

function fromScVal(val: StellarSdk.xdr.ScVal): unknown {
  return StellarSdk.scValToNative(val);
}

// ─── Read-only calls (no signing) ─────────────────────

async function simulateCall(
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<StellarSdk.xdr.ScVal> {
  const account = new StellarSdk.Account(
    "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    "0"
  );
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error: ${sim.error}`);
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation failed");
  }
  const result = sim.result;
  if (!result) throw new Error("No result from simulation");
  return result.retval;
}

export async function getSafetyLimit(): Promise<bigint> {
  const val = await simulateCall("safety_limit");
  return BigInt(fromScVal(val) as string | number | bigint);
}

export async function getTotalMass(): Promise<bigint> {
  const val = await simulateCall("total_mass");
  return BigInt(fromScVal(val) as string | number | bigint);
}

export async function getBalance(address: string): Promise<bigint> {
  const val = await simulateCall("balance", [toScVal("address", address)]);
  return BigInt(fromScVal(val) as string | number | bigint);
}

export async function isAccountVaulted(address: string): Promise<boolean> {
  const val = await simulateCall("is_account_vaulted", [
    toScVal("address", address),
  ]);
  return fromScVal(val) as boolean;
}

export async function isPool(address: string): Promise<boolean> {
  const val = await simulateCall("is_pool", [toScVal("address", address)]);
  return fromScVal(val) as boolean;
}

export async function isRouter(address: string): Promise<boolean> {
  const val = await simulateCall("is_router", [toScVal("address", address)]);
  return fromScVal(val) as boolean;
}

/**
 * Enumerate every currently-registered pool. Backed by the contract's
 * `list_pools` view (V4 addition), which maintains a `Vec<Address>` in
 * instance storage in lockstep with every register / remove call.
 * Authoritative — no RPC event retention dependency.
 */
export async function listPools(): Promise<string[]> {
  const val = await simulateCall("list_pools");
  return (fromScVal(val) as string[]) ?? [];
}

/** See `listPools`. */
export async function listRouters(): Promise<string[]> {
  const val = await simulateCall("list_routers");
  return (fromScVal(val) as string[]) ?? [];
}

export async function getDecimals(): Promise<number> {
  const val = await simulateCall("decimals");
  return Number(fromScVal(val));
}

export async function getName(): Promise<string> {
  const val = await simulateCall("name");
  return fromScVal(val) as string;
}

export async function getSymbol(): Promise<string> {
  const val = await simulateCall("symbol");
  return fromScVal(val) as string;
}

/**
 * Read the contract's current admin address from instance storage.
 *
 * The token contract doesn't expose a public `get_admin()` method, so we
 * go one layer deeper: contract instance data lives in a single ledger
 * entry keyed by `scvLedgerKeyContractInstance`, whose value is an
 * `ScContractInstance` containing an `ScMap` of all instance-storage keys.
 * We walk that map looking for `DataKey::Admin`, which Soroban's Rust
 * contractenum derive encodes as `scvVec([scvSymbol("Admin")])`.
 *
 * Cached in-module after the first successful read — the admin changes so
 * rarely that re-polling on every render-cycle would be wasteful.
 */
let adminCache: Promise<string | null> | null = null;

export async function getAdmin(): Promise<string | null> {
  if (adminCache) return adminCache;
  adminCache = (async () => {
    try {
      const key = StellarSdk.xdr.LedgerKey.contractData(
        new StellarSdk.xdr.LedgerKeyContractData({
          contract: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
          key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: StellarSdk.xdr.ContractDataDurability.persistent(),
        })
      );
      const res = await server.getLedgerEntries(key);
      if (res.entries.length === 0) return null;
      const entry = res.entries[0];
      const contractData = entry.val.contractData().val();
      if (contractData.switch() !== StellarSdk.xdr.ScValType.scvContractInstance()) {
        return null;
      }
      const instance = contractData.instance();
      const storage = instance.storage();
      if (!storage) return null;
      for (const ent of storage) {
        const k = ent.key();
        // DataKey::Admin is `scvVec([scvSymbol("Admin")])`.
        if (k.switch() !== StellarSdk.xdr.ScValType.scvVec()) continue;
        const vec = k.vec();
        if (!vec || vec.length !== 1) continue;
        const first = vec[0];
        if (first.switch() !== StellarSdk.xdr.ScValType.scvSymbol()) continue;
        if (first.sym().toString() !== "Admin") continue;
        const val = ent.val();
        if (val.switch() !== StellarSdk.xdr.ScValType.scvAddress()) continue;
        return StellarSdk.Address.fromScAddress(val.address()).toString();
      }
      return null;
    } catch {
      adminCache = null; // allow retry next call
      return null;
    }
  })();
  return adminCache;
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
    opts: { networkPassphrase: string }
  ) => Promise<string>
): Promise<void> {
  const account = await server.getAccount(publicKey);
  const draft = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(StellarSdk.Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(draft);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`restore simulation failed: ${sim.error}`);
  }
  const assembled = StellarSdk.rpc.assembleTransaction(draft, sim).build();
  const signedXdr = await signTransaction(assembled.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
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

async function buildAndSend(
  publicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  try {
    const contract = new StellarSdk.Contract(CONTRACT_ID);

    // Helper: fetch fresh account + build + simulate. Called twice in the
    // rare restore path (once to detect archival, once after restore).
    const buildAndSimulate = async () => {
      const account = await server.getAccount(publicKey);
      const tx = new StellarSdk.TransactionBuilder(account, {
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
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      return { success: false, error: sim.error };
    }

    // Archived state? Restore first, then re-simulate. Invisible to the
    // UI aside from one extra wallet prompt.
    if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
      await restoreArchivedState(publicKey, sim.restorePreamble, signTransaction);
      ({ tx, sim } = await buildAndSimulate());
      if (StellarSdk.rpc.Api.isSimulationError(sim)) {
        return { success: false, error: sim.error };
      }
    }

    const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();

    const signedXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    const signedTx = StellarSdk.TransactionBuilder.fromXDR(
      signedXdr,
      NETWORK_PASSPHRASE
    );

    const response = await server.sendTransaction(signedTx);

    if (response.status === "ERROR") {
      return { success: false, error: "Transaction submission failed" };
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
      return {
        success: false,
        hash: response.hash,
        error: `Transaction failed: ${getResponse.status}`,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function mint(
  publicKey: string,
  to: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "mint", [
    toScVal("address", to),
    toScVal("i128", amount),
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
    toScVal("address", from),
    toScVal("address", to),
    toScVal("i128", amount),
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
    toScVal("address", from),
    toScVal("address", spender),
    toScVal("i128", amount),
    toScVal("u32", expirationLedger),
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
    toScVal("address", spender),
    toScVal("address", from),
    toScVal("address", to),
    toScVal("i128", amount),
  ], signTransaction);
}

export async function burn(
  publicKey: string,
  from: string,
  amount: bigint,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "burn", [
    toScVal("address", from),
    toScVal("i128", amount),
  ], signTransaction);
}

export async function registerPoolAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "register_pool_address", [
    toScVal("address", address),
  ], signTransaction);
}

export async function removePoolAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "remove_pool_address", [
    toScVal("address", address),
  ], signTransaction);
}

export async function registerRouterAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "register_router_address", [
    toScVal("address", address),
  ], signTransaction);
}

export async function removeRouterAddress(
  publicKey: string,
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "remove_router_address", [
    toScVal("address", address),
  ], signTransaction);
}

export async function checkRelease(
  publicKey: string,
  target: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
): Promise<TxResult> {
  return buildAndSend(publicKey, "check_release", [
    toScVal("address", target),
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
