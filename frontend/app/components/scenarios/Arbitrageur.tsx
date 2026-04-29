"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import {
  transfer,
  approve,
  transferFrom,
  parseHitz,
} from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function Arbitrageur({ publicKey }: Props) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  const [approveFrom, setApproveFrom] = useState("");
  const [approveSpender, setApproveSpender] = useState("");
  const [approveAmount, setApproveAmount] = useState("");
  const [approveExpiry, setApproveExpiry] = useState("");

  const [tfSpender, setTfSpender] = useState("");
  const [tfFrom, setTfFrom] = useState("");
  const [tfTo, setTfTo] = useState("");
  const [tfAmount, setTfAmount] = useState("");

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        Cross-DEX balancing: transfer between pools. Pool-to-pool transfers have neutral mass impact. Test allowances and delegated transfers here.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">Direct Transfer</h4>
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="From address"
        />
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="To address"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          type="text"
        />
        <TxButton
          label="Transfer"
          disabled={!publicKey || !from || !to || !amount}
          onClick={() =>
            transfer(publicKey!, from, to, parseHitz(amount), signTransaction)
          }
        />
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">Approve Allowance</h4>
        <input
          value={approveFrom}
          onChange={(e) => setApproveFrom(e.target.value)}
          placeholder="Owner address"
        />
        <input
          value={approveSpender}
          onChange={(e) => setApproveSpender(e.target.value)}
          placeholder="Spender address"
        />
        <input
          value={approveAmount}
          onChange={(e) => setApproveAmount(e.target.value)}
          placeholder="Amount"
          type="text"
        />
        <input
          value={approveExpiry}
          onChange={(e) => setApproveExpiry(e.target.value)}
          placeholder="Expiration ledger (e.g. 9999999)"
          type="text"
        />
        <TxButton
          label="Approve"
          disabled={
            !publicKey ||
            !approveFrom ||
            !approveSpender ||
            !approveAmount ||
            !approveExpiry
          }
          onClick={() =>
            approve(
              publicKey!,
              approveFrom,
              approveSpender,
              parseHitz(approveAmount),
              Number(approveExpiry),
              signTransaction
            )
          }
          variant="default"
        />
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Delegated Transfer (transfer_from)
        </h4>
        <input
          value={tfSpender}
          onChange={(e) => setTfSpender(e.target.value)}
          placeholder="Spender address"
        />
        <input
          value={tfFrom}
          onChange={(e) => setTfFrom(e.target.value)}
          placeholder="From (owner) address"
        />
        <input
          value={tfTo}
          onChange={(e) => setTfTo(e.target.value)}
          placeholder="To address"
        />
        <input
          value={tfAmount}
          onChange={(e) => setTfAmount(e.target.value)}
          placeholder="Amount"
          type="text"
        />
        <TxButton
          label="Transfer From"
          disabled={!publicKey || !tfSpender || !tfFrom || !tfTo || !tfAmount}
          onClick={() =>
            transferFrom(
              publicKey!,
              tfSpender,
              tfFrom,
              tfTo,
              parseHitz(tfAmount),
              signTransaction
            )
          }
        />
      </div>
    </div>
  );
}
