"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import { transfer, parseHitz, checkRelease } from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function GhostVaulting({ publicKey }: Props) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [checkAddr, setCheckAddr] = useState("");

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        When liquidity is withdrawn from a pool, TotalMass shrinks and L drops. Accounts that were
        previously safe may now exceed L and become passively vaulted on their next transfer attempt.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Withdraw from Pool (Shrink Mass)
        </h4>
        <p className="text-muted text-xs">
          Transfer tokens OUT of a pool address to reduce TotalMass and lower L.
        </p>
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="Pool address (source)"
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
          label="Withdraw from Pool"
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
          After L drops, try releasing an account to see if it got ghost-vaulted.
        </p>
        <input
          value={checkAddr}
          onChange={(e) => setCheckAddr(e.target.value)}
          placeholder="Address to check"
        />
        <TxButton
          label="Check Release"
          disabled={!publicKey || !checkAddr}
          onClick={() =>
            checkRelease(publicKey!, checkAddr, signTransaction)
          }
          variant="default"
        />
      </div>
    </div>
  );
}
