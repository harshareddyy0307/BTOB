import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Globe, Percent, History, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
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

export function MarginPricingPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [globalPct, setGlobalPct] = useState("15");
  const [catId, setCatId] = useState("");
  const [catPct, setCatPct] = useState("20");
  const [prodId, setProdId] = useState("");
  const [prodPct, setProdPct] = useState("25");
  const [savingRule, setSavingRule] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [onlyPending, setOnlyPending] = useState(false);

  const { data: categories = [] } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: marginRules = [] } = useQuery({
    queryKey: ["admin-margin-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("margin_rules")
        .select("*, categories(name), products(name, sku)")
        .eq("is_active", true)
        .order("scope");
      if (error) throw error;
      const rows = (data ?? []) as unknown as MarginRuleRow[];
      const glob = rows.find((r) => r.scope === "global");
      if (glob) setGlobalPct(String(glob.margin_percentage));
      return rows;
    },
  });

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["admin-pricing-products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, manufacturer:manufacturers(id, company_name), category:categories(id, name), product_prices(*)")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as AdminProduct[];
    },
  });

  const { data: priceHistory = [] } = useQuery({
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

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-margin-rules"] });
    queryClient.invalidateQueries({ queryKey: ["admin-pricing-products"] });
    queryClient.invalidateQueries({ queryKey: ["admin-price-history"] });
    queryClient.invalidateQueries({ queryKey: ["admin-all-products"] });
  };

  const applyMarginRule = async (
    scope: "global" | "category" | "product",
    pct: number,
    targetCategoryId?: string,
    targetProductId?: string
  ) => {
    if (Number.isNaN(pct) || pct < 0) {
      toast({ title: "Enter a valid non-negative margin percentage", type: "error" });
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
      });
      if (error) throw error;
      toast({
        title: `${scope.charAt(0).toUpperCase() + scope.slice(1)} margin rule applied`,
        description: "Draft selling prices recalculated. Review and publish to Customer Catalog when ready.",
        type: "success",
      });
      invalidateAll();
    } catch (err) {
      toast({ title: "Failed to apply margin rule", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingRule(false);
    }
  };

  const removeRule = async (ruleId: string, scope: "category" | "product", targetId: string) => {
    setSavingRule(true);
    try {
      await supabase.from("margin_rules").update({ is_active: false }).eq("id", ruleId);
      if (scope === "product") {
        await supabase.rpc("recalculate_product_draft_price", {
          p_product_id: targetId,
          p_new_manufacturer_price: null,
          p_notes: "Product margin override removed",
        });
      } else {
        const affected = products.filter((p) => p.category_id === targetId);
        for (const p of affected) {
          await supabase.rpc("recalculate_product_draft_price", {
            p_product_id: p.id,
            p_new_manufacturer_price: null,
            p_notes: "Category margin override removed",
          });
        }
      }
      toast({ title: "Margin override removed and prices recalculated", type: "info" });
      invalidateAll();
    } finally {
      setSavingRule(false);
    }
  };

  const publishIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    setPublishing(true);
    try {
      const { data: count, error } = await supabase.rpc("publish_product_prices", {
        p_product_ids: ids,
        p_mark_products_published: true,
      });
      if (error) throw error;
      toast({
        title: `Published ${count} product price(s) to Customer Catalog`,
        type: "success",
      });
      setSelectedIds([]);
      invalidateAll();
    } catch (err) {
      toast({ title: "Publish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setPublishing(false);
    }
  };

  const pendingProducts = products.filter((p) => p.product_prices?.approval_status === "pending_review" || !p.is_published);
  const displayedProducts = onlyPending ? pendingProducts : products;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Margin &amp; Pricing Engine</h1>
          <p className="text-sm text-slate-500">
            Priority: <strong>Individual Product Margin &gt; Category Margin &gt; Global Margin</strong>. Review draft
            calculations before publishing to customers.
          </p>
        </div>
        <Button
          onClick={() => publishIds(pendingProducts.map((p) => p.id))}
          disabled={publishing || pendingProducts.length === 0}
        >
          {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
          Publish All Pending ({pendingProducts.length})
        </Button>
      </div>

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Margin Rules (3 Levels)</TabsTrigger>
          <TabsTrigger value="review">Price Preview &amp; Approval ({pendingProducts.length} Pending)</TabsTrigger>
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
                <CardDescription>Fallback margin applied when no category or product rule exists.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Global Margin Percentage (%)</Label>
                  <Input type="number" step="0.01" min="0" value={globalPct} onChange={(e) => setGlobalPct(e.target.value)} />
                </div>
                <Button
                  className="w-full"
                  disabled={savingRule}
                  onClick={() => applyMarginRule("global", Number(globalPct))}
                >
                  Apply Global Margin
                </Button>
              </CardContent>
            </Card>

            {/* Category Margin */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">B. Category-wise Margin</CardTitle>
                <CardDescription>Overrides Global margin for all products in a category.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={catId} onValueChange={setCatId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category Margin (%)</Label>
                  <Input type="number" step="0.01" min="0" value={catPct} onChange={(e) => setCatPct(e.target.value)} />
                </div>
                <Button
                  className="w-full"
                  disabled={savingRule || !catId}
                  onClick={() => applyMarginRule("category", Number(catPct), catId)}
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
                      {products.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.sku})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Product Margin (%)</Label>
                  <Input type="number" step="0.01" min="0" value={prodPct} onChange={(e) => setProdPct(e.target.value)} />
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
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Margin %</TableHead>
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
                      <TableCell className="text-xs text-slate-500">{formatDateTime(rule.updated_at)}</TableCell>
                      <TableCell className="text-right">
                        {rule.scope !== "global" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600"
                            disabled={savingRule}
                            onClick={() =>
                              removeRule(
                                rule.id,
                                rule.scope as "category" | "product",
                                (rule.category_id || rule.product_id)!
                              )
                            }
                          >
                            Remove Override
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: Price Preview & Approval */}
        <TabsContent value="review">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Price Preview &amp; Publishing Queue</CardTitle>
                <CardDescription>
                  Formula: Selling Price = Manufacturer Price + (Manufacturer Price &times; Margin % / 100)
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={onlyPending ? "default" : "outline"}
                  size="sm"
                  onClick={() => setOnlyPending((v) => !v)}
                >
                  {onlyPending ? "Showing Pending Only" : "Show Pending Only"}
                </Button>
                <Button
                  size="sm"
                  disabled={publishing || selectedIds.length === 0}
                  onClick={() => publishIds(selectedIds)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Publish Selected ({selectedIds.length})
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
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
                    <TableHead>Mfg Price</TableHead>
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
                  ) : (
                    displayedProducts.map((p) => {
                      const pr = p.product_prices;
                      const isPending = pr?.approval_status === "pending_review" || !p.is_published;
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
                            {formatCurrency(pr?.draft_manufacturer_price ?? 0)}
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold uppercase text-slate-700">
                              {pr?.draft_margin_source || "global"}
                            </span>{" "}
                            {pr?.draft_margin_percentage ?? 0}%
                          </TableCell>
                          <TableCell className="text-emerald-700 font-medium">
                            +{formatCurrency(pr?.draft_margin_amount ?? 0)}
                          </TableCell>
                          <TableCell className="font-semibold text-blue-700">
                            {formatCurrency(pr?.draft_selling_price ?? 0)}
                          </TableCell>
                          <TableCell className="text-slate-600">
                            {p.is_published ? formatCurrency(pr?.published_selling_price ?? 0) : "Unpublished"}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={isPending ? "pending_review" : "published"} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant={isPending ? "default" : "outline"}
                              disabled={publishing}
                              onClick={() => publishIds([p.id])}
                            >
                              {isPending ? "Approve & Publish" : "Re-publish"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
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
                          {h.old_manufacturer_price != null ? `${formatCurrency(h.old_manufacturer_price)} → ` : ""}
                          <strong>{formatCurrency(h.new_manufacturer_price)}</strong>
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.old_margin_percentage != null ? `${h.old_margin_percentage}% → ` : ""}
                          <strong>{h.new_margin_percentage}%</strong>
                        </TableCell>
                        <TableCell className="text-xs">
                          {h.old_selling_price != null ? `${formatCurrency(h.old_selling_price)} → ` : ""}
                          <strong className="text-blue-700">{formatCurrency(h.new_selling_price)}</strong>
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">{h.notes || "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
