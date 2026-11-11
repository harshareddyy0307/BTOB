import * as XLSX from "xlsx";
import { slugify } from "@/lib/utils";

export interface ParsedExcelProductRow {
  rowLabel: string;
  name: string;
  sku: string;
  categoryName: string;
  description: string | null;
  unitOfMeasurement: string;
  moqRaw: unknown;
  hsnCode: string | null;
  gstRaw: unknown;
  mfgPriceRaw: unknown;
  stockRaw: unknown;
}

const FIELD_ALIASES: Record<
  | "name"
  | "sku"
  | "category_name"
  | "description"
  | "unit_of_measurement"
  | "min_order_quantity"
  | "hsn_code"
  | "gst_rate"
  | "manufacturer_price"
  | "available_quantity",
  string[]
> = {
  name: ["name", "product_name", "item_name", "title", "product", "product_title"],
  sku: ["sku", "product_sku", "item_code", "product_code", "code", "sku_code", "part_number", "model_no"],
  category_name: [
    "category_name",
    "category",
    "cat_name",
    "product_category",
    "category_title",
    "group",
    "cat",
    "subcategory",
    "sub_category",
  ],
  description: ["description", "desc", "details", "product_description", "specifications", "specs"],
  unit_of_measurement: ["unit_of_measurement", "unit", "uom", "unit_name", "measure"],
  min_order_quantity: ["min_order_quantity", "moq", "min_order_qty", "min_qty", "minimum_order_quantity", "min_order"],
  hsn_code: ["hsn_code", "hsn", "hsn_sac", "sac_code", "hsn_number"],
  gst_rate: ["gst_rate", "gst", "gst_percent", "gst_pct", "gst_percentage", "tax_rate", "tax_percent", "tax"],
  manufacturer_price: [
    "manufacturer_price",
    "mfg_price",
    "cost_price",
    "purchase_price",
    "purchase_rate",
    "base_price",
    "orig_price",
    "original_price",
    "unit_cost",
    "wholesale_price",
    "cost",
    "rate",
    "price",
  ],
  available_quantity: [
    "available_quantity",
    "available_qty",
    "available_stock",
    "current_stock",
    "qty_available",
    "stock",
    "qty",
    "quantity",
    "stock_qty",
    "stock_quantity",
    "closing_stock",
    "opening_stock",
    "inventory",
  ],
};

export function normalizeHeaderKey(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[*#()₹$%]/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeCategoryLookupKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseSpreadsheetNumber(raw: unknown, defaultValue: number): number | null {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  const str = String(raw).trim();
  if (!str) return defaultValue;
  const cleaned = str.replace(/[₹$,%\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function pickWorkbookProductSheet(wb: XLSX.WorkBook): XLSX.WorkSheet | null {
  if (!wb.SheetNames.length) return null;
  const preferred = wb.SheetNames.find((s) => /^(products?|catalog|items?)$/i.test(s.trim()));
  if (preferred && wb.Sheets[preferred]) {
    const preferredRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[preferred], { defval: "" });
    if (preferredRows.length > 0) {
      return wb.Sheets[preferred];
    }
  }
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (rows.length > 0) return sheet;
  }
  return wb.Sheets[wb.SheetNames[0]] ?? null;
}

function isBlankRow(raw: Record<string, unknown>): boolean {
  return Object.entries(raw).every(([key, val]) => {
    if (key.startsWith("__EMPTY")) {
      return val === undefined || val === null || String(val).trim() === "";
    }
    return val === undefined || val === null || String(val).trim() === "";
  });
}

function getNormalizedField(normalizedRow: Map<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (normalizedRow.has(alias)) {
      const val = normalizedRow.get(alias);
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        return val;
      }
    }
  }
  for (const alias of aliases) {
    if (normalizedRow.has(alias)) {
      return normalizedRow.get(alias);
    }
  }
  return undefined;
}

export function extractSpreadsheetProductRows(sheet: XLSX.WorkSheet): ParsedExcelProductRow[] {
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const parsed: ParsedExcelProductRow[] = [];

  for (let idx = 0; idx < rawRows.length; idx++) {
    const r = rawRows[idx];
    if (isBlankRow(r)) continue;

    const rawRowNum =
      typeof (r as { __rowNum__?: unknown }).__rowNum__ === "number"
        ? (r as { __rowNum__: number }).__rowNum__ + 1
        : idx + 2;

    const normalizedRow = new Map<string, unknown>();
    for (const [k, v] of Object.entries(r)) {
      const normKey = normalizeHeaderKey(k);
      if (normKey && !normalizedRow.has(normKey)) {
        normalizedRow.set(normKey, v);
      }
    }

    const rawName = getNormalizedField(normalizedRow, FIELD_ALIASES.name);
    const rawSku = getNormalizedField(normalizedRow, FIELD_ALIASES.sku);
    const rawCat = getNormalizedField(normalizedRow, FIELD_ALIASES.category_name);
    const rawDesc = getNormalizedField(normalizedRow, FIELD_ALIASES.description);
    const rawUnit = getNormalizedField(normalizedRow, FIELD_ALIASES.unit_of_measurement);
    const rawMoq = getNormalizedField(normalizedRow, FIELD_ALIASES.min_order_quantity);
    const rawHsn = getNormalizedField(normalizedRow, FIELD_ALIASES.hsn_code);
    const rawGst = getNormalizedField(normalizedRow, FIELD_ALIASES.gst_rate);
    const rawPrice = getNormalizedField(normalizedRow, FIELD_ALIASES.manufacturer_price);
    const rawStock = getNormalizedField(normalizedRow, FIELD_ALIASES.available_quantity);

    const name = String(rawName ?? "").replace(/\s+/g, " ").trim();
    const sku = String(rawSku ?? "").trim().toUpperCase();
    const categoryName = String(rawCat ?? "").replace(/\s+/g, " ").trim();
    const descStr = String(rawDesc ?? "").trim();
    const unitStr = String(rawUnit ?? "").trim() || "pcs";
    const hsnStr = String(rawHsn ?? "").trim();

    parsed.push({
      rowLabel: `Row ${rawRowNum}`,
      name,
      sku,
      categoryName,
      description: descStr || null,
      unitOfMeasurement: unitStr,
      moqRaw: rawMoq,
      hsnCode: hsnStr || null,
      gstRaw: rawGst,
      mfgPriceRaw: rawPrice,
      stockRaw: rawStock,
    });
  }

  return parsed;
}

export function buildUniqueCategorySlug(categoryName: string, usedSlugs: Set<string>): string {
  const base = slugify(categoryName) || `category-${Date.now().toString(36)}`;
  let candidate = base;
  let counter = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}
