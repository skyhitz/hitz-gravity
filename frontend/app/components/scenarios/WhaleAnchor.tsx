"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import { mint, parseHitz } from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function WhaleAnchor({ publicKey }: Props) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        Accumulate HITZ beyond the Event Horizon (L). The account is automatically Vaulted by the contract. Outbound transfers are blocked until a Sacrifice is made.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Mint large amount (Admin)
        </h4>
        <p className="text-muted text-xs">
          Mint enough to exceed L and trigger vaulting. Use the Inspector above to verify vault status after.
        </p>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Target address"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Large amount (e.g. 50000)"
          type="text"
        />
        <TxButton
          label="Mint (Trigger Vault)"
          disabled={!publicKey || !to || !amount}
          onClick={() =>
            mint(publicKey!, to, parseHitz(amount), signTransaction)
          }
          variant="danger"
        />
      </div>
    </div>
  );
}
