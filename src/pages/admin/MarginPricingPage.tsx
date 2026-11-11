import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Globe,
  GlobeLock,
  Percent,
  History,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { fetchAllRows, supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import {
  bulkPublishProducts,
  bulkUnpublishProducts,
  bulkUpdatePublishedPrices,
  invalidateCatalogQueries,
} from "@/lib/productPublishing";
import {
  calculateGrossMarginPricing,
  formatSignedCurrency,
  isPublishedWithPendingPrice,
  isValidGrossMarginPct,
  resolveClientEffectiveMargin,
} from "@/lib/pricing";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { AdminProduct, Category } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

interface MarginRuleRow {
  id: string;
  scope: "global" | "category" | "product";
  category_id: string | null;
  product_id: string | null;
  margin_percentage: number;
  is_active: boolean;
  notes: string | null;
  updated_at: string;
  categories?: { name: string };
  products?: { name: string; sku: string };
}

type ReviewFilter = "all" | "price_updates" | "unpublished_drafts";

const EMPTY_CATEGORIES: Category[] = [];
const EMPTY_MARGIN_RULES: MarginRuleRow[] = [];
const EMPTY_PRODUCTS: AdminProduct[] = [];
const EMPTY_PRICE_HISTORY: never[] = [];

export function MarginPricingPage() {
  const { userProfile, branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [globalPct, setGlobalPct] = useState("15");
  const [clearGlobalOverrides, setClearGlobalOverrides] = useState(false);
  const [catId, setCatId] = useState("");
  const [catPct, setCatPct] = useState("20");
  const [clearCatChildOverrides, setClearCatChildOverrides] = useState(false);
  const [prodId, setProdId] = useState("");
  const [prodPct, setProdPct] = useState("25");
  const [savingRule, setSavingRule] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState<"update_live" | "publish_drafts" | "unpublish" | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");

  const { data: categories = EMPTY_CATEGORIES } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: marginRules = EMPTY_MARGIN_RULES } = useQuery({
    queryKey: ["admin-margin-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("margin_rules")
        .select("*, categories(name), products(name, sku)")
        .eq("is_active", true)
        .order("scope");
      if (error) throw error;
      return (data ?? []) as unknown as MarginRuleRow[];
    },
  });

  const { data: products = EMPTY_PRODUCTS, isLoading } = useQuery({
    queryKey: ["admin-pricing-products"],
    queryFn: async () => {
      return await fetchAllRows<AdminProduct>((from, to) =>
        supabase
          .from("products")
          .select("*, manufacturer:manufacturers(id, company_name), category:categories(id, name), product_prices(*)")
          .order("name")
          .order("id", { ascending: true })
          .range(from, to)
      );
    },
  });

  const { data: priceHistory = EMPTY_PRICE_HISTORY } = useQuery({
    queryKey: ["admin-price-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("price_history")
        .select("*, products(name, sku)")
        .order("created_at", { ascending: false })
        .limit(80);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Sync global input cleanly after query resolves (not inside queryFn)
  useEffect(() => {
    const glob = marginRules.find((r) => r.scope === "global");
    if (glob) {
      setGlobalPct(String(glob.margin_percentage));
    }
  }, [marginRules]);

  // Sync category input when selecting a category
  useEffect(() => {
    if (!catId) return;
    const directRule = marginRules.find((r) => r.scope === "category" && r.category_id === catId);
    if (directRule) {
      setCatPct(String(directRule.margin_percentage));
    } else {
      const inherited = resolveClientEffectiveMargin({
        categoryId: catId,
        categories,
        rules: marginRules,
      });
      setCatPct(String(inherited.marginPercentage));
    }
    setClearCatChildOverrides(false);
  }, [catId, marginRules, categories]);

  // Sync product input when selecting a product
  useEffect(() => {
    if (!prodId) return;
    const directRule = marginRules.find((r) => r.scope === "product" && r.product_id === prodId);
    if (directRule) {
      setProdPct(String(directRule.margin_percentage));
      return;
    }
    const targetProd = products.find((p) => p.id === prodId);
    const inherited = resolveClientEffectiveMargin({
      productId: prodId,
      categoryId: targetProd?.category_id ?? null,
      categories,
      rules: marginRules,
    });
    setProdPct(String(inherited.marginPercentage));
  }, [prodId, marginRules, categories, products]);

  const categoryOverrides = useMemo(() => marginRules.filter((r) => r.scope === "category"), [marginRules]);
  const productOverrides = useMemo(() => marginRules.filter((r) => r.scope === "product"), [marginRules]);
  const totalOverrideCount = categoryOverrides.length + productOverrides.length;

  // Count child/descendant overrides under currently selected category
  const catDescendantOverrideCount = useMemo(() => {
    if (!catId) return 0;
    const subtreeIds = new Set<string>([catId]);
    const queue = [catId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const c of categories) {
        if (c.parent_id === curr && !subtreeIds.has(c.id)) {
          subtreeIds.add(c.id);
          queue.push(c.id);
        }
      }
    }
    const childCatRules = categoryOverrides.filter((r) => r.category_id && r.category_id !== catId && subtreeIds.has(r.category_id)).length;
    const prodIdsInSubtree = new Set(products.filter((p) => subtreeIds.has(p.category_id)).map((p) => p.id));
    const childProdRules = productOverrides.filter((r) => r.product_id && prodIdsInSubtree.has(r.product_id)).length;
    return childCatRules + childProdRules;
  }, [catId, categories, products, categoryOverrides, productOverrides]);

  const selectedCatRule = useMemo(
    () => (catId ? marginRules.find((r) => r.scope === "category" && r.category_id === catId) : undefined),
    [catId, marginRules]
  );

  const selectedProduct = useMemo(() => products.find((p) => p.id === prodId) ?? null, [prodId, products]);
  const selectedProdRule = useMemo(
    () => (prodId ? marginRules.find((r) => r.scope === "product" && r.product_id === prodId) : undefined),
    [prodId, marginRules]
  );

  const globalPreview = calculateGrossMarginPricing(100, Number(globalPct));
  const catPreview = calculateGrossMarginPricing(100, Number(catPct));
  const prodCost = Number(selectedProduct?.product_prices?.draft_manufacturer_price ?? 100);
  const prodPreview = calculateGrossMarginPricing(prodCost, Number(prodPct));

  const invalidateAll = () => {
    void invalidateCatalogQueries(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["admin-margin-rules"] });
  };

  const applyMarginRule = async (
    scope: "global" | "category" | "product",
    pct: number,
    targetCategoryId?: string,
    targetProductId?: string,
    clearChildOverrides = false
  ) => {
    if (!isValidGrossMarginPct(pct)) {
      toast({
        title: "Invalid margin percentage",
        description: "Gross margin on selling price must be >= 0% and strictly less than 100%.",
        type: "error",
      });
      return;
    }
    setSavingRule(true);
    try {
      const { error } = await supabase.rpc("upsert_margin_rule_and_recalculate", {
        p_scope: scope,
        p_margin_percentage: pct,
        p_category_id: targetCategoryId || null,
        p_product_id: targetProductId || null,
        p_notes: `${scope} margin updated to ${pct}%`,
        p_clear_child_overrides: clearChildOverrides,
      });
      if (error) throw error;

      let extraNote = "Draft prices recalculated.";
      if (scope === "global" && !clearChildOverrides && totalOverrideCount > 0) {
        extraNote = `${totalOverrideCount} category/product override(s) still take precedence for their SKUs.`;
      } else if (scope === "category" && !clearChildOverrides && catDescendantOverrideCount > 0) {
        extraNote = `${catDescendantOverrideCount} product/subcategory override(s) still take precedence.`;
      } else if (clearChildOverrides) {
        extraNote = "Lower-level overrides cleared and all matching products recalculated.";
      }

      toast({
        title: `${scope.charAt(0).toUpperCase() + scope.slice(1)} margin rule applied (${pct}%)`,
        description: `${extraNote} Published prices stay unchanged until you push updates.`,
        type: "success",
      });

      if (scope === "global") setClearGlobalOverrides(false);
      if (scope === "category") setClearCatChildOverrides(false);
      invalidateAll();
    } catch (err) {
      toast({ title: "Failed to apply margin rule", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingRule(false);
    }
  };

  const removeRule = async (rule: MarginRuleRow) => {
    setSavingRule(true);
    try {
      const { error } = await supabase.rpc("remove_margin_rule_and_recalculate", {
        p_rule_id: rule.id,
      });
      if (error) throw error;
      toast({ title: "Margin override removed and draft prices recalculated", type: "info" });
      invalidateAll();
    } catch (err) {
      toast({
        title: "Failed to remove override",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setSavingRule(false);
    }
  };

  const publishedProducts = useMemo(() => products.filter((p) => p.is_published), [products]);
  const publishedPendingProducts = useMemo(
    () => products.filter((p) => isPublishedWithPendingPrice(p)),
    [products]
  );
  const unpublishedDraftProducts = useMemo(() => products.filter((p) => !p.is_published), [products]);

  const displayedProducts = useMemo(() => {
    if (reviewFilter === "price_updates") return publishedPendingProducts;
    if (reviewFilter === "unpublished_drafts") return unpublishedDraftProducts;
    return products;
  }, [reviewFilter, products, publishedPendingProducts, unpublishedDraftProducts]);

  // Clear stale selections when filter changes
  useEffect(() => {
    const valid = new Set(displayedProducts.map((p) => p.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => valid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [displayedProducts]);

  const handleUpdatePublishedPrices = async (targetProducts: AdminProduct[], onlyPending = true) => {
    if (targetProducts.length === 0) return;
    setBulkBusy("update_live");
    try {
      const { updatedCount, skippedZeroPriceCount } = await bulkUpdatePublishedPrices(targetProducts, queryClient, {
        onlyPending,
      });
      if (updatedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: `Cannot update ${sym}0 price products`,
          description: `${skippedZeroPriceCount} product(s) have a ${sym}0 draft selling price.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Updated live selling prices for ${updatedCount} published product(s)`,
        description:
          skippedZeroPriceCount > 0
            ? `Skipped ${skippedZeroPriceCount} ${sym}0-price item(s). Draft (unpublished) products were kept unpublished.`
            : "Unpublished draft products remain hidden from customers.",
        type: "success",
      });
      setSelectedIds([]);
      invalidateAll();
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkBusy(null);
    }
  };

  const handlePublishDraftProducts = async (targetProducts: AdminProduct[]) => {
    const drafts = targetProducts.filter((p) => !p.is_published);
    if (drafts.length === 0) return;
    setBulkBusy("publish_drafts");
    try {
      const { publishedCount, skippedZeroPriceCount } = await bulkPublishProducts(drafts, queryClient);
      if (publishedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: `Cannot publish ${sym}0 price products`,
          description: `${skippedZeroPriceCount} draft product(s) have a ${sym}0 selling price.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Published ${publishedCount} draft product(s) to Customer Catalog`,
        description: skippedZeroPriceCount > 0 ? `Skipped ${skippedZeroPriceCount} ${sym}0-price product(s).` : undefined,
        type: "success",
      });
      setSelectedIds([]);
      invalidateAll();
    } catch (err) {
      toast({ title: "Publish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkBusy(null);
    }
  };

  const handleSingleRowAction = async (p: AdminProduct) => {
    const draftSell = Number(p.product_prices?.draft_selling_price ?? 0);
    if (draftSell <= 0) {
      toast({ title: `Cannot apply ${sym}0 selling price`, description: "Set a manufacturer price first.", type: "error" });
      return;
    }
    setRowBusyId(p.id);
    try {
      const markPublished = !p.is_published;
      const { error } = await supabase.rpc("publish_product_prices", {
        p_product_ids: [p.id],
        p_mark_products_published: markPublished,
      });
      if (error) throw error;
      toast({
        title: markPublished
          ? `Published "${p.name}" to Customer Catalog`
          : `Updated live selling price for "${p.name}"`,
        type: "success",
      });
      invalidateAll();
    } catch (err) {
      toast({ title: "Action failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setRowBusyId(null);
    }
  };

  const handleUnpublishAll = async () => {
    if (publishedProducts.length === 0) return;
    setBulkBusy("unpublish");
    try {
      const { unpublishedCount } = await bulkUnpublishProducts(publishedProducts, userProfile?.id, queryClient);
      toast({
        title: `Unpublished ${unpublishedCount} product(s) from Customer Catalog`,
        type: "info",
      });
      invalidateAll();
    } catch (err) {
      toast({ title: "Unpublish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkBusy(null);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectedPublished = products.filter((p) => selectedIds.includes(p.id) && p.is_published);
  const selectedDrafts = products.filter((p) => selectedIds.includes(p.id) && !p.is_published);
  const totalAttentionCount = publishedPendingProducts.length + unpublishedDraftProducts.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">Margin &amp; Pricing Engine</h1>
          <p className="text-sm text-slate-500">
            Gross Margin on Selling Price (<code>Cost ÷ (1 − Margin %)</code>) &bull; Priority:{" "}
            <strong>Product &gt; Category &gt; Global</strong>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => handleUpdatePublishedPrices(publishedPendingProducts, true)}
            disabled={bulkBusy !== null || publishedPendingProducts.length === 0}
            title="Update live Customer Portal prices for already-published products without publishing Draft items"
          >
            {bulkBusy === "update_live" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Update Published Prices ({publishedPendingProducts.length})
          </Button>
          <Button
            variant="outline"
            className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            onClick={() => handlePublishDraftProducts(unpublishedDraftProducts)}
            disabled={bulkBusy !== null || unpublishedDraftProducts.length === 0}
            title="Make unpublished draft products live in Customer Catalog"
          >
            {bulkBusy === "publish_drafts" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            Publish Drafts ({unpublishedDraftProducts.length})
          </Button>
          <Button
            variant="outline"
            className="border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
            onClick={handleUnpublishAll}
            disabled={bulkBusy !== null || publishedProducts.length === 0}
          >
            {bulkBusy === "unpublish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GlobeLock className="h-4 w-4" />}
            Unpublish All ({publishedProducts.length})
          </Button>
        </div>
      </div>

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Margin Rules (3 Levels)</TabsTrigger>
          <TabsTrigger value="review">
            Price Preview &amp; Approval ({totalAttentionCount} Pending)
          </TabsTrigger>
          <TabsTrigger value="history">Price Change History</TabsTrigger>
        </TabsList>

        {/* TAB 1: Margin Rules */}
        <TabsContent value="rules" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Global Margin */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Percent className="h-4 w-4 text-blue-700" />
                  A. Global Default Margin
                </CardTitle>
                <CardDescription>Fallback margin applied when no category or product override exists.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Global Margin Percentage (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="99.99"
                    value={globalPct}
                    onChange={(e) => setGlobalPct(e.target.value)}
                  />
                  {isValidGrossMarginPct(Number(globalPct)) ? (
                    <p className="text-xs text-slate-500">
                      Preview on {sym}100 cost →{" "}
                      <strong className="text-blue-700">{formatCurrency(globalPreview.sellingPrice, sym)}</strong> selling (
                      {formatSignedCurrency(globalPreview.marginAmount, sym)} = {globalPreview.marginPercentage}% margin)
                    </p>
                  ) : (
                    <p className="text-xs text-red-600">Must be between 0% and 99.99%.</p>
                  )}
                </div>

                {totalOverrideCount > 0 && (
                  <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
                      <span>
                        <strong>{totalOverrideCount} override rule(s)</strong> active ({categoryOverrides.length}{" "}
                        category, {productOverrides.length} product). They take priority over Global unless cleared.
                      </span>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 font-medium text-amber-950">
                      <input
                        type="checkbox"
                        checked={clearGlobalOverrides}
                        onChange={(e) => setClearGlobalOverrides(e.target.checked)}
                      />
                      <span>Clear category &amp; product overrides on apply</span>
                    </label>
                  </div>
                )}

                <Button
                  className="w-full"
                  disabled={savingRule}
                  onClick={() => applyMarginRule("global", Number(globalPct), undefined, undefined, clearGlobalOverrides)}
                >
                  Apply Global Margin
                </Button>
              </CardContent>
            </Card>

            {/* Category Margin */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">B. Category-wise Margin</CardTitle>
                <CardDescription>Overrides Global margin for all products in a category tree.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={catId} onValueChange={setCatId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => {
                        const rule = marginRules.find((r) => r.scope === "category" && r.category_id === c.id);
                        return (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                            {rule ? ` (${rule.margin_percentage}% override)` : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {catId && (
                    <p className="text-xs text-slate-500">
                      {selectedCatRule ? (
                        <>
                          Active override: <strong className="text-blue-700">{selectedCatRule.margin_percentage}%</strong>
                        </>
                      ) : (
                        <>Currently inheriting default margin</>
                      )}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Category Margin (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="99.99"
                    value={catPct}
                    onChange={(e) => setCatPct(e.target.value)}
                  />
                  {isValidGrossMarginPct(Number(catPct)) ? (
                    <p className="text-xs text-slate-500">
                      Preview on {sym}100 cost →{" "}
                      <strong className="text-blue-700">{formatCurrency(catPreview.sellingPrice, sym)}</strong> selling
                    </p>
                  ) : (
                    <p className="text-xs text-red-600">Must be between 0% and 99.99%.</p>
                  )}
                </div>

                {catId && catDescendantOverrideCount > 0 && (
                  <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
                      <span>
                        <strong>{catDescendantOverrideCount} lower-level override(s)</strong> exist inside this category.
                      </span>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 font-medium text-amber-950">
                      <input
                        type="checkbox"
                        checked={clearCatChildOverrides}
                        onChange={(e) => setClearCatChildOverrides(e.target.checked)}
                      />
                      <span>Clear product &amp; subcategory overrides inside this category</span>
                    </label>
                  </div>
                )}

                <Button
                  className="w-full"
                  disabled={savingRule || !catId}
                  onClick={() => applyMarginRule("category", Number(catPct), catId, undefined, clearCatChildOverrides)}
                >
                  Set Category Margin
                </Button>
              </CardContent>
            </Card>

            {/* Product Margin */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">C. Individual Product Margin</CardTitle>
                <CardDescription>Highest priority override for a specific SKU.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Product</Label>
                  <Select value={prodId} onValueChange={setProdId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose product" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((p) => {
                        const rule = marginRules.find((r) => r.scope === "product" && r.product_id === p.id);
                        return (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} ({p.sku})
                            {rule ? ` — ${rule.margin_percentage}% override` : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {selectedProduct && (
                    <p className="text-xs text-slate-500">
                      Mfg Cost: <strong>{formatCurrency(selectedProduct.product_prices?.draft_manufacturer_price ?? 0, sym)}</strong>{" "}
                      &bull;{" "}
                      {selectedProdRule
                        ? `Product override: ${selectedProdRule.margin_percentage}%`
                        : `Inherited (${selectedProduct.product_prices?.draft_margin_source || "global"}): ${
                            selectedProduct.product_prices?.draft_margin_percentage ?? 0
                          }%`}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Product Margin (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="99.99"
                    value={prodPct}
                    onChange={(e) => setProdPct(e.target.value)}
                  />
                  {selectedProduct &&
                    (isValidGrossMarginPct(Number(prodPct)) ? (
                      <p className="text-xs text-slate-500">
                        Draft Selling Preview:{" "}
                        <strong className="text-blue-700">{formatCurrency(prodPreview.sellingPrice, sym)}</strong> (
                        {formatSignedCurrency(prodPreview.marginAmount, sym)})
                      </p>
                    ) : (
                      <p className="text-xs text-red-600">Must be between 0% and 99.99%.</p>
                    ))}
                </div>
                <Button
                  className="w-full"
                  disabled={savingRule || !prodId}
                  onClick={() => applyMarginRule("product", Number(prodPct), undefined, prodId)}
                >
                  Set Product Override
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Active Margin Rules Table */}
          <Card>
            <CardHeader>
              <CardTitle>Active Margin Rules</CardTitle>
              <CardDescription>
                Priority order: <strong>PRODUCT &gt; CATEGORY &gt; GLOBAL</strong>. Removing a Category or Product
                override automatically reverts affected SKUs to the parent rule.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {marginRules.map((rule) => (
                  <div key={rule.id} className="space-y-1.5 p-4 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-semibold uppercase text-slate-700">
                        {rule.scope}
                      </span>
                      <span className="text-sm font-bold text-blue-700">{rule.margin_percentage}%</span>
                    </div>
                    <p className="font-medium text-slate-900">
                      {rule.scope === "global"
                        ? "All Products (Default)"
                        : rule.scope === "category"
                        ? rule.categories?.name
                        : `${rule.products?.name} (${rule.products?.sku})`}
                    </p>
                    <p className="text-slate-500">Updated {formatDateTime(rule.updated_at)}</p>
                    {rule.scope !== "global" && (
                      <div className="flex justify-end pt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-red-600"
                          disabled={savingRule}
                          onClick={() => removeRule(rule)}
                        >
                          Remove Override
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="hidden md:block">
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Margin %</TableHead>
                    <TableHead>Behavior</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {marginRules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell className="font-semibold uppercase text-xs">{rule.scope}</TableCell>
                      <TableCell>
                        {rule.scope === "global"
                          ? "All Products (Default)"
                          : rule.scope === "category"
                          ? rule.categories?.name
                          : `${rule.products?.name} (${rule.products?.sku})`}
                      </TableCell>
                      <TableCell className="font-semibold text-blue-700">{rule.margin_percentage}%</TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {rule.scope === "global"
                          ? "Fallback when no Category/Product override exists"
                          : rule.scope === "category"
                          ? "Overrides Global margin for this category"
                          : "Overrides Category & Global for this SKU"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">{formatDateTime(rule.updated_at)}</TableCell>
                      <TableCell className="text-right">
                        {rule.scope !== "global" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600"
                            disabled={savingRule}
                            onClick={() => removeRule(rule)}
                          >
                            Remove Override
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: Price Preview & Approval */}
        <TabsContent value="review">
          <Card>
            <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center sm:justify-between">
              <div>
                <CardTitle>Price Preview &amp; Publishing Queue</CardTitle>
                <CardDescription>
                  Gross Margin on Selling Price: <strong>Selling Price = Cost &divide; (1 &minus; Margin % / 100)</strong>{" "}
                  &bull; Profit % is measured on Selling Price.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={reviewFilter === "all" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setReviewFilter("all")}
                >
                  All ({products.length})
                </Button>
                <Button
                  variant={reviewFilter === "price_updates" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setReviewFilter("price_updates")}
                >
                  Live Price Updates ({publishedPendingProducts.length})
                </Button>
                <Button
                  variant={reviewFilter === "unpublished_drafts" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setReviewFilter("unpublished_drafts")}
                >
                  Unpublished Drafts ({unpublishedDraftProducts.length})
                </Button>
                {selectedPublished.length > 0 && (
                  <Button
                    size="sm"
                    disabled={bulkBusy !== null}
                    onClick={() => handleUpdatePublishedPrices(selectedPublished, false)}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Update Live Prices ({selectedPublished.length})
                  </Button>
                )}
                {selectedDrafts.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                    disabled={bulkBusy !== null}
                    onClick={() => handlePublishDraftProducts(selectedDrafts)}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Publish Drafts ({selectedDrafts.length})
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {isLoading ? (
                  <p className="py-8 text-center text-sm text-slate-500">Loading pricing sheet...</p>
                ) : displayedProducts.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">No products match the selected filter.</p>
                ) : (
                  displayedProducts.map((p) => {
                    const pr = p.product_prices;
                    const isLivePricePending = isPublishedWithPendingPrice(p);
                    const isUnpublished = !p.is_published;
                    const busy = bulkBusy !== null || rowBusyId === p.id;
                    return (
                      <div key={p.id} className="space-y-2.5 p-4 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <label className="flex min-w-0 items-start gap-2.5">
                            <input
                              type="checkbox"
                              className="mt-1 shrink-0"
                              checked={selectedIds.includes(p.id)}
                              onChange={() => toggleSelect(p.id)}
                            />
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900">{p.name}</p>
                              <p className="text-slate-500">
                                {p.sku} &bull; {p.category?.name}
                              </p>
                            </div>
                          </label>
                          <div className="shrink-0">
                            {isUnpublished ? (
                              <StatusBadge status="draft" />
                            ) : isLivePricePending ? (
                              <StatusBadge status="pending_review" />
                            ) : (
                              <StatusBadge status="published" />
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-100 bg-slate-50 p-2.5">
                          <div>
                            <span className="text-slate-500">Mfg Cost: </span>
                            <strong className="text-slate-900">
                              {formatCurrency(pr?.draft_manufacturer_price ?? 0, sym)}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Margin ({pr?.draft_margin_percentage ?? 0}%): </span>
                            <strong className="text-emerald-700">
                              {formatSignedCurrency(pr?.draft_margin_amount ?? 0, sym)}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Draft Selling: </span>
                            <strong className="text-blue-700">
                              {formatCurrency(pr?.draft_selling_price ?? 0, sym)}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Live Price: </span>
                            <strong className="text-slate-700">
                              {p.is_published ? formatCurrency(pr?.published_selling_price ?? 0, sym) : "Unpublished"}
                            </strong>
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold uppercase text-slate-700">
                            Rule: {pr?.draft_margin_source || "global"}
                          </span>
                          <Button
                            size="sm"
                            variant={isUnpublished ? "outline" : isLivePricePending ? "default" : "outline"}
                            className={
                              isUnpublished
                                ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                : undefined
                            }
                            disabled={busy}
                            onClick={() => handleSingleRowAction(p)}
                          >
                            {rowBusyId === p.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {isUnpublished
                              ? "Publish to Catalog"
                              : isLivePricePending
                              ? "Update Live Price"
                              : "Re-sync Live"}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={displayedProducts.length > 0 && selectedIds.length === displayedProducts.length}
                        onChange={(e) =>
                          setSelectedIds(e.target.checked ? displayedProducts.map((p) => p.id) : [])
                        }
                      />
                    </TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Mfg Cost</TableHead>
                    <TableHead>Rule / Margin %</TableHead>
                    <TableHead>Margin Amt</TableHead>
                    <TableHead>Draft Selling Price</TableHead>
                    <TableHead>Live Published Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                        Loading pricing sheet...
                      </TableCell>
                    </TableRow>
                  ) : displayedProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                        No products match the selected filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    displayedProducts.map((p) => {
                      const pr = p.product_prices;
                      const isLivePricePending = isPublishedWithPendingPrice(p);
                      const isUnpublished = !p.is_published;
                      const busy = bulkBusy !== null || rowBusyId === p.id;
                      return (
                        <TableRow key={p.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(p.id)}
                              onChange={() => toggleSelect(p.id)}
                            />
                          </TableCell>
                          <TableCell>
                            <p className="font-medium text-slate-900">{p.name}</p>
                            <p className="text-xs text-slate-500">
                              {p.sku} &bull; {p.category?.name}
                            </p>
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatCurrency(pr?.draft_manufacturer_price ?? 0, sym)}
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold uppercase text-slate-700">
                              {pr?.draft_margin_source || "global"}
                            </span>{" "}
                            {pr?.draft_margin_percentage ?? 0}%
                          </TableCell>
                          <TableCell className="font-medium text-emerald-700">
                            {formatSignedCurrency(pr?.draft_margin_amount ?? 0, sym)}
                          </TableCell>
                          <TableCell className="font-semibold text-blue-700">
                            {formatCurrency(pr?.draft_selling_price ?? 0, sym)}
                          </TableCell>
                          <TableCell className="text-slate-600">
                            {p.is_published ? formatCurrency(pr?.published_selling_price ?? 0, sym) : "Unpublished"}
                          </TableCell>
                          <TableCell>
                            {isUnpublished ? (
                              <StatusBadge status="draft" />
                            ) : isLivePricePending ? (
                              <StatusBadge status="pending_review" />
                            ) : (
                              <StatusBadge status="published" />
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant={isUnpublished ? "outline" : isLivePricePending ? "default" : "outline"}
                              className={
                                isUnpublished
                                  ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                  : undefined
                              }
                              disabled={busy}
                              onClick={() => handleSingleRowAction(p)}
                            >
                              {rowBusyId === p.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                              {isUnpublished
                                ? "Publish to Catalog"
                                : isLivePricePending
                                ? "Update Live Price"
                                : "Re-sync Live"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: Price Change History */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-4 w-4 text-blue-700" />
                Price Change Audit History
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {priceHistory.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">No price change history recorded yet.</p>
                ) : (
                  priceHistory.map((h) => {
                    const prod = h.products as unknown as { name: string; sku: string };
                    return (
                      <div key={h.id} className="space-y-2 p-4 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900">{prod?.name}</p>
                            <p className="font-mono text-slate-500">{prod?.sku}</p>
                          </div>
                          <div className="shrink-0">
                            <StatusBadge status={h.action === "approved_published" ? "published" : "pending_review"} />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-1.5 rounded-md border border-slate-100 bg-slate-50 p-2.5 sm:grid-cols-3">
                          <div>
                            <span className="text-slate-500">Mfg Price: </span>
                            {h.old_manufacturer_price != null ? `${formatCurrency(h.old_manufacturer_price, sym)} → ` : ""}
                            <strong>{formatCurrency(h.new_manufacturer_price, sym)}</strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Margin: </span>
                            {h.old_margin_percentage != null ? `${h.old_margin_percentage}% → ` : ""}
                            <strong>{h.new_margin_percentage}%</strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Selling: </span>
                            {h.old_selling_price != null ? `${formatCurrency(h.old_selling_price, sym)} → ` : ""}
                            <strong className="text-blue-700">{formatCurrency(h.new_selling_price, sym)}</strong>
                          </div>
                        </div>

                        {h.notes && <p className="text-slate-600">{h.notes}</p>}
                        <p className="text-[11px] text-slate-400">{formatDateTime(h.created_at)}</p>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Mfg Price</TableHead>
                    <TableHead>Margin %</TableHead>
                    <TableHead>Selling Price</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceHistory.map((h) => {
                    const prod = h.products as unknown as { name: string; sku: string };
                    return (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs text-slate-500">{formatDateTime(h.created_at)}</TableCell>
                        <TableCell>
                          <p className="font-medium text-slate-900">{prod?.name}</p>
                          <p className="font-mono text-xs text-slate-500">{prod?.sku}</p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={h.action === "approved_published" ? "published" : "pending_review"} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.old_manufacturer_price != null ? `${formatCurrency(h.old_manufacturer_price, sym)} → ` : ""}
                          <strong>{formatCurrency(h.new_manufacturer_price, sym)}</strong>
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.old_margin_percentage != null ? `${h.old_margin_percentage}% → ` : ""}
                          <strong>{h.new_margin_percentage}%</strong>
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.old_selling_price != null ? `${formatCurrency(h.old_selling_price, sym)} → ` : ""}
                          <strong className="text-blue-700">{formatCurrency(h.new_selling_price, sym)}</strong>
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">{h.notes || "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
