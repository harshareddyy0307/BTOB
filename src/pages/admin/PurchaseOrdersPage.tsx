import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Plus, Search, Trash2, Loader2, Eye, FileDown } from "lucide-react";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { generatePurchaseOrderPdf } from "@/lib/pdfGenerator";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  PO_STATUS_FLOW,
  type AdminProduct,
  type AgencySettings,
  type Manufacturer,
  type PurchaseOrderItemRecord,
  type PurchaseOrderRecord,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

interface DraftPoLine {
  uid: string;
  product_id: string;
  quantity: string;
  unit_manufacturer_price: string;
}

export function PurchaseOrdersPage() {
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [mfgFilter, setMfgFilter] = useState("all");

  // Manual PO creation modal
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedMfgId, setSelectedMfgId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftPoLine[]>([]);
  const [creating, setCreating] = useState(false);

  const { data: purchaseOrders = [], isLoading } = useQuery({
    queryKey: ["admin-purchase-orders"],
    queryFn: async () =>
      fetchAllRows<PurchaseOrderRecord>((from, to) =>
        supabase
          .from("purchase_orders")
          .select("*, manufacturers(*), orders(id, order_number, order_status)")
          .order("created_at", { ascending: false })
          .range(from, to)
      ),
  });

  const { data: manufacturers = [] } = useQuery({
    queryKey: ["admin-manufacturers-active-po"],
    queryFn: async () =>
      fetchAllRows<Manufacturer>((from, to) =>
        supabase.from("manufacturers").select("*").eq("status", "active").order("company_name").range(from, to)
      ),
  });

  const { data: mfgProducts = [] } = useQuery({
    queryKey: ["admin-po-mfg-products", selectedMfgId],
    enabled: Boolean(createOpen && selectedMfgId),
    queryFn: async () =>
      fetchAllRows<AdminProduct>((from, to) =>
        supabase
          .from("products")
          .select("*, product_prices(*)")
          .eq("manufacturer_id", selectedMfgId)
          .eq("status", "active")
          .order("name")
          .range(from, to)
      ),
  });

  const { data: agency } = useQuery({
    queryKey: ["agency-settings-read"],
    queryFn: async () => {
      const { data } = await supabase.from("agency_settings").select("*").eq("id", 1).single();
      return data as AgencySettings;
    },
  });

  const openManualModal = () => {
    const firstMfg = manufacturers[0]?.id || "";
    setSelectedMfgId(firstMfg);
    setExpectedDate("");
    setNotes("");
    setLines([]);
    setCreateOpen(true);
  };

  const handleManufacturerChange = (nextId: string) => {
    setSelectedMfgId(nextId);
    setLines([]);
  };

  const addDraftLine = () => {
    const unused = mfgProducts.find((p) => !lines.some((l) => l.product_id === p.id)) || mfgProducts[0];
    if (!unused) {
      toast({ title: "Selected manufacturer has no active products yet", type: "error" });
      return;
    }
    const defaultCost = unused.product_prices?.draft_manufacturer_price ?? unused.product_prices?.published_manufacturer_price ?? 0;
    const uid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setLines((prev) => [
      ...prev,
      {
        uid,
        product_id: unused.id,
        quantity: String(unused.min_order_quantity || 1),
        unit_manufacturer_price: String(defaultCost),
      },
    ]);
  };

  const updateLine = (idx: number, patch: Partial<DraftPoLine>) => {
    setLines((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const updated = { ...row, ...patch };
        if (patch.product_id) {
          const prod = mfgProducts.find((p) => p.id === patch.product_id);
          if (prod) {
            updated.unit_manufacturer_price = String(
              prod.product_prices?.draft_manufacturer_price ?? prod.product_prices?.published_manufacturer_price ?? 0
            );
          }
        }
        return updated;
      })
    );
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const productMap = new Map(mfgProducts.map((p) => [p.id, p]));
  let draftSub = 0;
  let draftTax = 0;
  lines.forEach((l) => {
    const prod = productMap.get(l.product_id);
    const q = Math.max(0, Number(l.quantity) || 0);
    const price = Math.max(0, Number(l.unit_manufacturer_price) || 0);
    const sub = Math.round(q * price * 100) / 100;
    const tax = Math.round(((sub * Number(prod?.gst_rate ?? 0)) / 100) * 100) / 100;
    draftSub += sub;
    draftTax += tax;
  });
  const draftTotal = Math.round((draftSub + draftTax) * 100) / 100;

  const handleCreateManualPo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMfgId || lines.length === 0) {
      toast({ title: "Select a manufacturer and add at least one product line", type: "error" });
      return;
    }
    setCreating(true);
    try {
      const payloadItems = lines.map((l) => ({
        product_id: l.product_id,
        quantity: Number(l.quantity),
        unit_manufacturer_price: Number(l.unit_manufacturer_price),
      }));

      const { data, error } = await supabase.rpc("create_manual_purchase_order", {
        p_manufacturer_id: selectedMfgId,
        p_items: payloadItems,
        p_expected_delivery_date: expectedDate || null,
        p_notes: notes.trim() || null,
      });
      if (error) throw error;

      const created = data as { po_id: string; po_number: string };
      toast({ title: `Purchase Order ${created.po_number} created`, type: "success" });
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-purchase-orders"] });
      navigate(`/admin/purchase-orders/${created.po_id}`);
    } catch (err) {
      toast({ title: "Failed to create Purchase Order", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setCreating(false);
    }
  };

  const handleDownloadPdf = async (po: PurchaseOrderRecord) => {
    if (!agency || !po.manufacturers) {
      toast({
        title: "Cannot generate PO PDF",
        description: !agency ? "Agency settings are still loading." : "Manufacturer record is missing.",
        type: "error",
      });
      return;
    }
    const { data: items, error } = await supabase
      .from("purchase_order_items")
      .select("*")
      .eq("purchase_order_id", po.id)
      .order("created_at");
    if (error) {
      toast({ title: "Could not load PO items for PDF", description: error.message, type: "error" });
      return;
    }
    generatePurchaseOrderPdf({
      agency,
      po,
      manufacturer: po.manufacturers,
      items: (items ?? []) as PurchaseOrderItemRecord[],
      sourceOrderNumber: po.orders?.order_number ?? null,
    });
  };

  const filtered = purchaseOrders.filter((po) => {
    if (statusFilter !== "all" && po.status !== statusFilter) return false;
    if (mfgFilter !== "all" && po.manufacturer_id !== mfgFilter) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      po.po_number.toLowerCase().includes(q) ||
      (po.manufacturers?.company_name || "").toLowerCase().includes(q) ||
      (po.orders?.order_number || "").toLowerCase().includes(q) ||
      (po.manufacturer_invoice_number || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">Purchase Orders</h1>
          <p className="text-sm text-slate-500">
            Internal manufacturer procurement documents (at original cost prices). Staff manage all supplier updates manually.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={openManualModal}>
          <Plus className="h-4 w-4" />
          Generate Manual Purchase Order
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PO #, manufacturer, order #, invoice #..."
              className="pl-9"
            />
          </div>

          <Select value={mfgFilter} onValueChange={setMfgFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Manufacturers" />
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

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All PO Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All PO Statuses</SelectItem>
              {PO_STATUS_FLOW.map((st) => (
                <SelectItem key={st} value={st}>
                  {st}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-blue-700" />
            Manufacturer Purchase Orders ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-slate-100 md:hidden">
            {isLoading ? (
              <p className="py-10 text-center text-sm text-slate-500">Loading purchase orders...</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                No purchase orders found. Split a customer order or click &ldquo;Generate Manual Purchase Order&rdquo;.
              </p>
            ) : (
              filtered.map((po) => (
                <div key={po.id} className="space-y-2.5 p-4 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/admin/purchase-orders/${po.id}`}
                        className="text-sm font-semibold text-blue-700 hover:underline"
                      >
                        {po.po_number}
                      </Link>
                      <p className="text-slate-500">{formatDate(po.created_at)}</p>
                    </div>
                    <StatusBadge status={po.status} />
                  </div>

                  <div>
                    <Link
                      to={`/admin/manufacturers/${po.manufacturer_id}`}
                      className="text-sm font-medium text-slate-900 hover:underline"
                    >
                      {po.manufacturers?.company_name}
                    </Link>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50 p-2.5">
                    <div>
                      <span className="text-slate-500">Source: </span>
                      {po.orders ? (
                        <Link to={`/admin/orders/${po.orders.id}`} className="font-mono font-semibold text-blue-700 hover:underline">
                          {po.orders.order_number}
                        </Link>
                      ) : (
                        <span className="text-slate-600">Manual Restock</span>
                      )}
                      {po.manufacturer_invoice_number && (
                        <p className="mt-0.5 text-slate-500">
                          Mfg Inv: <span className="font-mono text-slate-700">{po.manufacturer_invoice_number}</span>
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="block text-[11px] text-slate-500">PO Total</span>
                      <span className="text-sm font-bold text-slate-900">{formatCurrency(po.total_amount, sym)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownloadPdf(po)}
                    >
                      <FileDown className="h-3.5 w-3.5 text-slate-600" />
                      PO PDF
                    </Button>
                    <Link
                      to={`/admin/purchase-orders/${po.id}`}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Manage
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO Number</TableHead>
                  <TableHead>Manufacturer</TableHead>
                  <TableHead>Source Order</TableHead>
                  <TableHead>Mfg Invoice</TableHead>
                  <TableHead>PO Total (Cost)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                      Loading purchase orders...
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                      No purchase orders found. Split a customer order or click &ldquo;Generate Manual Purchase Order&rdquo;.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell>
                        <Link to={`/admin/purchase-orders/${po.id}`} className="font-semibold text-blue-700 hover:underline">
                          {po.po_number}
                        </Link>
                        <p className="text-xs text-slate-500">{formatDate(po.created_at)}</p>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/admin/manufacturers/${po.manufacturer_id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {po.manufacturers?.company_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">
                        {po.orders ? (
                          <Link to={`/admin/orders/${po.orders.id}`} className="font-mono font-semibold text-blue-700 hover:underline">
                            {po.orders.order_number}
                          </Link>
                        ) : (
                          <span className="text-slate-500">Manual Restock</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {po.manufacturer_invoice_number ? (
                          <span className="font-mono font-medium text-slate-800">{po.manufacturer_invoice_number}</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="font-semibold text-slate-900">{formatCurrency(po.total_amount, sym)}</TableCell>
                      <TableCell>
                        <StatusBadge status={po.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDownloadPdf(po)}
                            title="Download PO PDF"
                          >
                            <FileDown className="h-4 w-4 text-slate-600" />
                          </Button>
                          <Link
                            to={`/admin/purchase-orders/${po.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Manage
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Manual PO Creation Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Generate Manual Manufacturer Purchase Order</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateManualPo} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Select Manufacturer *</Label>
                <Select value={selectedMfgId} onValueChange={handleManufacturerChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose manufacturer" />
                  </SelectTrigger>
                  <SelectContent>
                    {manufacturers.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.company_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Expected Delivery Date</Label>
                <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Products from Manufacturer</Label>
                <Button type="button" variant="outline" size="sm" onClick={addDraftLine} disabled={!selectedMfgId}>
                  <Plus className="h-3.5 w-3.5" />
                  Add Product Line
                </Button>
              </div>

              {lines.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">
                  {mfgProducts.length === 0
                    ? "Selected manufacturer has no active products."
                    : "Click \"Add Product Line\" to include items in this Purchase Order."}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {lines.map((line, idx) => {
                    const prod = productMap.get(line.product_id);
                    const sub = (Number(line.quantity) || 0) * (Number(line.unit_manufacturer_price) || 0);
                    return (
                      <div
                        key={line.uid}
                        className="grid grid-cols-2 items-center gap-2 rounded-md border bg-slate-50/70 p-2.5 sm:grid-cols-12 sm:p-2"
                      >
                        <div className="col-span-2 sm:col-span-5">
                          <select
                            value={line.product_id}
                            onChange={(e) => updateLine(idx, { product_id: e.target.value })}
                            className="h-9 w-full min-w-0 rounded-md border border-input bg-white px-2 text-xs"
                          >
                            {mfgProducts.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.sku})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-slate-500 sm:hidden">Qty</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0.01"
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                            placeholder="Qty"
                            className="h-9 text-xs"
                            required
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <span className="mb-1 block text-[11px] font-medium text-slate-500 sm:hidden">Mfg Price</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.unit_manufacturer_price}
                            onChange={(e) => updateLine(idx, { unit_manufacturer_price: e.target.value })}
                            placeholder="Mfg Price"
                            className="h-9 text-xs"
                            required
                          />
                        </div>
                        <div className="flex items-center justify-between sm:col-span-3 sm:justify-end sm:gap-2">
                          <div className="text-left text-xs font-semibold text-slate-800 sm:text-right">
                            {formatCurrency(sub, sym)}
                            <span className="block text-[10px] font-normal text-slate-500">+{prod?.gst_rate ?? 0}% GST</span>
                          </div>
                          <Button type="button" variant="ghost" size="icon" className="text-red-600" onClick={() => removeLine(idx)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>PO Notes / Dispatch Instructions</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Packaging, delivery warehouse address, credit terms..." />
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                <span>Subtotal: {formatCurrency(draftSub, sym)}</span>
                <span>GST: {formatCurrency(draftTax, sym)}</span>
              </div>
              <div className="font-bold text-slate-900">Purchase Total: {formatCurrency(draftTotal, sym)}</div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || lines.length === 0}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Purchase Order
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
