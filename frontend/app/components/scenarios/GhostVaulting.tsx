"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import { transfer, parseHitz, isAccountVaulted, isActuallyVaulted, getBalance, getSafetyLimit } from "../../lib/stellar";
import { fmtFixed } from "../../lib/format";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function GhostVaulting({ publicKey }: Props) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [checkAddr, setCheckAddr] = useState("");
  const [check, setCheck] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        When HITZ leaves the registered pools, TotalMass shrinks and L drops. Accounts that were
        previously safe may now exceed L: they are vaulted the moment they next try to send.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Send from a Pool Account (Shrink Mass)
        </h4>
        <p className="text-muted text-xs">
          Transfer HITZ out of a registered pool account you control, such as the treasury, to reduce
          TotalMass and lower L. The Sovereign Vault has no withdrawals: only swaps take HITZ out of it.
        </p>
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="Pool account (source, must be you)"
        />
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Destination address"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount to withdraw"
          type="text"
        />
        <TxButton
          label="Send from Pool"
          disabled={!publicKey || !from || !to || !amount}
          onClick={() =>
            transfer(publicKey!, from, to, parseHitz(amount), signTransaction)
          }
          variant="danger"
        />
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Check Vault Status
        </h4>
        <p className="text-muted text-xs">
          After L drops, see whether an account got ghost-vaulted. The live status compares its balance
          with the current L; the stored flag catches up on the account&apos;s next transfer.
        </p>
        <input
          value={checkAddr}
          onChange={(e) => setCheckAddr(e.target.value)}
          placeholder="Address to check"
        />
        <button
          type="button"
          className="btn ghost btn-sm"
          disabled={!checkAddr}
          onClick={async () => {
            setCheck("Reading…");
            try {
              const a = checkAddr.trim();
              const [live, flag, bal, l] = await Promise.all([
                isActuallyVaulted(a),
                isAccountVaulted(a),
                getBalance(a),
                getSafetyLimit(),
              ]);
              setCheck(
                `${live ? "Vaulted now" : "Free now"} · stored flag ${flag ? "vaulted" : "free"} · balance ${fmtFixed(bal, 2)} vs L ${fmtFixed(l, 2)}`
              );
            } catch (e) {
              setCheck(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Check status
        </button>
        {check && <p className="text-xs mono text-muted">{check}</p>}
      </div>
    </div>
  );
}
