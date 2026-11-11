import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FileDown,
  PackageCheck,
  Upload,
  ExternalLink,
  Loader2,
  Factory,
  ShieldAlert,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { getManufacturerAssetSignedUrl, MANUFACTURER_INVOICE_ACCEPT, uploadStorageFile } from "@/lib/storage";
import { generatePurchaseOrderPdf } from "@/lib/pdfGenerator";
import { formatCurrency, formatDate, formatQty } from "@/lib/utils";
import {
  PO_STATUS_FLOW,
  type AgencySettings,
  type PurchaseOrderItemRecord,
  type PurchaseOrderRecord,
  type PurchaseOrderStatus,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [poStatus, setPoStatus] = useState<PurchaseOrderStatus>("Draft");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  const [addToInventoryOnReceive, setAddToInventoryOnReceive] = useState(true);
  const [receiving, setReceiving] = useState(false);

  const [mfgInvNo, setMfgInvNo] = useState("");
  const [mfgInvDate, setMfgInvDate] = useState("");
  const [mfgInvPath, setMfgInvPath] = useState("");
  const [signedInvUrl, setSignedInvUrl] = useState("");
  const [uploadingInv, setUploadingInv] = useState(false);
  const [savingInv, setSavingInv] = useState(false);

  const { data: po, isLoading } = useQuery({
    queryKey: ["admin-po-detail", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*, manufacturers(*), orders(id, order_number, order_status)")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as PurchaseOrderRecord;
    },
  });

  const { data: items = [] } = useQuery({
    queryKey: ["admin-po-items", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_order_items")
        .select("*")
        .eq("purchase_order_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as PurchaseOrderItemRecord[];
    },
  });

  const { data: agency } = useQuery({
    queryKey: ["agency-settings-read"],
    queryFn: async () => {
      const { data } = await supabase.from("agency_settings").select("*").eq("id", 1).single();
      return data as AgencySettings;
    },
  });

  useEffect(() => {
    if (!po) return;
    setPoStatus(po.status);
    setExpectedDate(po.expected_delivery_date || "");
    setNotes(po.notes || "");
    setMfgInvNo(po.manufacturer_invoice_number || "");
    setMfgInvDate(po.manufacturer_invoice_date || "");
    setMfgInvPath(po.manufacturer_invoice_url || "");
    setAddToInventoryOnReceive(!po.source_order_id);
  }, [po]);

  useEffect(() => {
    let active = true;
    async function signUrl() {
      if (!mfgInvPath) {
        setSignedInvUrl("");
        return;
      }
      const signed = await getManufacturerAssetSignedUrl(mfgInvPath);
      if (active) setSignedInvUrl(signed);
    }
    signUrl();
    return () => {
      active = false;
    };
  }, [mfgInvPath]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-po-detail", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-purchase-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-inventory"] });
    queryClient.invalidateQueries({ queryKey: ["admin-inventory-movements"] });
    queryClient.invalidateQueries({ queryKey: ["admin-order-linked-pos"] });
  };

  const handleSaveStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (poStatus === "Received" && po?.status !== "Received") {
      toast({
        title: "Use \"Mark Received\" below to finalize receipt & inventory sync",
        type: "info",
      });
      return;
    }
    setSavingStatus(true);
    try {
      const { error } = await supabase
        .from("purchase_orders")
        .update({
          status: poStatus,
          expected_delivery_date: expectedDate || null,
          notes: notes.trim() || null,
        })
        .eq("id", id);
      if (error) throw error;
      toast({ title: "Purchase order status updated", type: "success" });
      invalidateAll();
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingStatus(false);
    }
  };

  const handleReceivePo = async () => {
    if (!id) return;
    setReceiving(true);
    try {
      const { error } = await supabase.rpc("receive_purchase_order_stock", {
        p_po_id: id,
        p_add_to_inventory: addToInventoryOnReceive,
      });
      if (error) throw error;
      toast({
        title: "Purchase Order marked Received",
        description: addToInventoryOnReceive
          ? "Ordered quantities added to available warehouse inventory."
          : "Marked received without altering available stock.",
        type: "success",
      });
      invalidateAll();
    } catch (err) {
      toast({ title: "Could not receive PO", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setReceiving(false);
    }
  };

  const handleUploadMfgInvoice = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    setUploadingInv(true);
    try {
      const { path } = await uploadStorageFile("manufacturer-assets", `purchase-orders/${id}`, file);
      setMfgInvPath(path);
      const { error } = await supabase
        .from("purchase_orders")
        .update({ manufacturer_invoice_url: path })
        .eq("id", id);
      if (error) throw error;
      toast({ title: "Manufacturer invoice uploaded securely", type: "success" });
      invalidateAll();
    } catch (err) {
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      e.target.value = "";
      setUploadingInv(false);
    }
  };

  const handleSaveMfgInvoiceDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSavingInv(true);
    try {
      const { error } = await supabase
        .from("purchase_orders")
        .update({
          manufacturer_invoice_number: mfgInvNo.trim() || null,
          manufacturer_invoice_date: mfgInvDate || null,
        })
        .eq("id", id);
      if (error) throw error;
      toast({ title: "Manufacturer invoice details saved", type: "success" });
      invalidateAll();
    } catch (err) {
      toast({ title: "Could not save invoice record", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingInv(false);
    }
  };

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-500">Loading purchase order...</div>;
  if (!po) return <div className="py-12 text-center text-sm text-red-600">Purchase order not found.</div>;

  const isClosed = po.status === "Received" || po.status === "Cancelled";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/admin/purchase-orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" />
          Back to Purchase Orders
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={po.status} />
          <Button
            size="sm"
            onClick={() => {
              if (!agency || !po.manufacturers) {
                toast({
                  title: "Cannot generate PO PDF",
                  description: "Agency or manufacturer details are still loading.",
                  type: "error",
                });
                return;
              }
              generatePurchaseOrderPdf({
                agency,
                po,
                manufacturer: po.manufacturers,
                items,
                sourceOrderNumber: po.orders?.order_number ?? null,
              });
            }}
          >
            <FileDown className="h-4 w-4" />
            Download PO PDF
          </Button>
        </div>
      </div>

      {/* Staff-Managed Supplier Notice */}
      <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm sm:items-center">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-blue-700 sm:mt-0" />
        <span>
          <strong>Agency-Managed Procurement:</strong> Manufacturers do not log in to this platform. Staff dispatch PDFs externally and manually record supplier confirmations &amp; invoices here.
        </span>
      </div>

      {/* Summary + Manufacturer Info */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{po.po_number}</h1>
                <p className="mt-1 text-xs text-slate-500">
                  Created {formatDate(po.created_at)}
                  {po.orders && (
                    <>
                      {" "}
                      &bull; Source Customer Order:{" "}
                      <Link to={`/admin/orders/${po.orders.id}`} className="font-semibold text-blue-700 hover:underline">
                        {po.orders.order_number}
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-left sm:text-right">
                <p className="text-[11px] font-semibold uppercase text-slate-500">PO Grand Total (Mfg Cost)</p>
                <p className="text-xl font-bold text-slate-900">{formatCurrency(po.total_amount, sym)}</p>
                <p className="text-[11px] text-slate-500">
                  Sub: {formatCurrency(po.subtotal, sym)} + Tax: {formatCurrency(po.tax_total, sym)}
                </p>
              </div>
            </div>

            {po.manufacturers && (
              <div className="grid gap-2 border-t border-slate-100 pt-4 text-xs text-slate-600 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 sm:col-span-2">
                  <Factory className="h-4 w-4 text-blue-700" />
                  <Link to={`/admin/manufacturers/${po.manufacturer_id}`} className="hover:underline">
                    {po.manufacturers.company_name}
                  </Link>
                </div>
                <p>Contact: {po.manufacturers.contact_person} ({po.manufacturers.phone})</p>
                <p>Email: {po.manufacturers.email || "—"}</p>
                <p className="font-mono">GSTIN: {po.manufacturers.gst_number || "—"}</p>
                <p>Address: {[po.manufacturers.address, po.manufacturers.city, po.manufacturers.state].filter(Boolean).join(", ")}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Update Status Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fulfilment Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleSaveStatus} className="space-y-3">
              <div className="space-y-1.5">
                <Label>PO Status</Label>
                <Select
                  value={poStatus}
                  onValueChange={(v) => setPoStatus(v as PurchaseOrderStatus)}
                  disabled={isClosed}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PO_STATUS_FLOW.filter((s) => s !== "Received" || po.status === "Received").map((st) => (
                      <SelectItem key={st} value={st}>
                        {st}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Expected Delivery</Label>
                <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={isClosed} />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={isClosed} />
              </div>
              <Button type="submit" className="w-full" disabled={savingStatus || isClosed}>
                {savingStatus && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Fulfilment Update
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* PO Line Items */}
      <Card>
        <CardHeader>
          <CardTitle>Ordered Products at Original Manufacturer Prices ({items.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-slate-100 md:hidden">
            {items.map((it) => (
              <div key={it.id} className="space-y-2 p-4 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{it.product_name_snapshot}</p>
                    <p className="font-mono text-slate-500">{it.sku_snapshot}</p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-slate-900">{formatCurrency(it.line_total, sym)}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-100 bg-slate-50 p-2.5">
                  <div>
                    <span className="text-slate-500">Qty: </span>
                    <strong>
                      {formatQty(it.quantity)} {it.unit_snapshot}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Unit Cost: </span>
                    <strong>{formatCurrency(it.unit_manufacturer_price, sym)}</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">GST %: </span>
                    <strong>{it.gst_rate}%</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Tax: </span>
                    <strong>{formatCurrency(it.tax_amount, sym)}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product &amp; SKU</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Mfg Unit Price</TableHead>
                  <TableHead>GST %</TableHead>
                  <TableHead>Tax Amount</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      <p className="font-medium text-slate-900">{it.product_name_snapshot}</p>
                      <p className="font-mono text-xs text-slate-500">{it.sku_snapshot}</p>
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatQty(it.quantity)} {it.unit_snapshot}
                    </TableCell>
                    <TableCell>{formatCurrency(it.unit_manufacturer_price, sym)}</TableCell>
                    <TableCell className="text-xs text-slate-600">{it.gst_rate}%</TableCell>
                    <TableCell className="text-xs text-slate-600">{formatCurrency(it.tax_amount, sym)}</TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">
                      {formatCurrency(it.line_total, sym)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Mark Received & Manufacturer Invoice Upload */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <PackageCheck className="h-4 w-4 text-emerald-700" />
              Goods Receipt &amp; Inventory Restock
            </CardTitle>
            <CardDescription>
              Finalize receipt when items arrive from {po.manufacturers?.company_name}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isClosed ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                This purchase order is marked <strong>{po.status}</strong>.
              </div>
            ) : (
              <>
                <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3.5">
                  <Switch checked={addToInventoryOnReceive} onCheckedChange={setAddToInventoryOnReceive} />
                  <div className="text-xs">
                    <p className="font-semibold text-slate-800">Add PO quantities into available warehouse inventory</p>
                    <p className="mt-0.5 text-slate-500">
                      {po.source_order_id
                        ? "Note: Customer order items already reserved stock on checkout. Turn ON only if receiving replenishment stock into general available inventory."
                        : "Recommended ON for manual restock POs so stock immediately reflects in Inventory & Customer Portal."}
                    </p>
                  </div>
                </div>
                <Button onClick={handleReceivePo} disabled={receiving} className="w-full">
                  {receiving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Mark PO as Received
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record Manufacturer Invoice (Payables)</CardTitle>
            <CardDescription>Log supplier bill number, date, and upload confidential bill scan/PDF.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleSaveMfgInvoiceDetails} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Mfg Invoice Number</Label>
                  <Input
                    value={mfgInvNo}
                    onChange={(e) => setMfgInvNo(e.target.value)}
                    placeholder="e.g. ABC/26-27/0412"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Mfg Invoice Date</Label>
                  <Input type="date" value={mfgInvDate} onChange={(e) => setMfgInvDate(e.target.value)} />
                </div>
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={savingInv}>
                {savingInv && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Manufacturer Invoice Record
              </Button>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                {uploadingInv ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                <span>{mfgInvPath ? "Replace Mfg Invoice File" : "Upload Mfg Invoice (PDF/Image)"}</span>
                <input type="file" accept={MANUFACTURER_INVOICE_ACCEPT} className="hidden" onChange={handleUploadMfgInvoice} />
              </label>

              {signedInvUrl && (
                <a
                  href={signedInvUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
                >
                  View Uploaded Document <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
