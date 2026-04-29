# Gravity HITZ — Legal Disclosure

**Effective Date:** April 2026  
**Protocol:** Gravity HITZ (the "Protocol")  
**Jurisdiction:** Applicable laws of the user's country of residence

> This document governs all interactions with the Gravity HITZ smart contract deployed on the Stellar Network. By connecting a wallet or executing any transaction, you accept every term below in full.

---

## I. The Gravity Law Acknowledgment

The Gravity HITZ Protocol enforces a dynamic, mathematically-derived holding limit called the **Event Horizon**, denoted **L**, defined as:

```
L = floor( sqrt( S × 10⁷ ) )
```

where **S** (Total Mass) is the real-time sum of HITZ token balances held across all admin-approved liquidity pools.

**The following consequences are intentional, designed behaviors — not bugs, errors, or malfunctions:**

1. Any account whose HITZ balance exceeds **L** is **automatically and immediately Vaulted** by the smart contract. Outbound transfers from a Vaulted account are blocked at the protocol level.
2. L is dynamic. It rises as liquidity enters approved pools and falls as liquidity is withdrawn. An account that is free today may become Vaulted tomorrow if the ecosystem contracts.
3. Neither the Protocol developers nor any associated party can override, bypass, or reverse the Vaulting state of any account. The contract is the sole authority.
4. Ghost Vaulting — the passive Vaulting of accounts that never exceeded L at any single point but whose balance now exceeds a reduced L — is an expected emergent property of the model.

The developers make no warranty that any specific balance will remain below L at any future time.

---

## II. The Sacrifice Protocol

The sole mechanism to reduce a Vaulted balance is the **Sacrifice** — an intentional, voluntary transfer of HITZ tokens from the Vaulted account to an admin-approved liquidity pool.

**Terms of sacrifice:**

- A Sacrifice is a permanent, irreversible, non-refundable on-chain transfer.
- Tokens sacrificed are received by the liquidity pool in perpetuity. They do not return to the sender under any circumstances.
- A Sacrifice constitutes a voluntary, irrevocable loss of property in exchange for potential restoration of transfer rights, subject to the updated L calculation.
- There is no guarantee that a Sacrifice of any specific amount will reduce the account's balance below L, as L changes in real-time.
- The developers have no ability to reverse, refund, or compensate for any Sacrifice, regardless of user intent, error, or system behavior.

By executing a Sacrifice, you confirm that you understand it results in permanent token loss and that you are not acting under duress, mistake, or misrepresentation.

---

## III. Assumption of Risk

Interacting with Gravity HITZ exposes you to material risks, which you irrevocably accept:

**3.1 Smart Contract Risk**  
This software is experimental and has not been formally audited by an independent third party. Unknown vulnerabilities may exist. Bugs, exploits, or unintended behaviors may result in partial or total loss of tokens with no possibility of recovery.

**3.2 Soroban and Stellar Infrastructure Risk**  
The Protocol runs on the Stellar Network using the Soroban smart contract platform. Network outages, protocol upgrades, validator failures, or deprecation of the Soroban VM are beyond the developers' control and may render the Protocol inaccessible or non-functional.

**3.3 Market and Liquidity Risk**  
HITZ tokens may have little or no market value. The Protocol does not guarantee any liquidity, price stability, or ability to exchange HITZ for any other asset. Token value may go to zero.

**3.4 Regulatory Risk**  
The legal classification of digital tokens varies by jurisdiction. You are solely responsible for determining the legality of acquiring, holding, transferring, and sacrificing HITZ tokens in your jurisdiction and for fulfilling any applicable tax obligations.

**3.5 Key Management Risk**  
Loss of access to your private key means permanent, irrecoverable loss of your HITZ balance. The developers have no ability to recover accounts.

**3.6 Upgrade Risk**  
The Protocol includes an admin-controlled upgrade function. While this is intended to be used only for security patches prior to immutable deployment, the developers make no binding commitment regarding future changes to contract logic.

---

## IV. Class Action Waiver

**BY USING THIS SOFTWARE, YOU IRREVOCABLY AND UNCONDITIONALLY WAIVE YOUR RIGHT TO PARTICIPATE IN ANY CLASS ACTION LAWSUIT, CLASS-WIDE ARBITRATION, OR REPRESENTATIVE PROCEEDING OF ANY KIND.**

All disputes, claims, or controversies arising from or relating to the Gravity HITZ Protocol, these terms, or any transaction executed on the Protocol must be brought and resolved on an **individual basis only**.

You agree that:
- You will not bring any claim as a plaintiff or class member in any purported class action, collective action, private attorney general action, or other representative proceeding.
- You will not seek to consolidate any individual claim with any other person's or entity's claim.
- Any arbitrator, judge, or tribunal shall not have the authority to conduct class-wide proceedings or award class-wide relief.

If this waiver is found unenforceable for any reason, you agree that any dispute shall be resolved exclusively through binding individual arbitration under applicable rules.

---

## V. No Financial Advice

The **Event Horizon (L)** displayed in the Gravity HITZ interface, along with any other protocol metrics (Total Mass, vault status, safety indicators), are **technical parameters** derived from live on-chain data.

These values are not, and shall not be interpreted as:

- Investment advice or financial guidance of any kind
- A recommendation to acquire, hold, transfer, or sacrifice any tokens
- A guarantee of financial return, token value, or protocol stability
- Legal advice regarding the regulatory status of digital assets

The Gravity HITZ Protocol is provided "as is," without warranty of any kind, express or implied. The developers expressly disclaim all warranties including fitness for a particular purpose, merchantability, and non-infringement.

---

## VI. Acknowledgment

By connecting a wallet to the Gravity HITZ interface, you confirm that:

1. You have read and understood this entire disclosure.
2. You are of legal age in your jurisdiction to enter into binding agreements.
3. You are not accessing this Protocol from a jurisdiction where doing so is prohibited.
4. You accept all risk of loss associated with your use of this Protocol.
5. You waive your right to class action participation as described above.
6. You are not relying on any representation, warranty, or statement made by the developers beyond what is expressly stated herein.

---

*Gravity HITZ is experimental software. The gravitational field does not negotiate.*
