import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Boxes, AlertTriangle, PackageX, ArrowUpDown, History, Loader2, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatDateTime, formatQty } from "@/lib/utils";
import type { AdminProduct, Category, InventoryMovementRecord, Manufacturer } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function InventoryPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState("all");
  const [mfgFilter, setMfgFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");

  // Stock Adjustment Modal
  const [adjustProduct, setAdjustProduct] = useState<AdminProduct | null>(null);
  const [movementType, setMovementType] = useState<"restock" | "manual_adjustment">("restock");
  const [deltaStr, setDeltaStr] = useState("0");
  const [thresholdStr, setThresholdStr] = useState("10");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["admin-inventory"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "*, manufacturer:manufacturers(id, company_name, status), category:categories(id, name, slug), inventory(*)"
        )
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as AdminProduct[];
    },
  });

  const { data: movements = [], isLoading: loadingMovements } = useQuery({
    queryKey: ["admin-inventory-movements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_movements")
        .select("*, products(id, name, sku, unit_of_measurement), users(full_name, email)")
        .order("created_at", { ascending: false })
        .limit(150);
      if (error) throw error;
      return (data ?? []) as unknown as InventoryMovementRecord[];
    },
  });

  const { data: manufacturers = [] } = useQuery({
    queryKey: ["admin-manufacturers-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("manufacturers").select("id, company_name").order("company_name");
      return (data ?? []) as Pick<Manufacturer, "id" | "company_name">[];
    },
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").order("name");
      return (data ?? []) as Category[];
    },
  });

  const openAdjustModal = (p: AdminProduct) => {
    setAdjustProduct(p);
    setMovementType("restock");
    setDeltaStr("0");
    setThresholdStr(String(p.inventory?.low_stock_threshold ?? 10));
    setNotes("");
  };

  const handleSaveAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustProduct) return;

    const delta = Number(deltaStr) || 0;
    const threshold = Math.max(0, Number(thresholdStr) || 0);
    const oldThreshold = Number(adjustProduct.inventory?.low_stock_threshold ?? 10);

    if (delta === 0 && threshold === oldThreshold) {
      toast({ title: "Enter a non-zero stock adjustment or update alert threshold", type: "info" });
      return;
    }

    setSaving(true);
    try {
      if (delta !== 0) {
        const { error } = await supabase.rpc("adjust_inventory_admin", {
          p_product_id: adjustProduct.id,
          p_quantity_delta: delta,
          p_movement_type: delta < 0 ? "manual_adjustment" : movementType,
          p_notes: notes.trim() || `Manual stock adjustment (${delta > 0 ? "+" : ""}${delta})`,
        });
        if (error) throw error;
      }

      if (threshold !== oldThreshold) {
        const { error: thrErr } = await supabase
          .from("inventory")
          .update({ low_stock_threshold: threshold })
          .eq("product_id", adjustProduct.id);
        if (thrErr) throw thrErr;
      }

      toast({
        title: "Inventory updated",
        description: "Customer portal availability has been synchronized automatically.",
        type: "success",
      });
      setAdjustProduct(null);
      queryClient.invalidateQueries({ queryKey: ["admin-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["admin-inventory-movements"] });
      queryClient.invalidateQueries({ queryKey: ["admin-all-products"] });
    } catch (err) {
      toast({
        title: "Stock adjustment failed",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const totalAvailable = products.reduce((s, p) => s + Number(p.inventory?.available_quantity ?? 0), 0);
  const totalReserved = products.reduce((s, p) => s + Number(p.inventory?.reserved_quantity ?? 0), 0);
  const lowStockCount = products.filter((p) => {
    const a = Number(p.inventory?.available_quantity ?? 0);
    const t = Number(p.inventory?.low_stock_threshold ?? 10);
    return a > 0 && a <= t;
  }).length;
  const outOfStockCount = products.filter((p) => Number(p.inventory?.available_quantity ?? 0) <= 0).length;

  const filteredProducts = products.filter((p) => {
    const avail = Number(p.inventory?.available_quantity ?? 0);
    const thresh = Number(p.inventory?.low_stock_threshold ?? 10);
    const st = avail <= 0 ? "out_of_stock" : avail <= thresh ? "low_stock" : "in_stock";

    if (stockFilter !== "all" && st !== stockFilter) return false;
    if (mfgFilter !== "all" && p.manufacturer_id !== mfgFilter) return false;
    if (catFilter !== "all" && p.category_id !== catFilter) return false;

    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.manufacturer?.company_name || "").toLowerCase().includes(q)
    );
  });

  const currentAvail = Number(adjustProduct?.inventory?.available_quantity ?? 0);
  const resultingAvail = currentAvail + (Number(deltaStr) || 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inventory Management</h1>
        <p className="text-sm text-slate-500">
          Track available warehouse stock, customer-reserved units, sold totals, and low-stock alerts. Changes sync to Customer Portal immediately.
        </p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-medium text-slate-500">Available Stock Units</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatQty(totalAvailable)}</p>
            </div>
            <Boxes className="h-5 w-5 text-blue-700" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-medium text-slate-500">Reserved (Open Orders)</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatQty(totalReserved)}</p>
            </div>
            <ArrowUpDown className="h-5 w-5 text-slate-400" />
          </CardContent>
        </Card>
        <button type="button" onClick={() => setStockFilter("low_stock")} className="text-left">
          <Card className="transition-colors hover:border-amber-300">
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-medium text-amber-700">Low Stock Alerts</p>
                <p className="mt-1 text-2xl font-bold text-amber-700">{lowStockCount}</p>
              </div>
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </CardContent>
          </Card>
        </button>
        <button type="button" onClick={() => setStockFilter("out_of_stock")} className="text-left">
          <Card className="transition-colors hover:border-red-300">
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-medium text-red-700">Out of Stock SKUs</p>
                <p className="mt-1 text-2xl font-bold text-red-700">{outOfStockCount}</p>
              </div>
              <PackageX className="h-5 w-5 text-red-600" />
            </CardContent>
          </Card>
        </button>
      </div>

      <Tabs defaultValue="stock">
        <TabsList>
          <TabsTrigger value="stock">Live Stock Levels ({filteredProducts.length})</TabsTrigger>
          <TabsTrigger value="movements">Stock Movement History ({movements.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="space-y-4">
          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search SKU or product..."
                  className="pl-9"
                />
              </div>

              <Select value={stockFilter} onValueChange={setStockFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Stock Statuses</SelectItem>
                  <SelectItem value="in_stock">In Stock</SelectItem>
                  <SelectItem value="low_stock">Low Stock Alerts</SelectItem>
                  <SelectItem value="out_of_stock">Out of Stock</SelectItem>
                </SelectContent>
              </Select>

              <Select value={mfgFilter} onValueChange={setMfgFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Manufacturers</SelectItem>
                  {manufacturers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={catFilter} onValueChange={setCatFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product / SKU</TableHead>
                    <TableHead>Manufacturer</TableHead>
                    <TableHead>Available</TableHead>
                    <TableHead>Reserved</TableHead>
                    <TableHead>Sold Total</TableHead>
                    <TableHead>Alert At</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                        Loading inventory...
                      </TableCell>
                    </TableRow>
                  ) : filteredProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                        No matching inventory items.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredProducts.map((p) => {
                      const avail = Number(p.inventory?.available_quantity ?? 0);
                      const reserved = Number(p.inventory?.reserved_quantity ?? 0);
                      const sold = Number(p.inventory?.sold_quantity ?? 0);
                      const thresh = Number(p.inventory?.low_stock_threshold ?? 10);
                      const status = avail <= 0 ? "out_of_stock" : avail <= thresh ? "low_stock" : "in_stock";

                      return (
                        <TableRow key={p.id}>
                          <TableCell>
                            <p className="font-medium text-slate-900">{p.name}</p>
                            <p className="font-mono text-xs text-slate-500">
                              {p.sku} &bull; {p.category?.name}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs font-medium text-slate-700">
                            <Link to={`/admin/manufacturers/${p.manufacturer_id}`} className="hover:underline">
                              {p.manufacturer?.company_name}
                            </Link>
                          </TableCell>
                          <TableCell className="font-semibold text-slate-900">
                            {formatQty(avail)} {p.unit_of_measurement}
                          </TableCell>
                          <TableCell className="text-xs text-slate-600">{formatQty(reserved)}</TableCell>
                          <TableCell className="text-xs text-slate-600">{formatQty(sold)}</TableCell>
                          <TableCell className="text-xs text-slate-500">{formatQty(thresh)}</TableCell>
                          <TableCell>
                            <StatusBadge status={status} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="outline" size="sm" onClick={() => openAdjustModal(p)}>
                              Adjust Stock
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

        <TabsContent value="movements">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-blue-700" />
                Audit Trail of Inventory Movements
              </CardTitle>
              <CardDescription>Every restock, manual correction, order reservation, release, and delivery deduction.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Movement Type</TableHead>
                    <TableHead>Qty Delta</TableHead>
                    <TableHead>Balance After</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Recorded By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingMovements ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                        Loading movement history...
                      </TableCell>
                    </TableRow>
                  ) : movements.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                        No inventory movements logged yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    movements.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs text-slate-500">{formatDateTime(m.created_at)}</TableCell>
                        <TableCell>
                          <p className="font-medium text-slate-900">{m.products?.name || "—"}</p>
                          <p className="font-mono text-xs text-slate-500">{m.products?.sku}</p>
                        </TableCell>
                        <TableCell>
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-700">
                            {m.movement_type.replace("_", " ")}
                          </span>
                        </TableCell>
                        <TableCell
                          className={
                            Number(m.quantity_delta) > 0
                              ? "font-semibold text-emerald-700"
                              : Number(m.quantity_delta) < 0
                              ? "font-semibold text-red-700"
                              : "text-slate-500"
                          }
                        >
                          {Number(m.quantity_delta) > 0 ? `+${formatQty(m.quantity_delta)}` : formatQty(m.quantity_delta)}
                        </TableCell>
                        <TableCell className="font-semibold text-slate-900">
                          {formatQty(m.balance_after)} {m.products?.unit_of_measurement}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{m.notes || "—"}</TableCell>
                        <TableCell className="text-xs text-slate-500">{m.users?.full_name || "System"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Adjust Stock Modal */}
      <Dialog open={Boolean(adjustProduct)} onOpenChange={(o) => !o && setAdjustProduct(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Stock — {adjustProduct?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveAdjustment} className="space-y-4">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Current Available: <strong>{formatQty(currentAvail)} {adjustProduct?.unit_of_measurement}</strong> &bull;
              Resulting Available:{" "}
              <strong className={resultingAvail < 0 ? "text-red-700" : "text-blue-700"}>
                {formatQty(resultingAvail)} {adjustProduct?.unit_of_measurement}
              </strong>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Movement Type</Label>
                <Select value={movementType} onValueChange={(v) => setMovementType(v as "restock" | "manual_adjustment")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="restock">Manufacturer Restock (+)</SelectItem>
                    <SelectItem value="manual_adjustment">Manual Audit / Adjustment (+/-)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Quantity Delta (+/-)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={deltaStr}
                  onChange={(e) => setDeltaStr(e.target.value)}
                  placeholder="e.g. 50 or -10"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Low Stock Alert Threshold</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={thresholdStr}
                  onChange={(e) => setThresholdStr(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Reason / Note</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Physical stock count / damaged goods..."
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdjustProduct(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || resultingAvail < 0}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Apply Stock Update
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
