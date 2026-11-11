import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  CheckCircle2,
  FileSpreadsheet,
  Truck,
  ArrowRight,
  Clock,
  PackageCheck,
  XCircle,
  Loader2,
  IndianRupee,
  BellRing,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatSignedCurrency } from "@/lib/pricing";
import { cn, formatCurrency, formatDateTime, formatQty } from "@/lib/utils";
import type { NotificationRecord, OrderStatus, PaymentStatus } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";
import {
  OrderPaymentModal,
  parsePaymentClaimNotification,
  type OrderPaymentTarget,
  type PaymentPrefill,
} from "@/components/admin/OrderPaymentModal";

interface DailyOrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  placed_at: string;
  customers: { id: string; business_name: string; owner_name: string; phone: string } | null;
  order_items: {
    id: string;
    quantity: number;
    product_name_snapshot: string;
    order_item_financials:
      | { manufacturer_id: string; manufacturer_name_snapshot: string; margin_amount_total: number }
      | { manufacturer_id: string; manufacturer_name_snapshot: string; margin_amount_total: number }[]
      | null;
  }[];
  purchase_orders: { id: string; po_number: string; status: string; manufacturer_id: string }[];
}

type OpBucket =
  | "today"
  | "pending"
  | "confirmed"
  | "fulfilment"
  | "dispatched"
  | "delivered"
  | "cancelled";

export function DailyOperationsPage() {
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [bucket, setBucket] = useState<OpBucket>("today");
  const [search, setSearch] = useState("");
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<{
    order: OrderPaymentTarget;
    prefill?: PaymentPrefill;
  } | null>(null);

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["admin-daily-operations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select(
          "id, order_number, customer_id, subtotal, tax_total, total_amount, paid_amount, due_amount, order_status, payment_status, placed_at, customers(id, business_name, owner_name, phone), order_items(id, quantity, product_name_snapshot, order_item_financials(manufacturer_id, manufacturer_name_snapshot, margin_amount_total)), purchase_orders(id, po_number, status, manufacturer_id)"
        )
        .order("placed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as DailyOrderRow[];
    },
  });

  const { data: paymentClaims = [], refetch: refetchClaims } = useQuery({
    queryKey: ["admin-order-payment-claims"],
    queryFn: async () => {
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .in("recipient_role", ["admin", "staff"])
        .eq("entity_type", "order_payment_claim")
        .eq("is_read", false)
        .order("created_at", { ascending: false })
        .limit(8);
      return (data ?? []) as NotificationRecord[];
    },
  });

  const dismissClaim = async (notifId: string) => {
    await supabase.from("notifications").update({ is_read: true }).eq("id", notifId);
    refetchClaims();
    queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
  };

  const todayIso = new Date().toISOString().slice(0, 10);

  const matchesBucket = (o: DailyOrderRow, b: OpBucket) => {
    switch (b) {
      case "today":
        return o.placed_at.slice(0, 10) === todayIso;
      case "pending":
        return o.order_status === "Pending";
      case "confirmed":
        return o.order_status === "Confirmed";
      case "fulfilment":
        return ["Processing", "Purchase Order Sent", "Manufacturer Fulfilment Pending"].includes(o.order_status);
      case "dispatched":
        return ["Dispatched", "Out for Delivery"].includes(o.order_status);
      case "delivered":
        return o.order_status === "Delivered";
      case "cancelled":
        return o.order_status === "Cancelled";
    }
  };

  const bucketDefs: { key: OpBucket; label: string; count: number; icon: typeof Clock }[] = [
    { key: "today", label: "Today's Orders", count: orders.filter((o) => matchesBucket(o, "today")).length, icon: ClipboardList },
    { key: "pending", label: "Pending", count: orders.filter((o) => matchesBucket(o, "pending")).length, icon: Clock },
    { key: "confirmed", label: "Confirmed", count: orders.filter((o) => matchesBucket(o, "confirmed")).length, icon: CheckCircle2 },
    { key: "fulfilment", label: "Mfg Fulfilment", count: orders.filter((o) => matchesBucket(o, "fulfilment")).length, icon: FileSpreadsheet },
    { key: "dispatched", label: "Dispatched", count: orders.filter((o) => matchesBucket(o, "dispatched")).length, icon: Truck },
    { key: "delivered", label: "Delivered", count: orders.filter((o) => matchesBucket(o, "delivered")).length, icon: PackageCheck },
    { key: "cancelled", label: "Cancelled", count: orders.filter((o) => matchesBucket(o, "cancelled")).length, icon: XCircle },
  ];

  const invalidateOps = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-daily-operations"] });
    queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-purchase-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] });
  };

  const quickStatus = async (orderId: string, newStatus: OrderStatus) => {
    setBusyOrderId(orderId);
    try {
      const { error } = await supabase.rpc("update_order_status_admin", {
        p_order_id: orderId,
        p_new_status: newStatus,
        p_notes: `Updated via Daily Operations queue`,
      });
      if (error) throw error;
      toast({ title: `Order updated to ${newStatus}`, type: "success" });
      invalidateOps();
    } catch (err) {
      toast({ title: "Status update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBusyOrderId(null);
    }
  };

  const quickSplitPo = async (orderId: string) => {
    setBusyOrderId(orderId);
    try {
      const { data, error } = await supabase.rpc("split_order_to_purchase_orders", { p_order_id: orderId });
      if (error) throw error;
      const created = Array.isArray(data) ? data : [];
      toast({
        title: created.length > 0 ? `Generated ${created.length} Purchase Order(s)` : "All items already have POs",
        description: created.map((c: { po_number: string; manufacturer_name: string }) => `${c.po_number} (${c.manufacturer_name})`).join(", "),
        type: created.length > 0 ? "success" : "info",
      });
      invalidateOps();
    } catch (err) {
      toast({ title: "Could not split order to POs", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBusyOrderId(null);
    }
  };

  const filtered = orders.filter((o) => {
    if (!matchesBucket(o, bucket)) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      o.order_number.toLowerCase().includes(q) ||
      (o.customers?.business_name || "").toLowerCase().includes(q) ||
      o.order_items.some((i) => i.product_name_snapshot.toLowerCase().includes(q))
    );
  });

  const openPaymentForOrder = (o: DailyOrderRow, prefill?: PaymentPrefill) => {
    const paidAmt = Number(o.paid_amount ?? 0);
    const dueAmt = Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));
    setPaymentTarget({
      order: {
        id: o.id,
        order_number: o.order_number,
        customer_name: o.customers?.business_name || "Customer",
        total_amount: Number(o.total_amount),
        paid_amount: paidAmt,
        due_amount: dueAmt,
        payment_status: o.payment_status,
        order_status: o.order_status,
      },
      prefill,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Daily Operations</h1>
          <p className="text-sm text-slate-500">
            Process incoming customer orders, split multi-manufacturer POs, track payment dues, and verify customer payment notices.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/purchase-orders">
            <Button variant="outline" size="sm">
              <FileSpreadsheet className="h-4 w-4" />
              All Purchase Orders
            </Button>
          </Link>
          <Link to="/admin/orders">
            <Button size="sm">
              All Orders Ledger
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Customer Reported Payment Alerts */}
      {paymentClaims.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/70">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold text-amber-950">
              <BellRing className="h-4 w-4 text-amber-700" />
              Customer Payment Notices ({paymentClaims.length}) — Pending Admin Verification
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {paymentClaims.map((claim) => {
              const linkedOrder = orders.find((o) => o.id === claim.entity_id);
              const parsed = parsePaymentClaimNotification(claim.message);
              return (
                <div
                  key={claim.id}
                  className="flex flex-col justify-between gap-2 rounded-md border border-amber-200 bg-white px-3.5 py-2.5 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900">{claim.title}</p>
                    <p className="text-xs text-slate-600">{claim.message}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {linkedOrder && linkedOrder.order_status !== "Cancelled" && (
                      <Button size="sm" onClick={() => openPaymentForOrder(linkedOrder, parsed)}>
                        Verify &amp; Apply Payment
                      </Button>
                    )}
                    {claim.entity_id && (
                      <Link
                        to={`/admin/orders/${claim.entity_id}`}
                        className="inline-flex h-8 items-center rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Open Order
                      </Link>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => dismissClaim(claim.id)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Operational Bucket Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {bucketDefs.map((b) => {
          const Icon = b.icon;
          const active = bucket === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setBucket(b.key)}
              className={cn(
                "flex flex-col justify-between rounded-lg border p-3.5 text-left transition-all",
                active
                  ? "border-blue-600 bg-blue-50/80 shadow-sm"
                  : "border-slate-200 bg-white hover:border-slate-300"
              )}
            >
              <div className="flex items-center justify-between">
                <span className={cn("text-xs font-medium", active ? "text-blue-800" : "text-slate-500")}>
                  {b.label}
                </span>
                <Icon className={cn("h-4 w-4", active ? "text-blue-700" : "text-slate-400")} />
              </div>
              <p className={cn("mt-2 text-2xl font-bold", active ? "text-blue-900" : "text-slate-900")}>{b.count}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{bucketDefs.find((b) => b.key === bucket)?.label} ({filtered.length})</CardTitle>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by Order #, business, product..."
            className="sm:w-72"
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Customer Business</TableHead>
                <TableHead>Manufacturers Involved (Admin)</TableHead>
                <TableHead>PO Coverage</TableHead>
                <TableHead>Total / Paid / Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Quick Operations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                    Loading operational queue...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                    No orders in this operational stage.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((o) => {
                  const mfgNames = Array.from(
                    new Set(
                      o.order_items
                        .map((it) => {
                          const fin = Array.isArray(it.order_item_financials)
                            ? it.order_item_financials[0]
                            : it.order_item_financials;
                          return fin?.manufacturer_name_snapshot;
                        })
                        .filter(Boolean) as string[]
                    )
                  );
                  const totalMargin = o.order_items.reduce((acc, it) => {
                    const fin = Array.isArray(it.order_item_financials)
                      ? it.order_item_financials[0]
                      : it.order_item_financials;
                    return acc + Number(fin?.margin_amount_total ?? 0);
                  }, 0);
                  const totalUnits = o.order_items.reduce((acc, it) => acc + Number(it.quantity), 0);
                  const poCount = o.purchase_orders?.length ?? 0;
                  const canSplit = o.order_status !== "Cancelled" && o.order_status !== "Delivered" && poCount < mfgNames.length;
                  const busy = busyOrderId === o.id;
                  const paidAmt = Number(o.paid_amount ?? 0);
                  const dueAmt = o.order_status === "Cancelled" ? 0 : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));

                  return (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link to={`/admin/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                          {o.order_number}
                        </Link>
                        <p className="text-xs text-slate-500">{formatDateTime(o.placed_at)}</p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium text-slate-900">{o.customers?.business_name}</p>
                        <p className="text-xs text-slate-500">
                          {o.order_items.length} SKU(s) &bull; {formatQty(totalUnits)} units
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {mfgNames.length === 0 ? (
                            <span className="text-xs text-slate-400">—</span>
                          ) : (
                            mfgNames.map((m) => (
                              <span
                                key={m}
                                className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                              >
                                {m}
                              </span>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {poCount > 0 ? (
                          <span className="font-medium text-emerald-700">
                            {poCount} / {Math.max(1, mfgNames.length)} PO(s)
                          </span>
                        ) : (
                          <span className="font-medium text-amber-700">Needs PO</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <p className="font-semibold text-slate-900">{formatCurrency(o.total_amount, sym)}</p>
                        <p className="text-[11px] text-slate-600">
                          <span className="text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</span> &bull;{" "}
                          <span className={totalMargin < 0 ? "font-medium text-red-700" : "text-emerald-700"}>
                            {formatSignedCurrency(totalMargin, sym)} margin
                          </span>
                        </p>
                        <p className={cn("text-xs font-bold", dueAmt > 0 ? "text-red-700" : "text-slate-500")}>
                          {o.order_status === "Cancelled" ? "Cancelled" : `Due: ${formatCurrency(dueAmt, sym)}`}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={o.order_status} />
                          <StatusBadge status={o.payment_status} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          {o.order_status !== "Cancelled" && (
                            <Button
                              size="sm"
                              variant={dueAmt > 0 ? "default" : "outline"}
                              disabled={busy}
                              onClick={() => openPaymentForOrder(o)}
                            >
                              <IndianRupee className="h-3.5 w-3.5" />
                              Payment
                            </Button>
                          )}
                          {o.order_status === "Pending" && (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => quickStatus(o.id, "Confirmed")}
                            >
                              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                              Confirm Order
                            </Button>
                          )}
                          {canSplit && o.order_status !== "Pending" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => quickSplitPo(o.id)}
                            >
                              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                              Split to POs
                            </Button>
                          )}
                          {["Confirmed", "Processing", "Purchase Order Sent", "Manufacturer Fulfilment Pending"].includes(
                            o.order_status
                          ) && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => quickStatus(o.id, "Dispatched")}
                            >
                              Mark Dispatched
                            </Button>
                          )}
                          {["Dispatched", "Out for Delivery"].includes(o.order_status) && (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => quickStatus(o.id, "Delivered")}
                            >
                              Complete Delivery
                            </Button>
                          )}
                          <Link
                            to={`/admin/orders/${o.id}`}
                            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Open
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <OrderPaymentModal
        order={paymentTarget?.order ?? null}
        prefill={paymentTarget?.prefill ?? null}
        onClose={() => {
          setPaymentTarget(null);
          refetchClaims();
        }}
      />
    </div>
  );
}
