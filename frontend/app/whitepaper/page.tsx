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

export const metadata: Metadata = {
  title: "Gravity HITZ. Whitepaper",
  description:
    "The Invariant Gravity Model: a decentralization primitive for Soroban tokens on Stellar.",
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
            ← Mainnet
          </Link>
          <span className="text-xs text-muted font-mono">v5.0 · 2026</span>
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
            Existing approaches, vesting schedules, transfer limits, and
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
            HITZ balances held across all admin-approved liquidity pools.{" "}
            <Var>S</Var> is an O(1) accumulator updated on every transfer in or
            out of a pool.
          </p>
          <p>
            The <strong>Safety Limit</strong> <Var>L</Var>, displayed in the
            interface as the <strong>Event Horizon</strong>, is computed as:
          </p>

          <FormulaBlock>
            L = ⌊ √( S × 10<sup>d</sup> ) ⌋
          </FormulaBlock>

          <p>
            where <Var>d</Var> = 7 (Stellar&apos;s standard decimal precision).
            Any account whose balance exceeds <Var>L</Var> is{" "}
            <strong>vaulted</strong>. Outbound transfers are blocked until the
            account reduces its balance below <Var>L</Var>, or until the
            ecosystem grows enough that <Var>L</Var> rises above the
            account&apos;s balance.
          </p>

          <InfoBox color="purple">
            <strong>Law of Decentralization:</strong> A 10,000× growth in pool
            reserves only yields a 100× growth in individual holding limits.
            Concentration can never keep pace with liquidity.
          </InfoBox>

          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-muted border-b border-border">
                <th className="text-left py-2 font-medium">Pool Reserves (S)</th>
                <th className="text-left py-2 font-medium">Event Horizon (L)</th>
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
                  <td className="py-2 font-mono text-purple">{s}</td>
                  <td className="py-2 font-mono text-accent">{l}</td>
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
                "Sacrifice to pool can release vault",
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
                "Pass-through only (DEX aggregators)",
                "Vaulted users CANNOT send to them",
                "Never vaulted themselves",
                "No mass reconciliation needed",
              ]}
            />
          </div>

          <p>
            Both tiers are registered by the admin on a per-address basis.
            Earlier versions of HITZ used WASM hash detection, automatically
            treating any contract whose bytecode matched an approved hash as a
            pool. This was abandoned because DEX factories allow anyone to
            deploy a contract with any WASM hash, enabling laundering via fake
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
            Incoming transfers <em>never</em> revert due to vault logic. If a
            recipient&apos;s new balance exceeds <Var>L</Var>, they are silently
            vaulted, but the transfer succeeds and returns a clean SEP-41 void.
            This is essential for DEX router compatibility: Aqua, Soroswap, and
            similar protocols depend on the output leg of a swap never throwing.
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
            only send to an approved pool, not to a router, not to any other
            address. Sending to a pool (sacrifice) reduces the sender&apos;s
            balance and increases <Var>S</Var>, potentially releasing the vault
            if the new balance falls below the updated <Var>L</Var>.
          </p>

          <SubHeading>Correction on Receive</SubHeading>
          <p>
            After every balance-changing call (transfer, transfer_from, mint,
            burn) the recipient&apos;s vault flag is re-evaluated against their
            new balance and the current <Var>L</Var>. A previously trapped
            holder whose balance now sits below <Var>L</Var> (because the
            ecosystem expanded) is released in the same transaction. Stored
            flags are never stale for longer than one state-changing call.
          </p>

          <SubHeading>Vault Release</SubHeading>
          <p>
            An account is released when its balance ≤ <Var>L</Var>. Thanks to
            lazy evaluation, release happens automatically on the user&apos;s
            next touch:
          </p>
          <ol className="list-decimal list-inside space-y-1 text-muted text-sm pl-2">
            <li>
              Sacrifice tokens to a pool (instant, on-chain, updates{" "}
              <Var>S</Var>).
            </li>
            <li>
              The ecosystem grows: <Var>S</Var> increases, <Var>L</Var> rises
              past the account&apos;s balance, and the next action
              auto-releases.
            </li>
          </ol>
          <p>
            For UIs that want to reflect physics without triggering a state
            change,{" "}
            <code className="font-mono text-xs">is_actually_vaulted(address)</code>{" "}
            evaluates the current <Var>L</Var> live, ignoring the stored flag.
          </p>
        </Section>

        {/* V. Hard Mint Cap */}
        <Section number="V" title="Hard Mint Cap">
          <p>
            HITZ compiles an absolute supply ceiling into the contract bytecode:
          </p>

          <FormulaBlock>
            MAX_SUPPLY = 100,000,000 × 10<sup>7</sup> stroops
          </FormulaBlock>

          <p>
            The mint entrypoint refuses any call that would push{" "}
            <Var>total_supply</Var> past this constant. Rejection panics before
            any state moves. No partial writes, no dangling events. Burns
            decrement <Var>total_supply</Var>, so the ceiling re-opens headroom
            as tokens exit circulation.
          </p>

          <InfoBox color="orange">
            <strong>Immutability path:</strong> The cap is a Rust{" "}
            <code className="font-mono text-xs">const</code>. Once the{" "}
            <code className="font-mono text-xs">upgrade</code> entrypoint is
            removed for mainnet, the cap becomes unalterable by any actor.
          </InfoBox>

          <p>
            Two new queries expose the state:{" "}
            <code className="font-mono text-xs">total_supply()</code> returns
            current circulating supply, and{" "}
            <code className="font-mono text-xs">max_supply()</code> returns the
            compiled ceiling.
          </p>
        </Section>

        {/* VI. Implementation */}
        <Section number="VI" title="On-Chain Implementation">
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
              ["SEP-41 Compliant", "transfer, transfer_from, approve, allowance, burn, burn_from, name, symbol, decimals, balance."],
              ["Typed Events", "InitializedEvent, AdminChangedEvent, PoolRegisteredEvent, RouterRegisteredEvent, TransferEvent, ApproveEvent, VaultedEvent, MintEvent, BurnEvent."],
            ].map(([title, desc]) => (
              <div key={title as string} className="bg-card border border-border rounded-xl p-4 space-y-1">
                <p className="text-sm font-medium text-foreground">{title}</p>
                <p className="text-xs text-muted leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* VII. TTL Restoration */}
        <Section number="VII" title="State Archival (TTL)">
          <p>
            Soroban persistent storage has a ~30-day TTL. An entry left
            untouched past that window is archived to cold storage. It becomes
            unreadable and unwritable until a{" "}
            <code className="font-mono text-xs">RestoreFootprintOp</code> pays
            to bring it back. A holder dormant for months will find their
            balance and vault state archived. HITZ handles this at the frontend
            layer using the same lazy-evaluation discipline the contract uses
            for vault flags.
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

        {/* VIII. Security */}
        <Section number="VIII" title="Security Properties">
          {[
            {
              title: "No WASM Hash Laundering",
              body: "Pool status is tied to a specific address, not a bytecode fingerprint. A malicious actor cannot deploy a fake pool to inflate S.",
            },
            {
              title: "Bounded Supply",
              body: "The 100M HITZ ceiling is a compile-time constant. Admin mint authority exists, but mints that would exceed MAX_SUPPLY panic atomically. Once the upgrade entrypoint is removed for mainnet, the cap is unalterable.",
            },
            {
              title: "No Stale Vault",
              body: "Lazy evaluation re-syncs the stored vault flag against live L on every state-changing call. An outdated flag can't block a user whose balance is already safe, nor let a now-oversized holder escape.",
            },
            {
              title: "Integrity-Bound Registrations",
              body: "Each registered pool and router stores its current WASM hash. A bytecode upgrade trips the integrity check on the next state-changing call, forcing admin re-registration before the token trusts the address again.",
            },
            {
              title: "No Burn Escape",
              body: "Vaulted accounts cannot burn their tokens. Burn is treated as an exit route and blocked.",
            },
            {
              title: "No Router Escape",
              body: "Vaulted accounts cannot route tokens through a DEX router. Only a direct sacrifice to an approved pool releases the vault.",
            },
            {
              title: "No Silent Expiry",
              body: "Vault flags and balance keys share TTL extension calls. An expired vault key would silently free a trapped whale; we prevent this by always extending both together.",
            },
            {
              title: "No Mass Underflow",
              body: "TotalMass is guarded against underflow. Pool removal subtracts the current balance; adjust_total_mass panics before going negative.",
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

        {/* IX. Contract */}
        <Section number="IX" title="Deployed Contract">
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <p className="text-xs text-muted uppercase tracking-widest font-medium">Stellar Mainnet</p>
            </div>
            <div className="divide-y divide-border">
              {[
                ["Contract ID", CONTRACT_ID],
                ["WASM Hash", "6dba0f1f8be9035fe448ac415b3b5ec2c86a0c969c271d09c0afd328249a0529"],
                ["Standard", "SEP-41 (Soroban Token Interface)"],
                ["Decimals", "7"],
                ["Max Supply", "100,000,000 HITZ"],
                ["Architecture", "V5. V4 + Pool/Router Enumeration + Initialized/AdminChanged Events + Mainnet-Hardened"],
              ].map(([k, v]) => (
                <div key={k as string} className="flex items-start gap-4 px-5 py-3">
                  <span className="text-muted text-xs w-28 shrink-0 pt-0.5">{k}</span>
                  <span className="font-mono text-xs text-foreground break-all">{v}</span>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-border">
              <a
                href={`https://stellar.expert/explorer/public/contract/${CONTRACT_ID}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent text-xs hover:text-accent-hover transition-colors"
              >
                View on Stellar Expert →
              </a>
            </div>
          </div>
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
