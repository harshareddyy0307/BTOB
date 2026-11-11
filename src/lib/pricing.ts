import { formatCurrency } from "@/lib/utils";
import type { AdminProduct, Category } from "@/types/database";

export interface MarginRuleSummary {
  id?: string;
  scope: "global" | "category" | "product";
  category_id: string | null;
  product_id: string | null;
  margin_percentage: number;
}

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isValidGrossMarginPct(pct: number): boolean {
  return Number.isFinite(pct) && pct >= 0 && pct < 100;
}

/**
 * Gross Margin on Selling Price:
 *   Selling Price = Manufacturer Cost / (1 - Margin% / 100)
 *   Margin Amount = Selling Price - Manufacturer Cost
 */
export function calculateGrossMarginPricing(
  manufacturerPrice: number,
  marginPercentage: number
): {
  manufacturerPrice: number;
  marginPercentage: number;
  sellingPrice: number;
  marginAmount: number;
} {
  const cost = roundMoney(Math.max(0, Number(manufacturerPrice) || 0));
  const rawPct = Number(marginPercentage);
  const clampedPct = Number.isFinite(rawPct) ? Math.min(99.99, Math.max(0, rawPct)) : 0;
  const divisor = 1 - clampedPct / 100;
  const sellingPrice = divisor > 0 ? roundMoney(cost / divisor) : cost;
  const marginAmount = roundMoney(sellingPrice - cost);

  return {
    manufacturerPrice: cost,
    marginPercentage: roundMoney(clampedPct),
    sellingPrice,
    marginAmount,
  };
}

/**
 * Realized Gross Margin on a custom or actual selling price:
 *   Margin Amount = Selling Price - Cost Price
 *   Margin % = (Margin Amount / Selling Price) * 100
 */
export function calculateRealizedGrossMargin(
  sellingPrice: number,
  costPrice: number
): {
  marginAmount: number;
  marginPercentage: number;
} {
  const sell = roundMoney(Number(sellingPrice) || 0);
  const cost = roundMoney(Number(costPrice) || 0);
  const marginAmount = roundMoney(sell - cost);
  const marginPercentage = sell > 0 ? roundMoney((marginAmount / sell) * 100) : 0;

  return { marginAmount, marginPercentage };
}

export function resolveClientEffectiveMargin(params: {
  productId?: string | null;
  categoryId?: string | null;
  categories: Pick<Category, "id" | "parent_id">[];
  rules: MarginRuleSummary[];
}): {
  source: "product" | "category" | "global";
  marginPercentage: number;
  matchedCategoryId: string | null;
} {
  const { productId, categoryId, categories, rules } = params;

  if (productId) {
    const prodRule = rules.find((r) => r.scope === "product" && r.product_id === productId);
    if (prodRule) {
      return {
        source: "product",
        marginPercentage: Number(prodRule.margin_percentage),
        matchedCategoryId: null,
      };
    }
  }

  if (categoryId) {
    const catById = new Map(categories.map((c) => [c.id, c]));
    const visited = new Set<string>();
    let cursor: string | null = categoryId;

    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const catRule = rules.find((r) => r.scope === "category" && r.category_id === cursor);
      if (catRule) {
        return {
          source: "category",
          marginPercentage: Number(catRule.margin_percentage),
          matchedCategoryId: cursor,
        };
      }
      cursor = catById.get(cursor)?.parent_id ?? null;
    }
  }

  const globalRule = rules.find((r) => r.scope === "global");
  return {
    source: "global",
    marginPercentage: Number(globalRule?.margin_percentage ?? 15),
    matchedCategoryId: null,
  };
}

export function formatSignedCurrency(amount: number | string | null | undefined, symbol = "₹"): string {
  const num = Number(amount ?? 0);
  if (Number.isNaN(num)) return formatCurrency(0, symbol);
  if (num < 0) return `-${formatCurrency(Math.abs(num), symbol)}`;
  if (num > 0) return `+${formatCurrency(num, symbol)}`;
  return formatCurrency(0, symbol);
}

export function isPublishedWithPendingPrice(p: Pick<AdminProduct, "is_published" | "product_prices">): boolean {
  return Boolean(p.is_published && p.product_prices?.approval_status === "pending_review");
}
