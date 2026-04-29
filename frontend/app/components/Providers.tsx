"use client";

import { type ReactNode } from "react";
import { WalletProvider } from "../contexts/WalletContext";
import { ProtocolProvider } from "../contexts/ProtocolContext";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <ProtocolProvider>{children}</ProtocolProvider>
    </WalletProvider>
  );
}
