import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | string | null | undefined, symbol = "₹"): string {
  const num = Number(amount ?? 0);
  if (Number.isNaN(num)) return `${symbol}0.00`;
  return `${symbol}${num.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatQty(qty: number | string | null | undefined): string {
  const num = Number(qty ?? 0);
  if (Number.isNaN(num)) return "0";
  return Number.isInteger(num) ? num.toLocaleString("en-IN") : num.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Returns `YYYY-MM-DD` in the user's local timezone (avoids UTC `.toISOString().slice(0, 10)`
 * shifting dates backwards for IST/positive UTC offsets).
 */
export function toLocalDateString(value: Date | string | null | undefined = new Date()): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Returns `YYYY-MM` in the user's local timezone for monthly trend bucketing.
 */
export function toLocalMonthString(value: Date | string | null | undefined = new Date()): string {
  const localDate = toLocalDateString(value);
  return localDate ? localDate.slice(0, 7) : "";
}

/**
 * Returns `YYYY-MM-DD` shifted by `days` calendar days in local time.
 */
export function addLocalDays(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return toLocalDateString(d);
}
