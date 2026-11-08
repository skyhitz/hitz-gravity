/**
 * A readable message from anything a call can throw. Wallets reached through
 * Stellar Wallets Kit reject with plain `{ code, message }` objects rather
 * than `Error`s, which `String(err)` turns into "[object Object]".
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
