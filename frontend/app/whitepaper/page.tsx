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
 *   - JSX wrappers (Var, FormulaBlock, InfoBox, CodeBlock, TierCard,
 *     DataTable) render things the markdown does with inline formatting,
 *     fenced code or plain tables.
 *   - The page has a sticky nav + footer chrome the markdown can't.
 *   - Section references and links point at GitHub or the live API here,
 *     where the markdown links to files in the repo.
 *
 * House style: no em-dashes. Use commas or periods.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { CONTRACT_ID } from "../lib/stellar";
import { VAULT_ID } from "../lib/vault";

export const metadata: Metadata = {
  title: "HITZ Protocol. Whitepaper",
  description:
    "How HITZ Protocol provides liquidity without mercenary LPs or oracles: the Sovereign Vault, its dislocation fee, and the HITZ token's Event Horizon.",
};

const GITHUB = "https://github.com/skyhitz/hitz-gravity/blob/main";

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
          <span className="text-xs text-muted font-mono">v7.0 · November 2026</span>
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
              HITZ Protocol
            </h1>
            <p className="text-xl text-muted font-light">
              Oracle-free, protocol-owned liquidity on Stellar
            </p>
          </div>
          <div className="w-12 h-px bg-border" />
          <p className="text-muted text-base leading-relaxed max-w-xl">
            HITZ Protocol is an oracle-free financial primitive on Stellar
            (Soroban). Its goal is to solve liquidity provisioning without
            depending on outside capital (mercenary LPs) or outside price feeds
            (oracles). Two contracts form a closed loop. The Sovereign Vault,
            HITZ&apos;s own exchange, owns its liquidity, follows the market
            through arbitrage instead of an oracle, and keeps part of every
            arbitrage profit in its pools as a fee, so the liquidity compounds.
            The HITZ token bounds concentration per account: an account holding
            more than the Event Horizon L = √S, where S is the HITZ in the
            protocol&apos;s pools, can send HITZ only back into a pool.
          </p>
        </header>

        {/* I. The Liquidity Problem */}
        <Section number="I" title="The Liquidity Problem">
          <p>
            A token is only as usable as the liquidity behind it, and most
            tokens rent theirs.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>Mercenary liquidity.</strong>{" "}Liquidity providers deposit
              for incentives and withdraw when the incentives end, often when the
              market needs them most. Paying them costs the project tokens, and
              the depth leaves with them.
            </li>
            <li>
              <strong>Oracles.</strong>{" "}A pool that prices itself from an
              outside feed trusts the feed&apos;s operator and inherits its
              failures: stale updates, outages and manipulation.
            </li>
            <li>
              <strong>Arbitrage leakage.</strong>{" "}A plain constant-product pool
              needs neither, but every time the market moves, arbitrageurs take
              the price gap out of the pool, and a flat fee keeps only a small
              share of it.
            </li>
          </ul>
          <p>
            HITZ&apos;s first pools, on Aquarius, show the last point: from May
            22 to October 2, 2026, 3,031 arbitrage cycles took $52.78 from about
            $2,800 of liquidity, while the pools&apos; half of the 0.1% fee kept
            about $4.
          </p>
          <p>
            HITZ Protocol answers all three with liquidity the protocol owns,
            priced by arbitrage, behind a fee that keeps most of what the
            arbitrage is worth.
          </p>
        </Section>

        {/* II. The Closed Loop */}
        <Section number="II" title="The Closed Loop">
          <p>Two contracts, each with one job, feed each other:</p>
          <ol className="list-decimal list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>The vault owns the liquidity.</strong>{" "}One
              constant-product pool per trusted asset (XLM and USDC today), each
              against HITZ. The protocol seeded it, anyone can add to it, and
              nothing leaves it except swap outputs (Section III).
            </li>
            <li>
              <strong>Arbitrage keeps its prices.</strong>{" "}When one asset moves
              against another elsewhere, the vault&apos;s rate between them falls
              behind until someone trades it back. There is no oracle to wait
              for.
            </li>
            <li>
              <strong>The fee keeps the profit.</strong>{" "}The fee rises with how
              far a trade moves one asset against another and stays in the pool
              it came from, so the arbitrage that restores the price pays the
              vault for most of the gap. Every trade leaves k, the pools&apos;
              depth, a little higher.
            </li>
            <li>
              <strong>The token ties holdings to that depth.</strong>{" "}The HITZ
              in the protocol&apos;s pools is Total Mass <Var>S</Var>, and no
              account can hold more than <Var>L</Var> = √<Var>S</Var> HITZ and
              still move it freely (Section IV). Above <Var>L</Var>, HITZ can only
              go back into a pool, which adds to <Var>S</Var>.
            </li>
          </ol>
          <p>
            The loop needs no price feed and no liquidity provider who can
            leave. What it needs is trading: arbitrage to keep the price honest,
            and flow (purchases, sales, the HITZ Terminal&apos;s subscriptions)
            for the fee to compound on.
          </p>
        </Section>

        {/* III. The Sovereign Vault */}
        <Section number="III" title="The Sovereign Vault">
          <p>
            HITZ&apos;s own exchange: one constant-product pool per trusted
            asset, each against HITZ, all sharing HITZ. It started on November
            4, 2026 with XLM and USDC; more can be listed later without new
            code, up to 16 in all. HITZ ↔ asset is one hop through that
            asset&apos;s pool; asset ↔ asset is two hops through HITZ in one
            call, and never moves HITZ out of the vault.
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
          <DataTable
            head={["D", "Fee"]}
            rows={[
              ["0", "1.00%"],
              ["0.5%", "1.65%"],
              ["1%", "2.72%"],
              ["1.5%", "4.48%"],
              ["2%", "7.39%"],
              ["2.30% or more", "10.00%"],
            ]}
            mono
          />
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
              <strong>Decay.</strong>{" "}Deviations decay toward zero with the
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

          <SubHeading>Protocol-Owned Liquidity</SubHeading>
          <p>
            The admin seeds each listed asset&apos;s pool once, at its market
            price. After that anyone can deposit at the pool&apos;s current
            ratio, as a contribution: there are no LP shares and no
            withdrawals, and nothing leaves the vault except swap outputs. The
            liquidity HITZ trades against can&apos;t be pulled.
          </p>
          <p>
            The vault&apos;s liquidity came from the protocol&apos;s own
            Aquarius positions: 10% seeded on November 4, 2026 and the rest
            deposited on November 9, about $5,800 in all (live figures at{" "}
            <ExternalLink href="https://skyhitz.io/api/v1/vault">/api/v1/vault</ExternalLink>
            ).
          </p>

          <SubHeading>Arbitrage Instead of an Oracle</SubHeading>
          <p>
            The vault reads no price feed. When the market moves, its rate lags
            until an arbitrageur trades it back, and anyone may: the{" "}
            <ExternalLink href={`${GITHUB}/contracts/sovereign-vault/INTEGRATION.md`}>integration guide</ExternalLink>{" "}
            documents the calls and how to size a trade. Skyhitz runs an{" "}
            <ExternalLink href={`${GITHUB}/frontend/ARB_BOT.md`}>open-source bot</ExternalLink>{" "}
            that does it every five minutes from a public account (
            <ExternalLink href="https://skyhitz.io/api/v1/bot">/api/v1/bot</ExternalLink>
            ), paying the same fees as everyone. It buys on the Stellar DEX the
            asset the vault overpays for, then sells it into the vault, with
            on-chain minimums on both legs.
          </p>
          <p>
            Replayed on the Stellar DEX&apos;s real prices from June 12 to
            November 11, 2026, at the vault&apos;s depth of November 11: without
            a bot the vault&apos;s XLM price sat 8.6% off the market on average,
            and more than 5% off 64% of the time; with the bot, 2.1% off on
            average, and more than 5% off 3% of the time.
          </p>

          <SubHeading>What the Fee Keeps</SubHeading>
          <p>
            The fee prices how far a trade moves one asset&apos;s rate from its
            recent average. The trade that brings the vault to a new market
            price therefore pays most of the gap, in steps as the average
            catches up.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>Against a flat fee.</strong>{" "}Replayed from May 22 to
              October 31, 2026 on the real XLM price, from the old pools&apos;
              reserves, with an arbitrageur calibrated to their real history,
              the vault&apos;s fee gained $54.15 over holding the assets, against
              $8.02 for the Aquarius pools&apos; 0.1%, and arbitrage took $13.35
              from the pools instead of $62.44.
            </li>
            <li>
              <strong>Who keeps the arbitrage.</strong>{" "}In the{" "}
              <ExternalLink href={`${GITHUB}/research/arb-bot-replay/README.md`}>bot replay</ExternalLink>
              , the vault&apos;s fees came to 67% to 89% of what the arbitrage
              made in all, depending on how large a profit the arbitrageur
              waited for: $37.72 for the vault against $6.78 for the bot at the
              bot&apos;s own setting.
            </li>
          </ul>

          <SubHeading>Flow Into the Vault</SubHeading>
          <p>
            Three kinds of trade pay the fee: arbitrage, people buying and
            selling HITZ, and the{" "}
            <Link href="/terminal/" className="text-accent hover:text-accent-hover underline">
              HITZ Terminal
            </Link>
            . The Terminal sells XLM market, leverage and on-chain flow data;
            its paid plans are priced in dollars and paid in USDC or XLM, and
            each payment is one vault swap that buys HITZ and sends it to the
            treasury. The vault earns its fee on every subscription.
          </p>

          <SubHeading>The Event Horizon Inside the Vault</SubHeading>
          <p>
            The vault is a registered pool, so the HITZ it holds is Total Mass.
            A purchase moves HITZ out of the vault and lowers <Var>S</Var> a
            little; a sale moves it in and raises <Var>S</Var>. The token judges
            a buyer against the <Var>L</Var> the purchase leaves behind. A
            vaulted account can always sell into the vault.
          </p>

          <SubHeading>Why HITZ Runs Its Own Exchange</SubHeading>
          <p>
            Each pool registration binds the pool&apos;s code. On October 2,
            2026 Aquarius upgraded both HITZ pools, the token&apos;s integrity
            guard stopped trusting them, and trading froze. Rebinding external
            pools to code nobody reviewed would hand their price gaps to
            arbitrageurs and trust code HITZ doesn&apos;t control. The vault is
            code HITZ controls, under the same 7-day timelock as the token, and
            it trades HITZ against every listed asset at once.
          </p>
        </Section>

        {/* IV. The Event Horizon */}
        <Section number="IV" title="The Event Horizon">
          <p>
            Define <Var>S</Var> as the <strong>Total Mass</strong>, the sum of
            HITZ balances held by the admin-registered pools: today the
            Sovereign Vault and the treasury. <Var>S</Var>{" "}is an O(1)
            accumulator updated on every transfer in or out of a pool.
          </p>
          <p>
            The <strong>Safety Limit</strong> <Var>L</Var>, displayed in the
            interface as the <strong>Event Horizon</strong>, is computed as:
          </p>

          <FormulaBlock>
            L = ⌊ √( S × 10<sup>d</sup> ) ⌋
          </FormulaBlock>

          <p>
            where <Var>d</Var>{" "}= 7 (Stellar&apos;s standard decimal precision),
            so that in whole HITZ, <Var>L</Var> = √<Var>S</Var>. Any account
            whose balance exceeds <Var>L</Var> is <strong>vaulted</strong>: it
            can only send HITZ to a registered pool until its balance is back
            under <Var>L</Var>, or until the vault grows enough that{" "}
            <Var>L</Var> rises above it.
          </p>

          <InfoBox color="purple">
            <strong>Square-root rule:</strong> <Var>L</Var> grows with the square
            root of <Var>S</Var>: a 10,000× deeper vault allows a 100× larger
            account. As the vault deepens, the most one account can hold
            shrinks as a share of it.
          </InfoBox>

          <DataTable
            head={["Total Mass (S)", "Event Horizon (L)", "L as a share of S"]}
            rows={[
              ["100 HITZ", "10 HITZ", "10%"],
              ["10,000 HITZ", "100 HITZ", "1%"],
              ["1,000,000 HITZ", "1,000 HITZ", "0.1%"],
              ["100,000,000 HITZ", "10,000 HITZ", "0.01%"],
            ]}
            mono
          />
          <p>Today S is about 98.4 million HITZ and L about 9,900 HITZ.</p>

          <SubHeading>What the Limit Does Not Do</SubHeading>
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>It limits accounts, not people.</strong>{" "}Stellar has no
              identity layer, so one owner can hold HITZ in many accounts, each
              under <Var>L</Var>. The rule guarantees something narrower: no
              single account can hold more than <Var>L</Var> and still move it
              freely.
            </li>
            <li>
              <strong>It does not cap purchases.</strong>{" "}Incoming transfers
              never fail (Section VI), so an account can buy far past{" "}
              <Var>L</Var>; it can then only sell back into the vault.
            </li>
            <li>
              <strong>Anyone can push an account over L</strong>{" "}by sending it
              HITZ. The account can still sell into the vault, and is released
              once it is back under <Var>L</Var>.
            </li>
            <li>
              <strong>Registered pools and routers are exempt.</strong>{" "}Today:
              the vault; the treasury, which is the admin&apos;s account, holds
              about 9.96 million HITZ and is registered as a pool, so its HITZ
              counts in <Var>S</Var>; and the email gateway&apos;s gas sponsor, a
              router holding about 33,000 HITZ for the legacy reparation.
            </li>
          </ul>
        </Section>

        {/* V. Pools and Routers */}
        <Section number="V" title="Pools and Routers">
          <p>
            Not all contract addresses are equal. HITZ distinguishes two classes
            of trusted infrastructure, each with its own rules:
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
                "Pass-through only (today the email gateway's gas sponsor)",
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
            <strong>Pool status is granted per address, never by bytecode.</strong>
          </p>
        </Section>

        {/* VI. Transfer Rules */}
        <Section number="VI" title="Transfer Rules">
          <SubHeading>Incoming Transfers Always Succeed</SubHeading>
          <p>
            Incoming transfers <em>never</em>{" "}revert due to vault logic. If a
            recipient&apos;s new balance exceeds <Var>L</Var>, the recipient is
            vaulted, but the transfer succeeds and returns a clean SEP-41 void.
            This is what lets an exchange pay out a swap&apos;s output without
            ever failing on the buyer&apos;s balance.
          </p>

          <SubHeading>The Sender Gate (Lazy-Synced)</SubHeading>
          <p>
            Before the sender gate fires, the sender&apos;s stored vault flag is
            re-synced against the current <Var>L</Var>. If the vault grew past
            the sender&apos;s balance since they were last vaulted, the flag
            clears inline and the transfer proceeds. No wall around an account
            whose balance is already safe. After the live re-sync, a
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
            been updated. A previously vaulted holder whose balance now sits
            below <Var>L</Var> (because the vault grew) is released in the same
            transaction. Stored flags are never stale for longer than one
            state-changing call.
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
              The vault grows: <Var>S</Var> increases, <Var>L</Var>{" "}rises past
              the account&apos;s balance, and the next action auto-releases.
            </li>
          </ol>
          <p>
            The smallest release is the least <Var>x</Var> with{" "}
            <code className="font-mono text-xs">balance − x ≤ √((S + x) × 10^7)</code>.
            For UIs that want to reflect the rule without triggering a state
            change,{" "}
            <code className="font-mono text-xs">is_actually_vaulted(address)</code>{" "}
            evaluates the current <Var>L</Var> live, ignoring the stored flag.
          </p>
        </Section>

        {/* VII. Supply */}
        <Section number="VII" title="Supply">
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
          <p>The supply is fully minted. Where it is on November 13, 2026:</p>
          <DataTable
            head={["Holder", "HITZ", "Share"]}
            rows={[
              ["Sovereign Vault (its pools)", "88,420,475", "88.4%"],
              ["Treasury (the admin's account, a registered pool)", "9,963,901", "10.0%"],
              ["Gas sponsor of the email gateway (a registered router)", "32,966", "0.03%"],
              ["Every other account", "1,582,658", "1.6%"],
            ]}
          />
        </Section>

        {/* VIII. Admin, Timelocks and Decentralization */}
        <Section number="VIII" title="Admin, Timelocks and Decentralization">
          <p>
            HITZ Protocol is decentralized by design: prices need no oracle, the
            liquidity needs no outside LPs, and anyone can trade, deposit or
            arbitrage. The exception is the admin role. Today one account (
            <code className="font-mono text-xs">GCAETBNB…OKGU</code>) is the
            admin of both contracts and is the treasury.
          </p>
          <DataTable
            head={["Power", "Contract", "Takes effect"]}
            rows={[
              ["Upgrade the code", "token, vault", "after a public 7-day notice"],
              ["List a new trusted asset", "vault", "after a public 7-day notice"],
              ["Seed a newly listed asset's pool, once", "vault", "immediately"],
              ["Register or remove pools and routers", "token", "immediately"],
              ["Hand the admin role to another account (both sign)", "token", "immediately"],
              ["Mint, up to the cap", "token", "immediately (fully minted, so only after burns)"],
            ]}
          />
          <p>
            Registry changes are the strongest immediate power: registering an
            address exempts it from the Event Horizon, and removing the vault
            from the registry would cut <Var>S</Var>{" "}to the treasury&apos;s
            balance, lower <Var>L</Var>{" "}to about 3,160 HITZ and stop the vault
            from paying out HITZ. The vault&apos;s admin can&apos;t be rotated,
            so the account&apos;s own signers are what protect it (
            <ExternalLink href={`${GITHUB}/AUDIT.md`}>AUDIT.md</ExternalLink>,
            findings T-3 and V-3).
          </p>
          <p>Each contract has a one-way exit:</p>
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <code className="font-mono text-xs">renounce_upgrades</code>{" "}freezes
              the vault&apos;s code for good and keeps the timelocked listing;{" "}
              <code className="font-mono text-xs">renounce</code> ends every vault
              power.
            </li>
            <li>
              <code className="font-mono text-xs">renounce_admin</code> ends
              minting, upgrades and registry changes on the token for good. It
              refuses while any registered address is a classic account or runs
              code other than its approved hash, so the registry must be final
              first. Today the treasury and the gas sponsor are classic accounts
              in it.
            </li>
          </ul>
        </Section>

        {/* IX. Implementation */}
        <Section number="IX" title="On-Chain Implementation">
          <p>
            HITZ is a{" "}
            <ExternalLink href="https://stellar.org/developers/soroban">Soroban</ExternalLink>{" "}
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

        {/* X. TTL Restoration */}
        <Section number="X" title="State Archival (TTL)">
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

        {/* XI. Security */}
        <Section number="XI" title="Security Properties">
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
              body: "Each registered pool and router stores its approved Wasm hash. If its code changes, the next state-changing call emits an integrity_drift_event and the address can no longer spend allowances; the admin reviews the new code and re-registers or removes it.",
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
              body: "Vault flags and balance keys share TTL extension calls. An expired vault key would silently free a vaulted account; we prevent this by always extending both together.",
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
          <p>
            Both contracts have been reviewed internally (
            <ExternalLink href={`${GITHUB}/AUDIT.md`}>AUDIT.md</ExternalLink>),
            with the findings and their status published; neither has had an
            independent audit yet.
          </p>
        </Section>

        {/* XII. Known Limits */}
        <Section number="XII" title="Known Limits">
          <ul className="list-disc list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              <strong>Per account, not per person.</strong>{" "}The Event Horizon
              can be spread across many accounts (Section IV).
            </li>
            <li>
              <strong>Prices lag the market.</strong>{" "}Without an oracle, the
              vault&apos;s price follows the market only as fast as arbitrage
              moves it: 2.1% off on average in the bot replay, more in fast
              moves. If no one arbitrages, its price goes stale.
            </li>
            <li>
              <strong>L is small today.</strong>{" "}At November 2026 prices{" "}
              <Var>L</Var> is worth about $0.32, so almost any purchase vaults
              the buyer: that HITZ can then only be sold back into the vault,
              until the vault grows enough to raise <Var>L</Var>. The swap screen
              says so before you sign.
            </li>
            <li>
              <strong>Purchases pay the fee too.</strong>{" "}Every hop pays at
              least 1%, and a purchase through one pool dislocates it against the
              others. At the vault&apos;s depth of November 2026, $5 of XLM buys
              HITZ at about 2.2% all in, and $20 or more at 11% or more, with the
              fee at its 10% cap. The swap screen shows the fee before you sign;
              buying in smaller steps hours apart pays less.
            </li>
            <li>
              <strong>Thin liquidity.</strong>{" "}About $5,800 in all: large trades
              move the price far.
            </li>
            <li>
              <strong>Listed assets carry their issuers&apos; risk.</strong>{" "}
              Circle can freeze the vault&apos;s USDC, which would stop the USDC
              pool; any listed asset&apos;s issuer has the same power over its
              own pool.
            </li>
            <li>
              <strong>Admin powers remain</strong>{" "}until renounced (Section
              VIII).
            </li>
          </ul>
        </Section>

        {/* XIII. Contracts */}
        <Section number="XIII" title="Deployed Contracts">
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
            <ExternalLink href={`${GITHUB}/contracts/sovereign-vault/INTEGRATION.md`}>INTEGRATION.md</ExternalLink>
            .
          </p>
        </Section>

        {/* Footer */}
        <footer className="pt-4 border-t border-border flex items-center justify-between text-xs text-muted">
          <span>HITZ Protocol · 2026</span>
          <div className="flex items-center gap-4">
            <a
              href={`${GITHUB}/LEGAL.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Legal
            </a>
            <Link href="/" className="hover:text-foreground transition-colors">
              Open the app →
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

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:text-accent-hover underline"
    >
      {children}
    </a>
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

/** A plain table: the first column in accent purple, the others muted, or all mono with `mono`. */
function DataTable({ head, rows, mono }: { head: string[]; rows: string[][]; mono?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="text-muted border-b border-border">
            {head.map((h) => (
              <th key={h} className="text-left py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={`py-2 pr-4 ${i === 0 ? (mono ? "font-mono text-purple" : "text-foreground") : mono ? "font-mono text-accent" : "text-muted"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
