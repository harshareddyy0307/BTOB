import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Factory,
  FileSpreadsheet,
  ReceiptIndianRupee,
  FileDown,
  Loader2,
  MapPin,
  Split,
  IndianRupee,
  BellRing,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { generateCustomerInvoicePdf } from "@/lib/pdfGenerator";
import { cn, formatCurrency, formatDate, formatDateTime, formatQty } from "@/lib/utils";
import {
  ALL_ORDER_STATUSES,
  type AgencySettings,
  type CustomerProfile,
  type InvoiceRecord,
  type NotificationRecord,
  type OrderItemFinancialRecord,
  type OrderItemRecord,
  type OrderRecord,
  type OrderStatus,
  type PaymentRecord,
  type PurchaseOrderRecord,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";
import {
  OrderPaymentModal,
  parsePaymentClaimNotification,
  type OrderPaymentTarget,
  type PaymentPrefill,
} from "@/components/admin/OrderPaymentModal";

interface DetailedOrderItem extends OrderItemRecord {
  order_item_financials: OrderItemFinancialRecord | OrderItemFinancialRecord[] | null;
  purchase_order_items:
    | { id: string; purchase_order_id: string; purchase_orders: { id: string; po_number: string } | null }[]
    | null;
}

export function AdminOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [nextStatus, setNextStatus] = useState<OrderStatus>("Pending");
  const [statusNote, setStatusNote] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  const [paymentModal, setPaymentModal] = useState<{
    order: OrderPaymentTarget;
    prefill?: PaymentPrefill | null;
  } | null>(null);

  const { data: order, isLoading } = useQuery({
    queryKey: ["admin-order-detail", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*, customers(*)")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as OrderRecord & { customers: CustomerProfile };
    },
  });

  useEffect(() => {
    if (order?.order_status) {
      setNextStatus(order.order_status);
    }
  }, [order?.order_status]);

  const { data: items = [] } = useQuery({
    queryKey: ["admin-order-items", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_items")
        .select(
          "*, order_item_financials(*), purchase_order_items(id, purchase_order_id, purchase_orders(id, po_number))"
        )
        .eq("order_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as DetailedOrderItem[];
    },
  });

  const { data: linkedPos = [] } = useQuery({
    queryKey: ["admin-order-linked-pos", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*, manufacturers(id, company_name, phone)")
        .eq("source_order_id", id!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PurchaseOrderRecord[];
    },
  });

  const { data: invoice } = useQuery({
    queryKey: ["admin-order-invoice", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase.from("invoices").select("*").eq("order_id", id!).maybeSingle();
      return (data as InvoiceRecord | null) ?? null;
    },
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["admin-invoice-payments", invoice?.id],
    enabled: Boolean(invoice?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("payments")
        .select("*")
        .eq("invoice_id", invoice!.id)
        .order("payment_date", { ascending: false })
        .order("created_at", { ascending: false });
      return (data ?? []) as PaymentRecord[];
    },
  });

  const { data: paymentClaims = [], refetch: refetchClaims } = useQuery({
    queryKey: ["admin-order-payment-claims", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .eq("entity_type", "order_payment_claim")
        .eq("entity_id", id!)
        .eq("is_read", false)
        .order("created_at", { ascending: false });
      return (data ?? []) as NotificationRecord[];
    },
  });

  const { data: agency } = useQuery({
    queryKey: ["agency-settings-read"],
    queryFn: async () => {
      const { data } = await supabase.from("agency_settings").select("*").eq("id", 1).single();
      return data as AgencySettings;
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-order-detail", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-order-items", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-order-linked-pos", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-order-invoice", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-invoice-payments", invoice?.id] });
    queryClient.invalidateQueries({ queryKey: ["admin-order-payment-claims", id] });
    queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-daily-operations"] });
    queryClient.invalidateQueries({ queryKey: ["admin-purchase-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] });
    queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
  };

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !nextStatus) return;
    setUpdatingStatus(true);
    try {
      const { error } = await supabase.rpc("update_order_status_admin", {
        p_order_id: id,
        p_new_status: nextStatus,
        p_notes: statusNote.trim() || null,
      });
      if (error) throw error;
      toast({ title: `Order status changed to "${nextStatus}"`, type: "success" });
      setStatusNote("");
      invalidateAll();
    } catch (err) {
      toast({ title: "Status update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleSplitToPurchaseOrders = async () => {
    if (!id) return;
    setSplitting(true);
    try {
      const { data, error } = await supabase.rpc("split_order_to_purchase_orders", { p_order_id: id });
      if (error) throw error;
      const created = Array.isArray(data) ? data : [];
      if (created.length === 0) {
        toast({ title: "All ordered products already have linked Purchase Orders", type: "info" });
      } else {
        toast({
          title: `Created ${created.length} Manufacturer Purchase Order(s)`,
          description: created
            .map((c: { po_number: string; manufacturer_name: string }) => `${c.po_number} → ${c.manufacturer_name}`)
            .join(" | "),
          type: "success",
        });
      }
      invalidateAll();
    } catch (err) {
      toast({ title: "Could not split order into POs", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSplitting(false);
    }
  };

  const handleGenerateInvoice = async () => {
    if (!id) return;
    setGeneratingInvoice(true);
    try {
      const { error } = await supabase.rpc("generate_customer_invoice", {
        p_order_id: id,
        p_due_days: 15,
      });
      if (error) throw error;
      toast({ title: "Customer GST Tax Invoice generated", type: "success" });
      invalidateAll();
    } catch (err) {
      toast({ title: "Could not generate invoice", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setGeneratingInvoice(false);
    }
  };

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-500">Loading order details...</div>;
  if (!order) return <div className="py-12 text-center text-sm text-red-600">Order not found.</div>;

  const isTerminal = order.order_status === "Delivered" || order.order_status === "Cancelled";
  const addr = order.delivery_address;
  const paidAmt = Number(order.paid_amount ?? 0);
  const dueAmt =
    order.order_status === "Cancelled" ? 0 : Math.max(0, Number(order.due_amount ?? Number(order.total_amount) - paidAmt));
  const activePayments = payments.filter((p) => p.status !== "voided");

  let totalMfgCost = 0;
  let totalGrossMargin = 0;
  let unallocatedCount = 0;
  const distinctMfgIds = new Set<string>();

  items.forEach((it) => {
    const fin = Array.isArray(it.order_item_financials) ? it.order_item_financials[0] : it.order_item_financials;
    if (fin) {
      totalMfgCost += Number(fin.unit_manufacturer_price) * Number(it.quantity);
      totalGrossMargin += Number(fin.margin_amount_total);
      distinctMfgIds.add(fin.manufacturer_id);
    }
    if (!it.purchase_order_items || it.purchase_order_items.length === 0) {
      unallocatedCount++;
    }
  });

  const openOrderPayment = (prefill?: PaymentPrefill) => {
    setPaymentModal({
      order: {
        id: order.id,
        order_number: order.order_number,
        customer_name: order.customers?.business_name || "Customer",
        total_amount: Number(order.total_amount),
        paid_amount: paidAmt,
        due_amount: dueAmt,
        payment_status: order.payment_status,
        order_status: order.order_status,
      },
      prefill: prefill ?? null,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/admin/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" />
          Back to Order Management
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.order_status} />
          <StatusBadge status={order.payment_status} />
          {order.order_status !== "Cancelled" && (
            <Button size="sm" variant={dueAmt > 0 ? "default" : "outline"} onClick={() => openOrderPayment()}>
              <IndianRupee className="h-3.5 w-3.5" />
              {dueAmt > 0 ? "Mark Paid / Partial" : "Update Payment"}
            </Button>
          )}
        </div>
      </div>

      {/* Customer Payment Alert Banner if customer notified agency */}
      {paymentClaims.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/80">
          <CardContent className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-2.5">
              <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <div className="space-y-0.5">
                <p className="text-sm font-bold text-amber-950">{paymentClaims[0].title}</p>
                <p className="text-xs text-amber-900">{paymentClaims[0].message}</p>
              </div>
            </div>
            {order.order_status !== "Cancelled" && (
              <Button
                size="sm"
                onClick={() => openOrderPayment(parsePaymentClaimNotification(paymentClaims[0].message))}
              >
                Verify &amp; Apply Payment
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Top Overview + Controls */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-5 p-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{order.order_number}</h1>
                <p className="mt-1 text-xs text-slate-500">Placed on {formatDateTime(order.placed_at)}</p>
                <p className="mt-2 text-sm text-slate-700">
                  Customer:{" "}
                  <Link to={`/admin/customers/${order.customer_id}`} className="font-semibold text-blue-700 hover:underline">
                    {order.customers?.business_name}
                  </Link>{" "}
                  &bull; GSTIN: <span className="font-mono">{order.customers?.gst_number || "Unregistered"}</span>
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-right space-y-1">
                <p className="text-[11px] font-semibold uppercase text-slate-500">Customer Grand Total</p>
                <p className="text-xl font-bold text-slate-900">{formatCurrency(order.total_amount, sym)}</p>
                <p className="text-xs font-medium text-emerald-700">
                  Paid: {formatCurrency(paidAmt, sym)} &bull; Gross Margin: +{formatCurrency(totalGrossMargin, sym)}
                </p>
                <p className={cn("text-sm font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                  {order.order_status === "Cancelled"
                    ? "Order Cancelled"
                    : `Amount Due: ${formatCurrency(dueAmt, sym)}`}
                </p>
              </div>
            </div>

            <div className="grid gap-4 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500">
                  <MapPin className="h-3.5 w-3.5 text-blue-700" />
                  Delivery Destination
                </p>
                <p className="font-medium text-slate-900">
                  {addr?.contact_name || order.customers?.owner_name} ({addr?.contact_phone || order.customers?.phone})
                </p>
                <p className="text-xs text-slate-600">
                  {[addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", ")}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase text-slate-500">Order Notes</p>
                <p className="text-xs text-slate-600">{order.notes || "No delivery instructions noted."}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Status Control */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Update Delivery Status</CardTitle>
            <CardDescription>Notifies the customer immediately in their portal.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleStatusUpdate} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Order Status</Label>
                <Select
                  value={nextStatus}
                  onValueChange={(v) => setNextStatus(v as OrderStatus)}
                  disabled={isTerminal}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_ORDER_STATUSES.map((st) => (
                      <SelectItem key={st} value={st}>
                        {st}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Tracking / Dispatch Note</Label>
                <Input
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="Vehicle no., LR#, expected ETA..."
                  disabled={isTerminal}
                />
              </div>
              <Button type="submit" className="w-full" disabled={updatingStatus || isTerminal}>
                {updatingStatus && <Loader2 className="h-4 w-4 animate-spin" />}
                {isTerminal ? `Locked (${order.order_status})` : "Save Status"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Product Breakdown WITH Internal Manufacturer Cost & Margin */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Factory className="h-4 w-4 text-blue-700" />
              Ordered Products &amp; Manufacturer Allocation ({items.length})
            </CardTitle>
            <CardDescription>
              Spans {distinctMfgIds.size} manufacturer(s) &bull; Internal Cost Total: {formatCurrency(totalMfgCost, sym)} (Excl. GST)
            </CardDescription>
          </div>
          <Button
            onClick={handleSplitToPurchaseOrders}
            disabled={splitting || unallocatedCount === 0 || order.order_status === "Cancelled"}
          >
            {splitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />}
            {unallocatedCount > 0
              ? `Split & Generate Purchase Orders (${distinctMfgIds.size} Mfg)`
              : "All Products Linked to POs"}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product / SKU</TableHead>
                <TableHead>Manufacturer (Admin)</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Mfg Price</TableHead>
                <TableHead>Margin</TableHead>
                <TableHead>Cust. Selling</TableHead>
                <TableHead>GST</TableHead>
                <TableHead>Line Total</TableHead>
                <TableHead>Linked PO</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const fin = Array.isArray(item.order_item_financials)
                  ? item.order_item_financials[0]
                  : item.order_item_financials;
                const linkedPoi = item.purchase_order_items?.[0];

                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <p className="font-medium text-slate-900">{item.product_name_snapshot}</p>
                      <p className="font-mono text-xs text-slate-500">{item.sku_snapshot}</p>
                    </TableCell>
                    <TableCell>
                      {fin ? (
                        <Link
                          to={`/admin/manufacturers/${fin.manufacturer_id}`}
                          className="text-xs font-semibold text-blue-700 hover:underline"
                        >
                          {fin.manufacturer_name_snapshot}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {formatQty(item.quantity)} {item.unit_snapshot}
                    </TableCell>
                    <TableCell className="text-xs text-slate-700">
                      {fin ? formatCurrency(fin.unit_manufacturer_price, sym) : "—"}
                    </TableCell>
                    <TableCell className="text-xs font-medium text-emerald-700">
                      {fin ? `${fin.margin_percentage_snapshot}% (+${formatCurrency(fin.margin_amount_total, sym)})` : "—"}
                    </TableCell>
                    <TableCell className="font-medium">{formatCurrency(item.unit_selling_price, sym)}</TableCell>
                    <TableCell className="text-xs text-slate-500">{item.gst_rate}%</TableCell>
                    <TableCell className="font-semibold text-slate-900">{formatCurrency(item.line_total, sym)}</TableCell>
                    <TableCell>
                      {linkedPoi?.purchase_orders ? (
                        <Link
                          to={`/admin/purchase-orders/${linkedPoi.purchase_orders.id}`}
                          className="font-mono text-xs font-semibold text-blue-700 hover:underline"
                        >
                          {linkedPoi.purchase_orders.po_number}
                        </Link>
                      ) : (
                        <span className="text-xs text-amber-700">Unassigned</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Split Purchase Orders + Order Payment & GST Invoice */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-4 w-4 text-blue-700" />
              Manufacturer Purchase Orders ({linkedPos.length})
            </CardTitle>
            <CardDescription>
              Customer sees one unified order while procurement splits cleanly per manufacturer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {linkedPos.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">
                No purchase orders generated yet. Click &ldquo;Split &amp; Generate Purchase Orders&rdquo; above.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {linkedPos.map((po) => (
                  <div key={po.id} className="flex items-center justify-between py-3">
                    <div>
                      <Link to={`/admin/purchase-orders/${po.id}`} className="font-semibold text-blue-700 hover:underline">
                        {po.po_number}
                      </Link>
                      <p className="text-xs text-slate-500">{po.manufacturers?.company_name}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={po.status} />
                      <span className="text-sm font-semibold">{formatCurrency(po.total_amount, sym)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ReceiptIndianRupee className="h-4 w-4 text-blue-700" />
                Order Payments &amp; GST Invoice
              </CardTitle>
              <CardDescription>
                Mark Paid, Unpaid, or Partially Paid directly here or review GST tax invoice.
              </CardDescription>
            </div>
            {order.order_status !== "Cancelled" && (
              <Button size="sm" variant={dueAmt > 0 ? "default" : "outline"} onClick={() => openOrderPayment()}>
                Update Payment
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Live Order Payment Due Box */}
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <div>
                <p className="text-slate-500">Order Total</p>
                <p className="mt-0.5 text-sm font-bold text-slate-900">{formatCurrency(order.total_amount, sym)}</p>
              </div>
              <div>
                <p className="text-slate-500">Total Paid</p>
                <p className="mt-0.5 text-sm font-bold text-emerald-700">{formatCurrency(paidAmt, sym)}</p>
              </div>
              <div>
                <p className="text-slate-500">Remaining Due</p>
                <p className={cn("mt-0.5 text-sm font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                  {formatCurrency(dueAmt, sym)}
                </p>
              </div>
            </div>

            {invoice ? (
              <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-base font-bold text-slate-900">{invoice.invoice_number}</p>
                    <p className="text-xs text-slate-500">
                      Issued {formatDate(invoice.invoice_date)} &bull; Due {formatDate(invoice.due_date)}
                    </p>
                  </div>
                  <StatusBadge status={invoice.payment_status} />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1 text-xs text-slate-700">
                  <p>Taxable Subtotal: {formatCurrency(invoice.subtotal, sym)}</p>
                  <p>
                    {invoice.is_inter_state
                      ? `IGST: ${formatCurrency(invoice.igst_amount, sym)}`
                      : `CGST ${formatCurrency(invoice.cgst_amount, sym)} + SGST ${formatCurrency(invoice.sgst_amount, sym)}`}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  {agency && order.customers && (
                    <Button
                      size="sm"
                      onClick={() =>
                        generateCustomerInvoicePdf({
                          agency,
                          invoice,
                          customer: order.customers,
                          order,
                          items,
                          payments: activePayments,
                        })
                      }
                    >
                      <FileDown className="h-4 w-4" />
                      Download Invoice PDF
                    </Button>
                  )}
                  <Link to="/admin/invoices">
                    <Button size="sm" variant="outline">
                      Open All Invoices
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-dashed border-slate-200 py-4 text-center">
                <p className="text-xs text-slate-500">
                  No tax invoice generated yet. Recording a payment will auto-generate the GST invoice, or issue one manually:
                </p>
                <Button size="sm" variant="outline" onClick={handleGenerateInvoice} disabled={generatingInvoice || order.order_status === "Cancelled"}>
                  {generatingInvoice && <Loader2 className="h-4 w-4 animate-spin" />}
                  Generate GST Tax Invoice Now
                </Button>
              </div>
            )}

            {/* Payment History Ledger */}
            {payments.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Payment Ledger ({payments.length})
                </p>
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className={cn(
                        "flex items-center justify-between px-3 py-2 text-xs",
                        p.status === "voided" && "bg-slate-50 opacity-60 line-through"
                      )}
                    >
                      <div>
                        <p className="font-medium text-slate-900">
                          {p.payment_method} {p.reference_number ? `(${p.reference_number})` : ""}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {formatDate(p.payment_date)}
                          {p.notes ? ` • ${p.notes}` : ""}
                        </p>
                      </div>
                      <span className="font-semibold text-emerald-700">
                        {p.status === "voided" ? "Voided" : formatCurrency(p.amount, sym)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <OrderPaymentModal
        order={paymentModal?.order ?? null}
        prefill={paymentModal?.prefill ?? null}
        onClose={() => {
          setPaymentModal(null);
          refetchClaims();
        }}
      />
    </div>
  );
}
