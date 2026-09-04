import type { ReactNode } from "react";

type Tone = "recover" | "intervene" | "restrict" | "suspend" | "neutral";

/** A small color-coded pill used for outcomes, access states and risk bands. */
export function Badge({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
