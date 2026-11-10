"use client";

/** A code block with a copy button, for commands and URLs people paste elsewhere. */

import { useState } from "react";

export default function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions, insecure context): the text stays selectable.
    }
  };
  return (
    <div className="relative group">
      {label && <p className="text-[11px] uppercase tracking-wider text-muted-soft mb-1.5">{label}</p>}
      <pre className="bg-card border border-border rounded-xl pl-4 pr-16 py-3 text-xs font-mono text-foreground overflow-x-auto leading-relaxed whitespace-pre">
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 bottom-2 text-[11px] px-2 py-1 rounded-md border border-border bg-background text-muted hover:text-foreground transition-colors"
        aria-label="Copy to clipboard"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
