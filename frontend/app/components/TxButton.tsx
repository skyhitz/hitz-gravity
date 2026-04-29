"use client";

import { useState, ReactNode } from "react";
import { TxResult } from "../lib/stellar";

interface Props {
  label: string;
  onClick: () => Promise<TxResult>;
  disabled?: boolean;
  variant?: "primary" | "danger" | "default";
  children?: ReactNode;
}

export default function TxButton({
  label,
  onClick,
  disabled,
  variant = "primary",
}: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TxResult | null>(null);

  const variantClasses = {
    primary: "bg-accent hover:bg-accent-hover text-white",
    danger: "bg-red/20 hover:bg-red/30 text-red border border-red/30",
    default: "bg-card hover:bg-card-hover text-foreground border border-border",
  };

  const handleClick = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await onClick();
      setResult(res);
    } catch (e: unknown) {
      setResult({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={handleClick}
        disabled={disabled || loading}
        className={`${variantClasses[variant]} rounded-xl px-5 py-2.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-full`}
      >
        {loading ? "Submitting..." : label}
      </button>
      {result && (
        <div
          className={`text-sm rounded-lg px-3 py-2 font-mono ${
            result.success
              ? "bg-green/10 text-green"
              : "bg-red/10 text-red"
          }`}
        >
          {result.success ? (
            <>
              Success{" "}
              {result.hash && (
                <a
                  href={`https://stellar.expert/explorer/public/tx/${result.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  View tx
                </a>
              )}
            </>
          ) : (
            <span className="break-all">{result.error}</span>
          )}
        </div>
      )}
    </div>
  );
}
