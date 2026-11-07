# Gravity HITZ: Legal Disclosure

**Effective Date:** November 4, 2026 (first published April 2026)  
**Protocol:** Gravity HITZ and the HITZ Sovereign Vault (together, the "Protocol")  
**Jurisdiction:** Applicable laws of the user's country of residence

> This document governs all interactions with the Gravity HITZ token contract and the HITZ Sovereign Vault contract deployed on the Stellar Network. By connecting a wallet or executing any transaction, you accept every term below in full.

---

## I. The Gravity Law Acknowledgment

The Gravity HITZ Protocol enforces a dynamic, mathematically-derived holding limit called the **Event Horizon**, denoted **L**, defined as:

```
L = floor( sqrt( S × 10⁷ ) )
```

where **S** (Total Mass) is the real-time sum of HITZ token balances held by admin-registered pools: the Sovereign Vault and the treasury account.

**The following consequences are intentional, designed behaviors, not bugs, errors, or malfunctions:**

1. Any account whose HITZ balance exceeds **L** is **automatically and immediately Vaulted** by the smart contract. A Vaulted account can send HITZ only to a registered pool, such as by selling it into the Sovereign Vault; every other outbound transfer is blocked at the protocol level.
2. L is dynamic. It rises as HITZ enters registered pools and falls as HITZ leaves them, including whenever anyone buys HITZ from the Sovereign Vault. An account that is free today may become Vaulted tomorrow if the ecosystem contracts.
3. A purchase from the Sovereign Vault is judged against the L that the purchase itself leaves behind. Buying HITZ can Vault the buyer.
4. Neither the Protocol developers nor any associated party can override, bypass, or reverse the Vaulting state of any account. The contract is the sole authority.
5. Ghost Vaulting, the passive Vaulting of accounts that never exceeded L at any single point but whose balance now exceeds a reduced L, is an expected emergent property of the model.

The developers make no warranty that any specific balance will remain below L at any future time.

---

## II. Releasing a Vaulted Account

A Vaulted balance can be reduced in two ways, both of which move HITZ into a registered pool:

1. **A sale into the Sovereign Vault.** You swap HITZ for an asset the vault lists (XLM or USDC at launch). You receive what the vault pays at that moment, minus its fee (Section III), and your HITZ joins the vault's reserves.
2. **A Sacrifice.** An intentional, voluntary transfer of HITZ from the Vaulted account to a registered pool, with nothing received in return.

**Terms of release:**

- A sale or a Sacrifice is a permanent, irreversible on-chain transaction. Tokens sent to a pool do not return to the sender under any circumstances.
- A Sacrifice constitutes a voluntary, irrevocable loss of property in exchange for potential restoration of transfer rights, subject to the updated L calculation. HITZ transferred directly to the Sovereign Vault outside a swap or deposit is not added to any pool's reserves and can never be recovered.
- There is no guarantee that a sale or Sacrifice of any specific amount will reduce the account's balance below L, as L changes in real time. Amounts shown in the interface are previews.
- The developers have no ability to reverse, refund, or compensate for any sale or Sacrifice, regardless of user intent, error, or system behavior.

By releasing an account this way, you confirm that you understand the consequences above and that you are not acting under duress, mistake, or misrepresentation.

---

## III. The Sovereign Vault

The Sovereign Vault is HITZ's own exchange: a smart contract holding one constant-product pool per listed asset, each against HITZ. By trading with or depositing into it you acknowledge that:

1. **Fees are dynamic.** Every pass through a pool pays a fee of at least 1%, which rises exponentially while a trade leaves one listed asset dislocated against another, up to 10%. A two-asset trade (for example XLM to USDC) passes through two pools and pays two fees. The fee depends on the size of your trade, on other trades, and on time; it is withheld from what you receive and stays in the vault.
2. **Prices are the vault's own.** The vault's prices can differ from other markets, and they can move between the moment you see a quote and the moment your transaction executes. A quote is an estimate, not an offer; the minimum you accept (your slippage tolerance) is the only bound.
3. **Deposits cannot be withdrawn.** Anyone may add liquidity at a pool's current ratio. Depositors receive no shares, no claim on the vault's assets, and no share of fees. Deposited assets leave the vault only as other people's swap outputs.
4. **Liquidity can be thin.** The vault's depth determines its prices and fees. In a shallow pool even small trades can pay the maximum fee. Nothing guarantees any level of liquidity, or that you can sell at any price.
5. **Listed assets carry their issuers' risk.** Each listed asset is controlled by its own issuer, who may be able to freeze, claw back or alter it. Such an action can stop or impair that asset's pool. HITZ itself is backed by every listed asset at once.
6. **The vault has an administrator.** The admin seeds each listed asset's pool once, can list a new asset after a public 7-day timelock, and can upgrade the vault's code after a public 7-day timelock. The admin may give up upgrades (`renounce_upgrades`) or every power (`renounce`), irreversibly.

---

## IV. Assumption of Risk

Interacting with the Protocol exposes you to material risks, which you irrevocably accept:

**4.1 Smart Contract Risk**  
This software is experimental and has not been formally audited by an independent third party. Unknown vulnerabilities may exist in the token, the vault, or their interaction. Bugs, exploits, or unintended behaviors may result in partial or total loss of tokens or deposited assets with no possibility of recovery.

**4.2 Soroban and Stellar Infrastructure Risk**  
The Protocol runs on the Stellar Network using the Soroban smart contract platform. Network outages, protocol upgrades, validator failures, state archival, or deprecation of the Soroban VM are beyond the developers' control and may render the Protocol inaccessible or non-functional.

**4.3 Market and Liquidity Risk**  
HITZ tokens may have little or no market value. The Protocol does not guarantee any liquidity, price stability, or ability to exchange HITZ for any other asset. Token value may go to zero. Arbitrage, by anyone, is an intended part of how the vault's prices follow other markets.

**4.4 Regulatory Risk**  
The legal classification of digital tokens varies by jurisdiction. You are solely responsible for determining the legality of acquiring, holding, transferring, trading, depositing and sacrificing HITZ tokens in your jurisdiction and for fulfilling any applicable tax obligations.

**4.5 Key Management Risk**  
Loss of access to your private key means permanent, irrecoverable loss of your HITZ balance and any other assets in the account. The developers have no ability to recover accounts.

**4.6 Upgrade and Admin Risk**  
The token and the vault each have an admin. The token's admin can mint up to the fixed 100,000,000 HITZ cap, change which addresses count as pools and routers, and upgrade the token's code; the vault's admin holds the powers in Section III. Code upgrades of either contract, and new vault listings, take effect only after a public 7-day timelock enforced by the contracts. Beyond that, the developers make no binding commitment regarding future changes to contract logic, registered pools, or listed assets.

---

## V. Class Action Waiver

**BY USING THIS SOFTWARE, YOU IRREVOCABLY AND UNCONDITIONALLY WAIVE YOUR RIGHT TO PARTICIPATE IN ANY CLASS ACTION LAWSUIT, CLASS-WIDE ARBITRATION, OR REPRESENTATIVE PROCEEDING OF ANY KIND.**

All disputes, claims, or controversies arising from or relating to the Protocol, these terms, or any transaction executed on the Protocol must be brought and resolved on an **individual basis only**.

You agree that:
- You will not bring any claim as a plaintiff or class member in any purported class action, collective action, private attorney general action, or other representative proceeding.
- You will not seek to consolidate any individual claim with any other person's or entity's claim.
- Any arbitrator, judge, or tribunal shall not have the authority to conduct class-wide proceedings or award class-wide relief.

If this waiver is found unenforceable for any reason, you agree that any dispute shall be resolved exclusively through binding individual arbitration under applicable rules.

---

## VI. No Financial Advice

The **Event Horizon (L)** displayed in the Gravity HITZ interface, along with any other protocol metrics (Total Mass, vault status, safety indicators, prices, quotes, fees, liquidity, volume, and price impact), are **technical figures** derived from live on-chain data and from estimates.

These values are not, and shall not be interpreted as:

- Investment advice or financial guidance of any kind
- A recommendation to acquire, hold, transfer, trade, deposit, or sacrifice any tokens
- A guarantee of financial return, token value, execution price, or protocol stability
- Legal advice regarding the regulatory status of digital assets

The Protocol is provided "as is," without warranty of any kind, express or implied. The developers expressly disclaim all warranties including fitness for a particular purpose, merchantability, and non-infringement.

---

## VII. Acknowledgment

By connecting a wallet to the Gravity HITZ interface, you confirm that:

1. You have read and understood this entire disclosure.
2. You are of legal age in your jurisdiction to enter into binding agreements.
3. You are not accessing this Protocol from a jurisdiction where doing so is prohibited.
4. You accept all risk of loss associated with your use of this Protocol.
5. You waive your right to class action participation as described above.
6. You are not relying on any representation, warranty, or statement made by the developers beyond what is expressly stated herein.

---

*Gravity HITZ is experimental software. The gravitational field does not negotiate.*
