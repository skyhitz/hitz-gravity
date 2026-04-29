"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import { transfer, mint, parseHitz } from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function FreeCitizen({ publicKey }: Props) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [mintTo, setMintTo] = useState("");
  const [mintAmount, setMintAmount] = useState("");

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        Transfer or receive HITZ while staying below the Event Horizon (L). Your tokens remain fully mobile, no vault, no restrictions.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">Transfer HITZ</h4>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Recipient address"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (e.g. 100.5)"
          type="text"
        />
        <TxButton
          label="Transfer"
          disabled={!publicKey || !to || !amount}
          onClick={() =>
            transfer(publicKey!, publicKey!, to, parseHitz(amount), signTransaction)
          }
        />
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">Mint HITZ (Admin)</h4>
        <input
          value={mintTo}
          onChange={(e) => setMintTo(e.target.value)}
          placeholder="Recipient address"
        />
        <input
          value={mintAmount}
          onChange={(e) => setMintAmount(e.target.value)}
          placeholder="Amount (e.g. 1000)"
          type="text"
        />
        <TxButton
          label="Mint"
          disabled={!publicKey || !mintTo || !mintAmount}
          onClick={() =>
            mint(publicKey!, mintTo, parseHitz(mintAmount), signTransaction)
          }
        />
      </div>
    </div>
  );
}
