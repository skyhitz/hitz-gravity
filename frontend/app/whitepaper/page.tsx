/**
 * Canonical whitepaper surface.
 *
 * This page and `/WHITEPAPER.md` at the repo root are two renderings of the
 * same text. Any content change here MUST be mirrored into WHITEPAPER.md and
 * vice-versa. The two must not drift. Structural rule: every numbered
 * Section below maps 1:1 to a `## X.` heading in the markdown; sub-headings
 * map to `###` blocks.
 *
 * Style differences that are NOT content drift:
 *   - JSX wrappers (Var, FormulaBlock, InfoBox, CodeBlock, TierCard) render
 *     things the markdown does with inline formatting or fenced code.
 *   - The page has a sticky nav + footer chrome the markdown can't.
 *   - The markdown uses plain tables for the gravity table; the page uses a
 *     styled <table>. Same rows, same semantics.
 *
 * House style: no em-dashes. Use commas or periods.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { CONTRACT_ID } from "../lib/stellar";
import { VAULT_ID } from "../lib/vault";

export const metadata: Metadata = {
  title: "Gravity HITZ. Whitepaper",
  description:
    "The Invariant Gravity Model: a decentralization primitive for Soroban tokens on Stellar, and the Sovereign Vault HITZ trades on.",
};

export default function Whitepaper() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-6 h-12 flex items-center justify-between">
          <Link
            href="/"
            className="text-muted text-sm hover:text-foreground transition-colors flex items-center gap-2"
          >
            ← Home
          </Link>
          <span className="text-xs text-muted font-mono">v6.0 · 2026</span>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-16 space-y-20">
        {/* Title block */}
        <header className="space-y-6">
          <div className="space-y-1">
            <p className="text-accent text-sm font-medium tracking-widest uppercase">
              Whitepaper
            </p>
            <h1 className="text-4xl font-bold tracking-tight leading-tight">
              The Invariant Gravity Model
            </h1>
            <p className="text-xl text-muted font-light">
              A decentralization primitive for Soroban tokens
            </p>
          </div>
          <div className="w-12 h-px bg-border" />
          <p className="text-muted text-base leading-relaxed max-w-xl">
            HITZ applies a square-root invariant to every transfer. As total
            liquidity grows, individual holding limits rise, but always slower
            than the reserves themselves, permanently bounding concentration.
            Since November 2026 HITZ trades on its own exchange, the Sovereign
            Vault, whose fee rises while one asset is dislocated against
            another.
          </p>
        </header>

        {/* I. Problem */}
        <Section number="I" title="The Concentration Problem">
          <p>
            Most fungible tokens have no mechanism to prevent a single address
            from accumulating an unbounded fraction of supply. Whales can
            silently dominate governance, markets, and liquidity without
            triggering any on-chain constraint.
          </p>
          <p>
            Existing approaches, such as vesting schedules, transfer limits and
            blacklists, are either static, admin-dependent, or trivially
            circumvented. None of them self-adjust as the ecosystem grows.
          </p>
          <p>
            HITZ solves this with a{" "}
            <em>dynamic, self-adjusting holding limit</em> rooted in the amount
            of real liquidity the protocol has attracted. The more value the
            ecosystem holds in trusted pools, the more any individual can hold.
            But the relationship is a square root, perpetually sub-linear.
          </p>
        </Section>

        {/* II. The Model */}
        <Section number="II" title="The Gravity Model">
          <p>
            Define <Var>S</Var> as the <strong>Total Mass</strong>, the sum of
            HITZ balances held by the admin-registered pools: today the
            Sovereign Vault (Section V) and the treasury account. <Var>S</Var>{" "}
            is an O(1) accumulator updated on every transfer in or out of a
            pool.
          </p>
          <p>
            The <strong>Safety Limit</strong> <Var>L</Var>, displayed in the
            interface as the <strong>Event Horizon</strong>, is computed as:
          </p>

          <FormulaBlock>
            L = ⌊ √( S × 10<sup>d</sup> ) ⌋
          </FormulaBlock>

          <p>
            where <Var>d</Var>{" "}= 7 (Stellar&apos;s standard decimal precision).
            Any account whose balance exceeds <Var>L</Var> is{" "}
            <strong>vaulted</strong>: it can only send HITZ to a registered
            pool until its balance is back under <Var>L</Var>, or until the
            ecosystem grows enough that <Var>L</Var> rises above it.
          </p>

          <InfoBox color="purple">
            <strong>Law of Decentralization:</strong> A 10,000× growth in pool
            reserves only yields a 100× growth in individual holding limits.
            Concentration can never keep pace with liquidity.
          </InfoBox>

          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-muted border-b border-border">
                <th className="text-left py-2 pr-4 font-medium">Pool Reserves (S)</th>
                <th className="text-left py-2 pr-4 font-medium">Event Horizon (L)</th>
                <th className="text-left py-2 font-medium">Max single holder</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["100 HITZ", "10 HITZ", "10%"],
                ["10,000 HITZ", "100 HITZ", "1%"],
                ["1,000,000 HITZ", "1,000 HITZ", "0.1%"],
                ["100,000,000 HITZ", "10,000 HITZ", "0.01%"],
              ].map(([s, l, pct]) => (
                <tr key={s}>
                  <td className="py-2 pr-4 font-mono text-purple">{s}</td>
                  <td className="py-2 pr-4 font-mono text-accent">{l}</td>
                  <td className="py-2 text-muted">{pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* III. Two-Tier Identity */}
        <Section number="III" title="Two-Tier Identity">
          <p>
            Not all contract addresses are equal. HITZ distinguishes two classes
            of trusted infrastructure, each with distinct physics:
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-6">
            <TierCard
              color="purple"
              label="Pools"
              tag="register_pool_address"
              items={[
                "Affect Total Mass S",
                "Vaulted users can send to them",
                "A sale into the vault, or a sacrifice, can release a vault",
                "Never vaulted themselves",
                "Balance reconciled into S on registration",
              ]}
            />
            <TierCard
              color="accent"
              label="Routers"
              tag="register_router_address"
              items={[
                "Never affect Total Mass S",
                "Pass-through only (the gas sponsor, aggregators)",
                "Vaulted users CANNOT send to them",
                "Never vaulted themselves",
                "No mass reconciliation needed",
              ]}
            />
          </div>

          <p>
            Both tiers are registered by the admin on a per-address basis, and
            each registration binds the address&apos;s current Wasm hash.
            Earlier versions of HITZ used Wasm hash detection, automatically
            treating any contract whose bytecode matched an approved hash as a
            pool. This was abandoned because DEX factories allow anyone to
            deploy a contract with any Wasm hash, enabling laundering via fake
            pools.{" "}
            <strong>
              Strict address whitelisting is the only secure approach.
            </strong>
          </p>
        </Section>

        {/* IV. Transfer Physics */}
        <Section number="IV" title="Transfer Physics">
          <SubHeading>The Roach Motel (Silent Trap)</SubHeading>
          <p>
            Incoming transfers <em>never</em>{" "}revert due to vault logic. If a
            recipient&apos;s new balance exceeds <Var>L</Var>, they are silently
            vaulted, but the transfer succeeds and returns a clean SEP-41 void.
            This is what lets an exchange pay out a swap&apos;s output without
            ever failing on the buyer&apos;s balance.
          </p>

          <SubHeading>The Sender Gate (Lazy-Synced)</SubHeading>
          <p>
            Before the sender gate fires, the sender&apos;s stored vault flag is
            re-synced against the current <Var>L</Var>. If the protocol grew
            past the sender&apos;s balance since they were last trapped, the
            flag clears inline and the transfer proceeds. No panic wall around
            an account whose balance is already safe. After the live re-sync, a
            still-vaulted sender is blocked unless all four conditions hold:
          </p>
          <CodeBlock>{`!is_pool(from)
&& !is_router(from)
&& is_vaulted(from)   // evaluated against live L
&& !is_pool(to)
→ panic("Account is vaulted: transfers locked.")`}</CodeBlock>
          <p>
            Pools and routers are always exempt as senders. Vaulted users can
            only send to an approved pool: not to a router, not to any other
            address. Sending to a pool reduces the sender&apos;s balance and
            increases <Var>S</Var>, potentially releasing the vault if the new
            balance falls below the updated <Var>L</Var>.
          </p>

          <SubHeading>Correction on Receive</SubHeading>
          <p>
            After every balance-changing call (transfer, transfer_from, mint,
            burn) the recipient&apos;s vault flag is re-evaluated against their
            new balance and the current <Var>L</Var>, after <Var>S</Var> has
            been updated. A previously trapped holder whose balance now sits
            below <Var>L</Var> (because the ecosystem expanded) is released in
            the same transaction. Stored flags are never stale for longer than
            one state-changing call.
          </p>

          <SubHeading>Vault Release</SubHeading>
          <p>
            An account is released when its balance ≤ <Var>L</Var>. Thanks to
            lazy evaluation, release happens automatically on the user&apos;s
            next touch:
          </p>
          <ol className="list-decimal list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              Sell HITZ into the Sovereign Vault. The vault is a registered
              pool, so the sale is always allowed; the seller is paid in XLM or
              USDC, and the HITZ that enters the vault raises <Var>S</Var> and{" "}
              <Var>L</Var>.
            </li>
            <li>
              Sacrifice: transfer HITZ to a registered pool as a gift. Same
              effect on <Var>S</Var>, nothing back.
            </li>
            <li>
              The ecosystem grows: <Var>S</Var> increases, <Var>L</Var>{" "}rises
              past the account&apos;s balance, and the next action
              auto-releases.
            </li>
          </ol>
          <p>
            The smallest release is the least <Var>x</Var> with{" "}
            <code className="font-mono text-xs">balance − x ≤ √((S + x) × 10^7)</code>.
            For UIs that want to reflect physics without triggering a state
            change,{" "}
            <code className="font-mono text-xs">is_actually_vaulted(address)</code>{" "}
            evaluates the current <Var>L</Var> live, ignoring the stored flag.
          </p>
        </Section>

        {/* V. The Sovereign Vault */}
        <Section number="V" title="The Sovereign Vault">
          <p>
            HITZ&apos;s own exchange: one constant-product pool per trusted
            asset, each against HITZ, all sharing HITZ. It started on November
            4, 2026 with XLM and USDC; more can be listed later without new
            code, up to 16 in all. HITZ ↔ asset is one hop through that
            asset&apos;s pool; asset ↔ asset is two hops through HITZ in one
            call, and never moves HITZ out of the vault.
          </p>
          <p>
            <strong>Why HITZ needs its own.</strong>{" "}Each pool registration
            binds the pool&apos;s code. On October 2, 2026 Aquarius upgraded
            both HITZ pools, the token&apos;s integrity guard stopped trusting
            them, and trading froze. Rebinding external pools to code nobody
            reviewed would hand their price gaps to arbitrageurs and trust code
            HITZ doesn&apos;t control. The vault is code HITZ controls, under
            the same 7-day timelock as the token, and it compounds: HITZ is
            backed by every listed asset at once.
          </p>

          <SubHeading>The Dislocation Fee</SubHeading>
          <p>
            Each pool prices HITZ in its asset, and two pools together give the
            vault&apos;s exchange rate between their assets. Every pool keeps
            an exponential average of its own log price (2-hour time constant)
            and stores how far it sits from that average: its{" "}
            <em>deviation</em>. A pair&apos;s <em>dislocation</em> is the
            difference of the two deviations, so a move in HITZ itself shifts
            every pool alike and dislocates nothing. A hop through the pool of
            asset A pays:
          </p>
          <CodeBlock>{`fee = 1% × e^(100 × D)     capped at 10%
D   = the largest |dislocation| of A against any reference pool,
      in the state the hop leaves behind`}</CodeBlock>
          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-muted border-b border-border">
                <th className="text-left py-2 font-medium">D</th>
                <th className="text-left py-2 font-medium">Fee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["0", "1.00%"],
                ["0.5%", "1.65%"],
                ["1%", "2.72%"],
                ["1.5%", "4.48%"],
                ["2%", "7.39%"],
                ["2.30% or more", "10.00%"],
              ].map(([d, fee]) => (
                <tr key={d}>
                  <td className="py-2 font-mono text-purple">{d}</td>
                  <td className="py-2 font-mono text-accent">{fee}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>One asset relative to another.</strong>{" "}HITZ&apos;s own
              price never enters D.
            </li>
            <li>
              <strong>The worst pair.</strong>{" "}A hop pays for its asset&apos;s
              most dislocated pair, so no route through a third asset and no
              split into single hops is cheaper.
            </li>
            <li>
              <strong>References.</strong>{" "}A pool counts as a reference only if
              it holds at least 1/8 of the other pool&apos;s HITZ, so a shallow
              pool can&apos;t raise a deep one&apos;s fee.
            </li>
            <li>
              <strong>Decay.</strong> Deviations decay toward zero with the
              2-hour time constant, so after a move the fee falls back to 1% on
              its own.
            </li>
          </ul>
          <p>
            The fee is withheld from each hop&apos;s output and stays in the
            pool it was drained from: k never decreases. When the market moves
            one asset against another, the vault&apos;s rate falls behind;
            closing that gap is the arbitrage, and its fee is what deepens the
            pools.
          </p>

          <SubHeading>Liquidity</SubHeading>
          <p>
            The admin seeds each listed asset&apos;s pool once, at its market
            price. After that anyone can deposit at the pool&apos;s current
            ratio. There are no LP shares and no withdrawals: nothing leaves
            the vault except swap outputs.
          </p>

          <SubHeading>Gravity Inside the Vault</SubHeading>
          <p>
            The vault is a registered pool, so the HITZ it holds is Total Mass.
            A purchase moves HITZ out of the vault and lowers <Var>S</Var> a
            little; a sale moves it in and raises <Var>S</Var>. The token judges
            a buyer against the <Var>L</Var> the purchase leaves behind. A
            vaulted account can always sell into the vault.
          </p>

          <SubHeading>Admin and Timelocks</SubHeading>
          <p>
            The vault&apos;s admin has two powers, both public for 7 days before
            they can run: upgrading the code and listing a new trusted asset.
            Seeding a listed asset is the admin&apos;s too.{" "}
            <code className="font-mono text-xs">renounce_upgrades</code> ends
            upgrades for good and keeps listing;{" "}
            <code className="font-mono text-xs">renounce</code> ends everything.
          </p>
        </Section>

        {/* VI. Hard Mint Cap */}
        <Section number="VI" title="Hard Mint Cap">
          <p>
            HITZ compiles an absolute supply ceiling into the contract bytecode:
          </p>

          <FormulaBlock>
            MAX_SUPPLY = 100,000,000 × 10<sup>7</sup> stroops
          </FormulaBlock>

          <p>
            The mint entrypoint refuses any call that would push{" "}
            <Var>total_supply</Var> past this constant. Rejection panics before
            any state moves: no partial writes, no dangling events. Burns
            decrement <Var>total_supply</Var>, so the ceiling re-opens headroom
            as tokens exit circulation.
          </p>

          <InfoBox color="orange">
            <strong>Immutability path:</strong> The cap is a Rust{" "}
            <code className="font-mono text-xs">const</code>. Since v2.0.0
            every token upgrade is public for 7 days before it can run (
            <code className="font-mono text-xs">propose_upgrade</code>, then{" "}
            <code className="font-mono text-xs">upgrade</code>), and{" "}
            <code className="font-mono text-xs">renounce_admin</code> ends
            minting, upgrades and registry changes for good, at which point the
            cap is unalterable by any actor.
          </InfoBox>

          <p>
            Two queries expose the state:{" "}
            <code className="font-mono text-xs">total_supply()</code> returns
            current circulating supply, and{" "}
            <code className="font-mono text-xs">max_supply()</code> returns the
            compiled ceiling.
          </p>
        </Section>

        {/* VII. Implementation */}
        <Section number="VII" title="On-Chain Implementation">
          <p>
            HITZ is a{" "}
            <a
              href="https://stellar.org/developers/soroban"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover underline"
            >
              Soroban
            </a>{" "}
            smart contract on the Stellar network, fully implementing the{" "}
            <strong>SEP-41</strong> token interface.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-4">
            {[
              ["O(1) Accumulator", "TotalMass is a stateful i128 updated on every pool transfer. No iteration required."],
              ["Checked Arithmetic", "Every arithmetic operation uses checked_add / checked_sub / checked_neg to prevent overflow."],
              ["TTL Management", "Balance and Vault keys are always extended together (~30 days) to prevent silent expiry."],
              ["Infallible Limit", "current_limit_safe() returns i128::MAX on overflow so no address is spuriously vaulted."],
              ["SEP-41 Compliant", "transfer, transfer_from, approve, allowance, burn, burn_from, name, symbol, decimals, balance, with the standard transfer, mint, burn and approve events."],
              ["Gravity Events", "vaulted_event, pool_registered_event, router_registered_event, integrity_drift_event, initialized_event, admin_changed_event, upgrade_proposed_event, upgrade_cancelled_event, upgraded_event, admin_renounced_event."],
              ["Timelocked Upgrades", "propose_upgrade, a 7-day wait (pending_upgrade shows it), then upgrade; renounce_admin ends it all."],
            ].map(([title, desc]) => (
              <div key={title as string} className="bg-card border border-border rounded-xl p-4 space-y-1">
                <p className="text-sm font-medium text-foreground">{title}</p>
                <p className="text-xs text-muted leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* VIII. TTL Restoration */}
        <Section number="VIII" title="State Archival (TTL)">
          <p>
            Soroban persistent storage has a ~30-day TTL. An entry left
            untouched past that window is archived to cold storage until it is
            restored. A holder dormant for months will find their balance and
            vault state archived. Since Stellar Protocol 23 a transaction
            restores the archived entries it touches by itself, and simulation
            accounts for them; HITZ&apos;s frontend keeps the explicit restore
            path below for any RPC that still answers with a restore preamble.
          </p>

          <SubHeading>The Lazy-Restore Pattern</SubHeading>
          <ol className="list-decimal list-inside space-y-1 text-muted text-sm pl-2">
            <li>Simulate the user&apos;s intended call.</li>
            <li>
              If the RPC returns a{" "}
              <code className="font-mono text-xs">restorePreamble</code>,
              extract the archived footprint.
            </li>
            <li>
              Submit a one-op restore tx with that footprint; wait for
              finalization.
            </li>
            <li>Re-simulate against live state and proceed.</li>
          </ol>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-6">
            <TierCard
              color="accent"
              label="Email (custodial)"
              tag="gas station"
              items={[
                "Gas sponsor signs and pays for the restore",
                "User derivation key stays idle",
                "RestoreFootprintOp needs no owner auth",
                "User sees zero extra prompts",
              ]}
            />
            <TierCard
              color="purple"
              label="Wallet (non-custodial)"
              tag="Stellar Wallets Kit"
              items={[
                "User signs and pays for the restore in XLM",
                "Consistent with their gas posture",
                "One additional signature prompt",
                "Labelled as a state restore",
              ]}
            />
          </div>

          <p>
            No UI component or page-level code branches on archival. The
            primitive{" "}
            <code className="font-mono text-xs">callContract(id, method, args)</code>{" "}
            carries the restore logic end to end. Clicking Send after a
            year-long dormancy is indistinguishable from clicking Send after a
            day.
          </p>
        </Section>

        {/* IX. Security */}
        <Section number="IX" title="Security Properties">
          {[
            {
              title: "No Wasm Hash Laundering",
              body: "Pool status is tied to a specific address, not a bytecode fingerprint. A malicious actor cannot deploy a fake pool to inflate S.",
            },
            {
              title: "Bounded Supply",
              body: "The 100M HITZ ceiling is a compile-time constant. Admin mint authority exists, but mints that would exceed MAX_SUPPLY panic atomically. Changing the cap takes a public, 7-day upgrade, and none after renounce_admin.",
            },
            {
              title: "No Stale Vault",
              body: "Lazy evaluation re-syncs the stored vault flag against live L on every state-changing call. An outdated flag can't block a user whose balance is already safe, nor let a now-oversized holder escape.",
            },
            {
              title: "Integrity-Bound Registrations",
              body: "Each registered pool and router stores its current Wasm hash. A bytecode upgrade trips the integrity check on the next state-changing call, and the token stops trusting the address until the admin re-registers it.",
            },
            {
              title: "No Burn Escape",
              body: "Vaulted accounts cannot burn their tokens. Burn is treated as an exit route and blocked.",
            },
            {
              title: "No Router Escape",
              body: "Vaulted accounts cannot route tokens through a router. Only a transfer to an approved pool, such as a sale into the vault, releases the vault.",
            },
            {
              title: "No Silent Expiry",
              body: "Vault flags and balance keys share TTL extension calls. An expired vault key would silently free a trapped whale; we prevent this by always extending both together.",
            },
            {
              title: "No Mass Underflow",
              body: "TotalMass is guarded against underflow. Pool removal subtracts the current balance; adjust_total_mass panics before going negative.",
            },
            {
              title: "Timelocked Code",
              body: "Neither the token nor the vault can change code, and the vault can't list an asset, without a public 7-day notice.",
            },
            {
              title: "No Vault Drain",
              body: "The vault has no withdrawals and no LP shares; its reserves leave only as swap outputs, and its fee keeps k from ever falling.",
            },
          ].map(({ title, body }) => (
            <div key={title} className="flex gap-4 py-3 border-b border-border last:border-0">
              <span className="text-green mt-0.5 shrink-0">✓</span>
              <div>
                <p className="text-sm font-medium text-foreground">{title}</p>
                <p className="text-sm text-muted leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </Section>

        {/* X. Contracts */}
        <Section number="X" title="Deployed Contracts">
          {[
            {
              name: "HITZ token",
              id: CONTRACT_ID,
              rows: [
                ["Contract ID", CONTRACT_ID],
                ["Wasm Hash", "af53185dfc0e73a4502425d30cea74487ee4bf4d23fcabd32c5f1013626c5d2d"],
                ["Release", "v2.0.0, validated on Stellar Expert"],
                ["Standard", "SEP-41 (Soroban Token Interface)"],
                ["Decimals", "7"],
                ["Max Supply", "100,000,000 HITZ"],
              ],
            },
            {
              name: "Sovereign Vault",
              id: VAULT_ID,
              rows: [
                ["Contract ID", VAULT_ID],
                ["Wasm Hash", "7dea47b29b9ab94c1ea78fa647afc7b7aa065d952cbbf38e3f326dec29547763"],
                ["Release", "sovereign-vault-v1.0.0"],
                ["Assets", "XLM, USDC"],
              ],
            },
          ].map((c) => (
            <div key={c.name} className="bg-card border border-border rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <p className="text-xs text-muted uppercase tracking-widest font-medium">Stellar Mainnet · {c.name}</p>
              </div>
              <div className="divide-y divide-border">
                {c.rows.map(([k, v]) => (
                  <div key={k} className="flex items-start gap-4 px-5 py-3">
                    <span className="text-muted text-xs w-24 sm:w-28 shrink-0 pt-0.5">{k}</span>
                    <span className="font-mono text-xs text-foreground wrap-anywhere">{v}</span>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-border">
                <a
                  href={`https://stellar.expert/explorer/public/contract/${c.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent text-xs hover:text-accent-hover transition-colors"
                >
                  View on Stellar Expert →
                </a>
              </div>
            </div>
          ))}
          <p className="text-sm">
            Integrating with the vault:{" "}
            <a
              href="https://github.com/skyhitz/hitz-gravity/blob/main/contracts/sovereign-vault/INTEGRATION.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover underline"
            >
              INTEGRATION.md
            </a>
            .
          </p>
        </Section>

        {/* Footer */}
        <footer className="pt-4 border-t border-border flex items-center justify-between text-xs text-muted">
          <span>Gravity HITZ · 2026</span>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/skyhitz/hitz-gravity/blob/main/LEGAL.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Legal
            </a>
            <Link href="/" className="hover:text-foreground transition-colors">
              Open Mainnet →
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline gap-3">
        <span className="text-muted font-mono text-sm">{number}.</span>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="space-y-4 text-muted leading-relaxed text-[15px] pl-6">
        {children}
      </div>
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-foreground text-sm font-semibold uppercase tracking-wider pt-2">
      {children}
    </h3>
  );
}

function Var({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-accent text-[14px]">{children}</span>
  );
}

function FormulaBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 flex justify-center">
      <div className="bg-card border border-border rounded-2xl px-8 py-5 font-mono text-xl text-foreground tracking-tight">
        {children}
      </div>
    </div>
  );
}

function InfoBox({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "purple" | "accent" | "orange";
}) {
  const colors = {
    purple: "border-purple/30 bg-purple/5 text-purple",
    accent: "border-accent/30 bg-accent/5 text-accent",
    orange: "border-orange/30 bg-orange/5 text-orange",
  };
  return (
    <div
      className={`border rounded-xl px-4 py-3 text-sm leading-relaxed ${colors[color]}`}
    >
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-card border border-border rounded-xl px-4 py-3 text-xs font-mono text-foreground overflow-x-auto leading-relaxed">
      {children}
    </pre>
  );
}

function TierCard({
  color,
  label,
  tag,
  items,
}: {
  color: "purple" | "accent";
  label: string;
  tag: string;
  items: string[];
}) {
  const accent = color === "purple" ? "text-purple border-purple/30 bg-purple/5" : "text-accent border-accent/30 bg-accent/5";
  const dot = color === "purple" ? "bg-purple" : "bg-accent";
  return (
    <div className={`border rounded-2xl p-4 space-y-3 ${accent}`}>
      <div className="space-y-0.5">
        <p className="font-semibold text-sm">{label}</p>
        <p className="font-mono text-xs opacity-60">{tag}</p>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-xs text-muted">
            <span className={`w-1 h-1 rounded-full ${dot} shrink-0 mt-1.5`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
