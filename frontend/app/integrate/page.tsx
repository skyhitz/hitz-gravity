/**
 * /integrate: how bots, apps and AI agents trade HITZ through the Sovereign
 * Vault without writing contract code: the MCP server, the HTTP API
 * (functions/api/v1.ts, functions/api/mcp.ts) and the contract itself.
 *
 * House style: no em-dashes. Use commas or periods.
 */
import type { Metadata } from "next";
import Link from "next/link";
import CopyBlock from "../components/integrate/CopyBlock";
import LiveVault from "../components/integrate/LiveVault";
import { CONTRACT_ID } from "../lib/stellar";
import { USDC_SAC, XLM_SAC } from "../lib/tokens";
import { VAULT_ID } from "../lib/vault";

export const metadata: Metadata = {
  title: "Integrate HITZ. Sovereign Vault API and MCP server",
  description:
    "Trade HITZ on Stellar from a bot, an app or an AI agent: a keyless HTTP API and an MCP server that build ready-to-sign transactions for the Sovereign Vault.",
};

const SITE = "https://skyhitz.io";
const API = `${SITE}/api/v1`;
const MCP = `${SITE}/mcp`;
const GUIDE = "https://docs.skyhitz.io/vault/integration";

const TOOLS: [string, string][] = [
  ["get_vault", "Pools, prices, fees, USD values and the Event Horizon."],
  ["get_account", "An account's balances, trustlines, and how much HITZ it can buy before being vaulted."],
  ["quote", "Exact quote from the contract's math. Sell an amount, or ask for an amount out."],
  ["build_swap", "An unsigned transaction for the user's account, with a link to sign it in their wallet."],
  ["submit_transaction", "Submits the signed transaction and returns what was bought."],
  ["get_transaction", "Status of a transaction, with the swap decoded."],
];

const ENDPOINTS: [string, string][] = [
  ["GET /vault", "Pools, prices, fees, the Event Horizon"],
  ["GET /quote?sell=XLM&buy=HITZ&amount=100", "Exact quote; buy_amount= instead finds the input, account= adds checks"],
  ["POST /swap", "{account, sell, buy, amount, slippage_bps?} → unsigned transaction"],
  ["POST /submit", "{xdr} → submits a signed vault transaction, waits for the result"],
  ["GET /tx?hash=…", "Transaction status, swap decoded"],
  ["GET /account?address=G…", "Balances, trustlines, room under the Event Horizon"],
];

const ADDRESSES: [string, string][] = [
  ["Sovereign Vault", VAULT_ID],
  ["HITZ", CONTRACT_ID],
  ["XLM (asset contract)", XLM_SAC],
  ["USDC (Circle, asset contract)", USDC_SAC],
];

const CURL_QUOTE = `curl "${API}/quote?sell=XLM&buy=HITZ&amount=100"`;

const CURL_SWAP = `curl -X POST ${API}/swap \\
  -H "content-type: application/json" \\
  -d '{"account":"G…YOUR_ACCOUNT","sell":"XLM","buy":"HITZ","amount":"100","slippage_bps":100}'`;

const JS_FLOW = `import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";

const post = (path, body) =>
  fetch("${API}" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// 1. Build: the API quotes, simulates and assembles the transaction.
const built = await post("/swap", {
  account: keypair.publicKey(),
  sell: "XLM",
  buy: "HITZ",
  amount: "100",
});
if (built.error) throw new Error(built.error);
console.log(built.buy.expected, built.warnings);

// 2. Sign it yourself. The API never sees a key.
const tx = TransactionBuilder.fromXDR(built.xdr, Networks.PUBLIC);
tx.sign(keypair);

// 3. Submit and wait for the result.
const result = await post("/submit", { xdr: tx.toXDR() });
console.log(result.status, result.call?.bought, result.explorer);`;

const CLAUDE_CODE = `claude mcp add --transport http hitz-vault ${MCP}`;

const MCP_JSON = `{
  "mcpServers": {
    "hitz-vault": { "url": "${MCP}" }
  }
}`;

export default function IntegratePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-6 h-12 flex items-center justify-between">
          <Link href="/" className="text-muted text-sm hover:text-foreground transition-colors flex items-center gap-2">
            ← Home
          </Link>
          <div className="flex items-center gap-4 text-xs text-muted">
            <a href="#mcp" className="hover:text-foreground transition-colors">MCP</a>
            <a href="#api" className="hover:text-foreground transition-colors">API</a>
            <a href="#contract" className="hover:text-foreground transition-colors">Contract</a>
          </div>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-14 space-y-16">
        <header className="space-y-5">
          <p className="text-accent text-sm font-medium tracking-widest uppercase">Integrate</p>
          <h1 className="text-4xl font-bold tracking-tight leading-tight">Trade HITZ from code</h1>
          <p className="text-muted text-base leading-relaxed max-w-xl">
            HITZ trades on its own exchange on Stellar, the Sovereign Vault. Your bot, app or AI agent can quote it, get a
            transaction ready to sign, and submit it, without an API key, an SDK or contract code. You always sign with your
            own wallet.
          </p>
          <LiveVault />
        </header>

        <Section id="mcp" eyebrow="For AI agents" title="The MCP server">
          <p>
            Add the vault to any MCP client as a remote server. No key, no install. Ask your agent things like
            &ldquo;how much HITZ do I get for 50 XLM?&rdquo; or &ldquo;build a swap of 20 USDC into HITZ for my
            account&rdquo;.
          </p>
          <CopyBlock code={MCP} label="Server URL (Streamable HTTP)" />
          <div className="space-y-3">
            <p>
              <strong className="text-foreground font-medium">Claude</strong>: Settings, Connectors, Add custom connector, then
              paste the URL.
            </p>
            <CopyBlock code={CLAUDE_CODE} label="Claude Code" />
            <CopyBlock code={MCP_JSON} label="Cursor and similar clients (mcp.json)" />
          </div>
          <dl className="grid gap-2">
            {TOOLS.map(([name, what]) => (
              <div key={name} className="flex flex-col sm:flex-row sm:gap-4 border-b border-border-soft pb-2">
                <dt className="font-mono text-[13px] text-accent sm:w-44 shrink-0">{name}</dt>
                <dd className="text-sm">{what}</dd>
              </div>
            ))}
          </dl>
          <Note>
            The agent never holds your key. <span className="font-mono">build_swap</span> returns the transaction and a link to{" "}
            <span className="font-mono">skyhitz.io/sign</span>, where you check what it does and sign it with your own wallet.
          </Note>
        </Section>

        <Section id="api" eyebrow="For bots and apps" title="The HTTP API">
          <p>
            JSON over HTTPS at <span className="font-mono text-foreground">{API}</span>, open to any origin. Amounts are decimal
            strings in token units (7 decimals), with the raw integer alongside. The full description is in{" "}
            <a className="text-accent hover:underline" href={`${API}/openapi.json`}>
              openapi.json
            </a>
            .
          </p>
          <div className="grid gap-2">
            {ENDPOINTS.map(([route, what]) => (
              <div key={route} className="flex flex-col sm:flex-row sm:gap-4 border-b border-border-soft pb-2">
                <span className="font-mono text-[12px] text-foreground sm:w-72 shrink-0 break-all">{route}</span>
                <span className="text-sm">{what}</span>
              </div>
            ))}
          </div>
          <CopyBlock code={CURL_QUOTE} label="Quote" />
          <CopyBlock code={CURL_SWAP} label="Build a swap" />
          <CopyBlock code={JS_FLOW} label="Build, sign and submit (JavaScript)" />
          <p>
            Errors come back as <span className="font-mono text-foreground">{"{error, code}"}</span> with a matching HTTP
            status: <Code>insufficient_balance</Code>, <Code>no_trustline</Code>, <Code>slippage</Code>,{" "}
            <Code>trade_too_small</Code>, <Code>account_not_found</Code>. A <Code>409 restore_required</Code>{" "}
            means the account&apos;s contract data was archived after a long idle time: sign and submit the{" "}
            <Code>restore_xdr</Code> it carries, then build again.
          </p>
        </Section>

        <Section id="rules" eyebrow="Before you trade" title="What to know">
          <ul className="space-y-3 list-none pl-0">
            <Rule title="The fee">
              1% per hop while the vault is calm. A trade that moves one pool&apos;s price away from the other pays more, up to
              10%, and the fee eases back over the next couple of hours. XLM to USDC is two hops through HITZ. Quotes show each
              hop&apos;s fee.
            </Rule>
            <Rule title="The Event Horizon">
              An account holding more HITZ than the Event Horizon (shown above) is vaulted: it can still receive HITZ and sell
              it back into the vault, but can&apos;t send it anywhere else. Quotes and builds warn before a trade does that.
            </Rule>
            <Rule title="Trustlines">
              To receive USDC an account needs a USDC trustline. HITZ needs none.
            </Rule>
            <Rule title="Arbitrage">
              The vault has no oracle: when XLM moves against USDC elsewhere, the vault&apos;s rate between them lags, and
              closing that gap is the trade. The price gap above is that difference now. The{" "}
              <a className="text-accent hover:underline" href={`${GUIDE}#arbitrage`}>
                arbitrage section
              </a>{" "}
              of the contract guide shows how to size it. Skyhitz runs this trade itself with a{" "}
              <a className="text-accent hover:underline" href="https://docs.skyhitz.io/vault/arbitrage-bot">
                public bot
              </a>{" "}
              (its trades: <a className="text-accent hover:underline" href={`${API}/bot`}>/api/v1/bot</a>), and you can run
              the same code with your own account.
            </Rule>
          </ul>
        </Section>

        <Section id="contract" eyebrow="Without the API" title="Directly on the contract">
          <p>
            One call does a trade: <span className="font-mono text-foreground">swap(from, to, token_in, token_out, amount_in, min_out)</span>.
            Quote it with <span className="font-mono text-foreground">quote</span>, read the pools with{" "}
            <span className="font-mono text-foreground">pools</span>. The{" "}
            <a className="text-accent hover:underline" href={GUIDE}>
              integration guide
            </a>{" "}
            covers the fee math, events, calling from another contract, and arbitrage sizing.
          </p>
          <div className="grid gap-2">
            {ADDRESSES.map(([name, address]) => (
              <div key={name} className="flex flex-col sm:flex-row sm:gap-4 border-b border-border-soft pb-2">
                <span className="text-sm sm:w-56 shrink-0">{name}</span>
                <a
                  className="font-mono text-[12px] text-foreground break-all hover:text-accent"
                  href={`https://stellar.expert/explorer/public/contract/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {address}
                </a>
              </div>
            ))}
          </div>
        </Section>

        <Section id="more" eyebrow="Machine-readable" title="Everything else">
          <ul className="space-y-2 list-none pl-0 text-sm">
            <li>
              <a className="text-accent hover:underline" href="/llms.txt">llms.txt</a>: the project in one page, for language models.
            </li>
            <li>
              <a className="text-accent hover:underline" href={`${API}/openapi.json`}>openapi.json</a>: the API, for tools and
              agent frameworks.
            </li>
            <li>
              <a className="text-accent hover:underline" href="/.well-known/stellar.toml">stellar.toml</a>: the token&apos;s
              Stellar metadata.
            </li>
            <li>
              <a className="text-accent hover:underline" href="https://docs.skyhitz.io">docs.skyhitz.io</a>: whitepaper, security
              review, contract guide.
            </li>
            <li>
              <a className="text-accent hover:underline" href="https://github.com/skyhitz/hitz-gravity">GitHub</a>: the contracts,
              this site, the API and the MCP server.
            </li>
          </ul>
          <p className="text-xs text-muted-soft">
            Trading is at your own risk. Read the{" "}
            <a className="hover:underline" href="https://docs.skyhitz.io/legal">
              legal disclosure
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-5 scroll-mt-16">
      <div className="space-y-1">
        <p className="text-muted text-xs uppercase tracking-[0.18em]">{eyebrow}</p>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="space-y-4 text-muted leading-relaxed text-[15px]">{children}</div>
    </section>
  );
}

function Rule({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="bg-card border border-border rounded-xl px-4 py-3">
      <p className="text-foreground text-sm font-medium mb-1">{title}</p>
      <p className="text-sm">{children}</p>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="border border-accent/30 bg-accent/5 text-accent rounded-xl px-4 py-3 text-sm leading-relaxed">{children}</div>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[13px] text-foreground">{children}</span>;
}
