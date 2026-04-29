"use client";

import { useState } from "react";
import TxButton from "../TxButton";
import { transfer, checkRelease, parseHitz } from "../../lib/stellar";
import { signTransaction } from "../../lib/wallet";

interface Props {
  publicKey: string | null;
}

export default function SacrificeGrid({ publicKey }: Props) {
  const [pool, setPool] = useState("");
  const [amount, setAmount] = useState("");
  const [releaseTarget, setReleaseTarget] = useState("");

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        A vaulted whale sacrifices tokens to an audited pool. This grows TotalMass, raises L, and may release the whale if their balance drops below L.
      </p>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Transfer to Pool (Sacrifice)
        </h4>
        <input
          value={pool}
          onChange={(e) => setPool(e.target.value)}
          placeholder="Audited pool address (C...)"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount to sacrifice"
          type="text"
        />
        <TxButton
          label="Sacrifice to Pool"
          disabled={!publicKey || !pool || !amount}
          onClick={() =>
            transfer(
              publicKey!,
              publicKey!,
              pool,
              parseHitz(amount),
              signTransaction
            )
          }
          variant="primary"
        />
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          Check Release
        </h4>
        <p className="text-muted text-xs">
          After sacrificing, check if the account can be released from the vault.
        </p>
        <input
          value={releaseTarget}
          onChange={(e) => setReleaseTarget(e.target.value)}
          placeholder="Address to release"
        />
        <TxButton
          label="Check Release"
          disabled={!publicKey || !releaseTarget}
          onClick={() =>
            checkRelease(publicKey!, releaseTarget, signTransaction)
          }
          variant="default"
        />
      </div>
    </div>
  );
}
