"use client";

/**
 * MonitorPanel — everything on the Monitor tab: the holder ecosystem, price,
 * liquidity, traction, the protocol's numbers and the registry.
 *
 * Its own file so the home page can load it when the tab is first opened
 * (components/HomeApp.tsx). None of it is needed to trade, and it carries the
 * charts and the 3D scene's data code.
 */

import HolderEcosystem from "./ecosystem/HolderEcosystem";
import HitzPriceCard from "./HitzPriceCard";
import LiquidityCard from "./LiquidityCard";
import TractionCard from "./TractionCard";
import MonitorStatCards from "./MonitorStatCards";
import AccountPulse from "./AccountPulse";
import RegistryCardPair from "./Registry";
import AccountInspector from "./AccountInspector";

export default function MonitorPanel() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: 16,
      }}
    >
      <HolderEcosystem />
      <HitzPriceCard />
      <LiquidityCard />
      <TractionCard />
      <MonitorStatCards />
      <AccountPulse />
      <RegistryCardPair />
      <div className="side-card">
        <h4>Inspect Account</h4>
        <AccountInspector />
      </div>
    </div>
  );
}
