/**
 * /sign: where a transaction built by the HITZ API or MCP server gets signed
 * with the user's own wallet. The checks live in components/SignTransaction.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SignTransaction from "../components/SignTransaction";

export const metadata: Metadata = {
  title: "Sign a HITZ vault transaction",
  description: "Review a HITZ Sovereign Vault swap built by the API or an AI agent, and sign it with your own wallet.",
  robots: { index: false },
};

export default function SignPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-xl mx-auto px-6 h-12 flex items-center justify-between">
          <Link href="/" className="text-muted text-sm hover:text-foreground transition-colors">
            ← Mainnet
          </Link>
          <Link href="/integrate/" className="text-xs text-muted hover:text-foreground transition-colors">
            Integrate
          </Link>
        </div>
      </nav>
      <main className="max-w-xl mx-auto px-6 py-12">
        <SignTransaction />
      </main>
    </div>
  );
}
