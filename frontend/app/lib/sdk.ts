/**
 * sdk.ts: the Stellar SDK, loaded when something first needs it.
 *
 * The SDK is about 1 MB of JavaScript. Imported at the top of a module, it
 * lands in the first-load bundle of every page that module reaches, and the
 * page can't hydrate until it has been downloaded and parsed. Everything that
 * uses it is asynchronous anyway (a read from the RPC, a transaction to
 * build), so those functions await it here instead. The page becomes usable
 * first, and the SDK arrives as its own chunk while the first read is made.
 *
 * Rule for client code: never `import * as StellarSdk` for values in a module
 * a page loads at start. Use `await loadSdk()` inside the function that needs
 * it. For types, `import type * as StellarSdk from "@stellar/stellar-sdk"`
 * costs nothing.
 */

export type Sdk = typeof import("@stellar/stellar-sdk");

let pending: Promise<Sdk> | null = null;

export function loadSdk(): Promise<Sdk> {
  if (!pending) {
    pending = import("@stellar/stellar-sdk").catch((err) => {
      // A failed chunk download must not be remembered: the next call retries.
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Bytes as lowercase hex, without Node's Buffer (which would ship a polyfill to every page). */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
