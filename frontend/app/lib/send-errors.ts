// Why a transfer failed, in words for the sender (the Send card).
//
// Erasable TypeScript without imports, so tests/send-errors.test.mjs runs it
// in Node.

// Errors of the Stellar asset contracts (XLM, USDC and every other classic
// asset), as mainnet reports them:
//   #14  a transfer of XLM to an address with no account creates the account
//        when it carries 1 XLM or more, and is refused when it carries less
//   #13  the recipient has no trustline for the asset (account or not)
const BELOW_NEW_ACCOUNT_MINIMUM = /Error\(Contract, #14\)|below minimum balance for new account/i;
const TRUSTLINE_MISSING = /Error\(Contract, #13\)|trustline/i;

/**
 * What to tell the sender when a transfer of a classic asset (XLM, USDC, any
 * trustline asset) failed because of the recipient, or null when it failed
 * for another reason.
 *
 * Not for HITZ: its contract numbers its own errors, and it needs neither an
 * account nor a trustline on the receiving side.
 */
export function recipientCantReceive(error: string | undefined, symbol: string): string | null {
  if (!error) return null;
  if (TRUSTLINE_MISSING.test(error)) {
    return `The recipient can't receive ${symbol} yet: their account has no ${symbol} trustline. HITZ can be sent to anyone.`;
  }
  if (BELOW_NEW_ACCOUNT_MINIMUM.test(error)) {
    return "The recipient has no Stellar account yet. Send at least 1 XLM to open it, or send HITZ, which needs no account.";
  }
  return null;
}
