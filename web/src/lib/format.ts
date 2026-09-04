/**
 * Presentation helpers: currency, dates, and the color-coding that visibly
 * distinguishes RECOVER from RESTRICT / SUSPEND across the UI.
 */

import type { AccessState, DecisionOutcome, RiskBand } from "../api/types";

/** Amounts are stored in the smallest currency unit (paise). */
export function formatMoney(amount: number | undefined, currency = "INR"): string {
  if (amount === undefined || amount === null) return "—";
  const major = amount / 100;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(0)}`;
  }
}

export function formatPercent(rate: number | undefined): string {
  if (rate === undefined || rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateShort(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Human labels for machine enum values. */
export function titleize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A decision outcome is either recovery-oriented (RECOVER / INTERVENE) or
 * restriction-oriented (RESTRICT / SUSPEND). This drives the green vs red
 * color-coding that makes the demo's core distinction obvious.
 */
export function outcomeTone(
  outcome: DecisionOutcome | null | undefined,
): "recover" | "intervene" | "restrict" | "suspend" | "neutral" {
  switch (outcome) {
    case "RECOVER":
      return "recover";
    case "INTERVENE":
      return "intervene";
    case "RESTRICT":
      return "restrict";
    case "SUSPEND":
      return "suspend";
    default:
      return "neutral";
  }
}

export function accessTone(
  state: AccessState | null | undefined,
): "recover" | "intervene" | "restrict" | "suspend" | "neutral" {
  switch (state) {
    case "ACTIVE":
      return "recover";
    case "RECOVERY":
    case "GRACE":
      return "intervene";
    case "RESTRICTED":
      return "restrict";
    case "SUSPENDED":
    case "BLACKLIST_RECOMMENDED":
      return "suspend";
    default:
      return "neutral";
  }
}

export function bandTone(
  band: RiskBand | null | undefined,
): "recover" | "intervene" | "suspend" | "neutral" {
  switch (band) {
    case "low":
      return "recover";
    case "medium":
      return "intervene";
    case "high":
      return "suspend";
    default:
      return "neutral";
  }
}
