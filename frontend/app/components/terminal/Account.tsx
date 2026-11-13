"use client";
/**
 * The HITZ Terminal's account side: sign in, pick a plan and pay in USDC or XLM (one vault swap that
 * buys HITZ for the treasury), manage API keys and alert webhooks. Every rule lives on the server
 * (functions/_lib/terminal/); this only asks and shows the answer.
 *
 * House style: no em-dashes.
 */
import { useState } from "react";
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "../../contexts/WalletContext";
import { NETWORK_PASSPHRASE } from "../../lib/stellar";
import * as api from "../../lib/terminal";
import type { Me, PlanId, PublicPlan } from "../../lib/terminal";
import { stamp } from "./format";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── Sign in ──────────────────────────────────────────────────────────────────

/** Wallet users sign a challenge once (30 days); email users are signed in already. */
export function useTerminalSignIn(onDone: () => void) {
  const { publicKey, connectionType, sign } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = async () => {
    if (!publicKey || connectionType !== "wallet") return;
    setBusy(true);
    setError(null);
    try {
      const ch = await api.challenge(publicKey);
      const signed = await sign(ch.xdr, ch.network_passphrase);
      await api.verify(publicKey, signed);
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { signIn, busy, error };
}

// ─── Pricing and checkout ─────────────────────────────────────────────────────

type Step = { kind: "idle" } | { kind: "working"; text: string } | { kind: "paid"; text: string } | { kind: "error"; text: string };

function PlanCard({ plan, me, yearly, onPaid }: { plan: PublicPlan; me: Me | null; yearly: boolean; onPaid: () => void }) {
  const { connectionType, sign, callContract } = useWallet();
  const [asset, setAsset] = useState<"USDC" | "XLM">("USDC");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const current = me?.plan === plan.id;
  const price = yearly ? plan.usd_per_year : plan.usd_per_30_days;
  const signedIn = !!me?.account && me.via !== "key" && me.via !== "none";

  const pay = async () => {
    try {
      setStep({ kind: "working", text: "Building your payment" });
      const c = await api.startCheckout(plan.id, yearly ? 12 : 1, asset);
      let proof: { xdr?: string; tx_hash?: string };
      if (connectionType === "email") {
        setStep({ kind: "working", text: `Paying ${c.pay.amount} ${c.pay.asset}` });
        const args = c.gateway_call.argsXdr.map((a) => StellarSdk.xdr.ScVal.fromXDR(a, "base64"));
        const res = await callContract(c.gateway_call.contractId, c.gateway_call.method, args);
        if (!res.success || !res.hash) throw new Error(res.error ?? "The payment did not go through.");
        proof = { tx_hash: res.hash };
      } else {
        setStep({ kind: "working", text: `Sign to pay ${c.pay.amount} ${c.pay.asset}` });
        proof = { xdr: await sign(c.xdr, NETWORK_PASSPHRASE) };
      }
      setStep({ kind: "working", text: "Confirming on Stellar" });
      for (let i = 0; i < 20; i++) {
        const r = await api.confirmCheckout(c.checkout_id, i === 0 ? proof : { tx_hash: proof.tx_hash });
        if (r.status === "paid") {
          setStep({ kind: "paid", text: `Paid. ${api.PLAN_LABEL[r.subscription.plan]} until ${stamp(r.subscription.until)}.` });
          onPaid();
          return;
        }
        if (r.status === "expired") throw new Error(r.message ?? "The checkout expired.");
        await new Promise((ok) => setTimeout(ok, 3000));
      }
      setStep({ kind: "error", text: "Still waiting for the network. It will show up here once it lands." });
    } catch (e) {
      setStep({ kind: "error", text: errText(e) });
    }
  };

  return (
    <div className={`bg-card border rounded-lg p-4 flex flex-col gap-3 ${current ? "border-accent" : "border-border"}`}>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{plan.name}</h3>
          {current ? <span className="text-[10px] font-mono text-accent">CURRENT</span> : null}
        </div>
        <p className="text-xs text-muted">{plan.tagline}</p>
      </div>
      <p className="font-mono text-2xl">
        {`$${price.toLocaleString("en-US")}`}
        {plan.usd_per_30_days === 0 ? null : <span className="text-xs text-muted"> / {yearly ? "year" : "30 days"}</span>}
      </p>
      <ul className="text-[13px] text-muted space-y-1 flex-1">
        {plan.features.map((f) => (
          <li key={f}>· {f}</li>
        ))}
      </ul>
      {plan.id === "free" ? (
        <p className="text-xs text-muted">No sign-in needed.</p>
      ) : !signedIn ? (
        <p className="text-xs text-muted">Connect a wallet or sign in with email to subscribe.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-1 text-xs">
            {(["USDC", "XLM"] as const).map((a) => (
              <button key={a} onClick={() => setAsset(a)} className={`flex-1 rounded border px-2 py-1 ${asset === a ? "border-accent text-foreground" : "border-border text-muted"}`}>
                {a}
              </button>
            ))}
          </div>
          <button disabled={step.kind === "working"} onClick={pay} className="w-full rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-sm py-2">
            {step.kind === "working" ? step.text : `Pay $${price.toLocaleString("en-US")} in ${asset}`}
          </button>
          {step.kind === "paid" ? <p className="text-xs text-green">{step.text}</p> : null}
          {step.kind === "error" ? <p className="text-xs text-red">{step.text}</p> : null}
        </div>
      )}
    </div>
  );
}

/** `plans` is null while loading and empty when the API couldn't be reached. */
export function Pricing({ plans, me, onPaid }: { plans: PublicPlan[] | null; me: Me | null; onPaid: () => void }) {
  const [yearly, setYearly] = useState(false);
  return (
    <section id="pricing" className="space-y-4 scroll-mt-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-muted text-xs uppercase tracking-[0.18em]">Plans</p>
          <h2 className="text-2xl font-semibold tracking-tight">Pay in USDC or XLM</h2>
          <p className="text-sm text-muted max-w-2xl mt-1">
            One transaction swaps your payment for HITZ in the Sovereign Vault and sends it to the treasury. You never hold HITZ. Upgrading
            turns the days left into extra days on the new plan.
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setYearly(false)} className={`rounded border px-3 py-1 ${!yearly ? "border-accent" : "border-border text-muted"}`}>
            Monthly
          </button>
          <button onClick={() => setYearly(true)} className={`rounded border px-3 py-1 ${yearly ? "border-accent" : "border-border text-muted"}`}>
            Yearly, 2 months free
          </button>
        </div>
      </div>
      {plans && plans.length === 0 ? (
        <p className="bg-card border border-border rounded-lg px-4 py-6 text-sm text-muted text-center">
          Plans can&apos;t be loaded right now. Refresh in a minute to see them.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(plans ?? []).map((p) => (
            <PlanCard key={p.id} plan={p} me={me} yearly={yearly} onPaid={onPaid} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Keys and webhooks ────────────────────────────────────────────────────────

export function KeysAndHooks({ me, onChange }: { me: Me; onChange: () => void }) {
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState("discord");
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await f();
      if (ok) setMsg(ok);
      onChange();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const keys = (me.keys ?? []).filter((k) => !k.revoked);
  const hooks = me.webhooks ?? [];
  return (
    <section id="account" className="grid gap-3 lg:grid-cols-2 scroll-mt-16">
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase">API keys</h3>
        {me.limits?.api_keys ? (
          <>
            <p className="text-xs text-muted">
              {keys.length} of {me.limits.api_keys} keys. Send one as <span className="font-mono">Authorization: Bearer htz_…</span>. A key reads data; it cannot pay or make keys.
            </p>
            {fresh ? (
              <div className="rounded border border-orange/40 bg-orange/10 p-2 space-y-1">
                <p className="text-xs text-orange">Copy it now: it is shown once.</p>
                <code className="block font-mono text-[11px] break-all">{fresh}</code>
              </div>
            ) : null}
            <ul className="text-[12px] font-mono divide-y divide-border-soft">
              {keys.map((k) => (
                <li key={k.prefix} className="flex justify-between gap-2 py-1">
                  <span>
                    {k.prefix}… <span className="text-muted">{k.label ?? ""}</span>
                  </span>
                  <span className="text-muted">{k.last_used_at ? `used ${stamp(k.last_used_at)}` : "unused"}</span>
                  <button onClick={() => act(() => api.revokeKey(k.prefix), "Revoked.")} className="text-red hover:underline">
                    revoke
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <input className="inp flex-1 min-w-0 text-sm" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button
                onClick={() =>
                  act(async () => {
                    const k = await api.createKey(label);
                    setFresh(k.key);
                    setLabel("");
                  })
                }
                className="rounded bg-accent hover:bg-accent-hover text-white text-sm px-3"
              >
                New key
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">API keys come with the Pro and Institutional plans.</p>
        )}
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase">Alert webhooks</h3>
        {me.limits?.webhooks ? (
          <>
            <p className="text-xs text-muted">
              {hooks.length} of {me.limits.webhooks}. Paste a Discord or Slack webhook URL, or your own https endpoint (signed with the secret shown).
            </p>
            <ul className="text-[12px] divide-y divide-border-soft">
              {hooks.map((h) => (
                <li key={h.id} className="py-1.5 space-y-1">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono truncate">{h.url}</span>
                    <span className={h.disabled ? "text-red" : "text-muted"}>{h.disabled ? "off" : h.format}</span>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <button onClick={() => act(() => api.testWebhook(h.id), "Test sent.")} className="text-accent hover:underline">
                      send test
                    </button>
                    <button onClick={() => navigator.clipboard.writeText(h.secret)} className="text-muted hover:underline">
                      copy secret
                    </button>
                    <button onClick={() => act(() => api.deleteWebhook(h.id), "Deleted.")} className="text-red hover:underline">
                      delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <input className="inp flex-1 min-w-0 text-sm" placeholder="https://discord.com/api/webhooks/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <select className="inp !w-auto shrink-0 text-sm" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
                <option value="json">JSON</option>
              </select>
              <button onClick={() => act(async () => (await api.createWebhook(url, format), setUrl("")), "Added.")} className="rounded bg-accent hover:bg-accent-hover text-white text-sm px-3">
                Add
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">Alert webhooks come with every paid plan.</p>
        )}
      </div>
      {msg ? <p className="text-xs text-muted lg:col-span-2">{msg}</p> : null}
      {me.checkouts?.length ? (
        <div className="bg-card border border-border rounded-lg p-4 lg:col-span-2">
          <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">Payments</h3>
          <ul className="text-[12px] font-mono divide-y divide-border-soft">
            {me.checkouts.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 py-1">
                <span>{stamp(c.created_at)}</span>
                <span>
                  {api.PLAN_LABEL[c.plan as PlanId]} × {c.periods}
                </span>
                <span>
                  {c.amount} {c.asset}
                </span>
                <span className={c.status === "paid" ? "text-green" : c.status === "expired" ? "text-muted" : "text-orange"}>{c.status}</span>
                {c.tx_hash ? (
                  <a className="text-accent hover:underline" href={`https://stellar.expert/explorer/public/tx/${c.tx_hash}`} target="_blank" rel="noreferrer">
                    tx
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
