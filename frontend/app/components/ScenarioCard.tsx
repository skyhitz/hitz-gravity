"use client";

import { useState, ReactNode } from "react";

interface Props {
  number: number;
  title: string;
  subtitle: string;
  icon: string;
  color: string;        // e.g. "text-green" for the accent strip
  accentBg: string;    // e.g. "bg-green/10" for icon bg
  children: ReactNode;
}

export default function ScenarioCard({
  number,
  title,
  subtitle,
  icon,
  color,
  accentBg,
  children,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`rounded-2xl border overflow-hidden transition-colors duration-150 ${
        open ? "border-border" : "border-border hover:border-muted"
      }`}
    >
      {/* Header row */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left cursor-pointer"
      >
        {/* Icon */}
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0 ${accentBg} ${color}`}
        >
          {icon}
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs font-mono">
              {String(number).padStart(2, "0")}
            </span>
            <span className="font-medium text-foreground text-sm">{title}</span>
          </div>
          <p className="text-muted text-xs mt-0.5 truncate">{subtitle}</p>
        </div>

        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-muted shrink-0 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Smooth accordion — CSS grid-rows transition, zero layout jump */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4 pt-3 border-t border-border">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
