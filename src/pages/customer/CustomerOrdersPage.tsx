import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Truck, ArrowRight, Search, CheckCircle2, XCircle, IndianRupee } from "lucide-react";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { cn, formatCurrency, formatDateTime, formatQty } from "@/lib/utils";
import { ALL_ORDER_STATUSES, ORDER_STATUS_FLOW, type OrderItemRecord, type OrderRecord } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import {
  CustomerPaymentNoticeDialog,
  type CustomerNoticeOrderTarget,
} from "@/components/customer/CustomerPaymentNoticeDialog";

type CustomerOrderWithItems = OrderRecord & {
  order_items?: Pick<
    OrderItemRecord,
    "id" | "product_name_snapshot" | "sku_snapshot" | "unit_snapshot" | "quantity" | "line_total"
  >[];
};

export function CustomerOrdersPage() {
  const { customerProfile, branding } = useAuth();
  const location = useLocation();
  const isTrackingMode = location.pathname.includes("/tracking");
  const sym = branding.currency_symbol || "₹";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(isTrackingMode ? "active_only" : "all");
  const [noticeOrder, setNoticeOrder] = useState<CustomerNoticeOrderTarget | null>(null);

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["customer-orders", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () =>
      fetchAllRows<CustomerOrderWithItems>((from, to) =>
        supabase
          .from("orders")
          .select(
            "id, order_number, customer_id, delivery_address, notes, subtotal, tax_total, total_amount, paid_amount, due_amount, order_status, payment_status, placed_at, updated_at, order_items(id, product_name_snapshot, sku_snapshot, unit_snapshot, quantity, line_total)"
          )
          .eq("customer_id", customerProfile!.id)
          .order("placed_at", { ascending: false })
          .range(from, to)
      ),
  });

  const activeOrders = orders.filter((o) => o.order_status !== "Cancelled");
  const totalOrdered = activeOrders.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const totalPaid = activeOrders.reduce((s, o) => s + Number(o.paid_amount || 0), 0);
  const totalDue = activeOrders.reduce(
    (s, o) => s + Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - Number(o.paid_amount || 0))),
    0
  );

  const filtered = orders.filter((o) => {
    if (statusFilter === "active_only") {
      if (o.order_status === "Delivered" || o.order_status === "Cancelled") return false;
    } else if (statusFilter !== "all" && o.order_status !== statusFilter) {
      return false;
    }

    const q = search.toLowerCase().trim();
    if (!q) return true;
    const matchesOrderNum = o.order_number.toLowerCase().includes(q);
    const matchesProduct = (o.order_items ?? []).some(
      (it) => it.product_name_snapshot.toLowerCase().includes(q) || it.sku_snapshot.toLowerCase().includes(q)
    );
    return matchesOrderNum || matchesProduct;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
            {isTrackingMode ? <Truck className="h-5 w-5 text-blue-700" /> : <ClipboardList className="h-5 w-5 text-blue-700" />}
            {isTrackingMode ? "Order Tracking & Fulfilment Status" : "My Orders"}
          </h1>
          <p className="text-sm text-slate-500">
            {isTrackingMode
              ? "Monitor real-time fulfilment progress from order confirmation through warehouse dispatch and delivery."
              : "Complete history of your wholesale orders, paid amounts, and remaining due balances."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={statusFilter === "active_only" ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter("active_only")}
          >
            In Progress ({orders.filter((o) => o.order_status !== "Delivered" && o.order_status !== "Cancelled").length})
          </Button>
          <Button
            variant={statusFilter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter("all")}
          >
            All ({orders.length})
          </Button>
        </div>
      </div>

      {/* Customer Payment Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Ordered Value</p>
            <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{formatCurrency(totalOrdered, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Paid to Date</p>
            <p className="mt-1 text-xl font-bold text-emerald-700 sm:text-2xl">{formatCurrency(totalPaid, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Remaining Amount Due</p>
            <p className={cn("mt-1 text-xl font-bold sm:text-2xl", totalDue > 0 ? "text-red-700" : "text-emerald-700")}>
              {formatCurrency(totalDue, sym)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Order ID or product name..."
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="sm:w-64">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Order Statuses</SelectItem>
              <SelectItem value="active_only">Active / In Transit Only</SelectItem>
              {ALL_ORDER_STATUSES.map((st) => (
                <SelectItem key={st} value={st}>
                  {st}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">Loading your orders...</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-12 text-center">
            <p className="text-sm text-slate-500">No matching orders found.</p>
            <Link to="/customer/products" className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline">
              Browse Products <ArrowRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      ) : isTrackingMode ? (
        <div className="space-y-4">
          {filtered.map((o) => {
            const currentIdx = ORDER_STATUS_FLOW.indexOf(o.order_status);
            const isCancelled = o.order_status === "Cancelled";
            const items = o.order_items ?? [];
            const totalUnits = items.reduce((s, it) => s + Number(it.quantity), 0);
            const paidAmt = Number(o.paid_amount ?? 0);
            const dueAmt = isCancelled ? 0 : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));

            return (
              <Card key={o.id}>
                <CardContent className="space-y-4 p-4 sm:p-5">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Link to={`/customer/orders/${o.id}`} className="text-base font-bold text-slate-900 hover:text-blue-700">
                          {o.order_number}
                        </Link>
                        <StatusBadge status={o.order_status} />
                        <StatusBadge status={o.payment_status} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Placed {formatDateTime(o.placed_at)} &bull; {items.length} line item(s) ({formatQty(totalUnits)} total units) &bull;{" "}
                        <strong className="text-slate-800">{formatCurrency(o.total_amount, sym)}</strong> &bull;{" "}
                        <span className="text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</span> &bull;{" "}
                        <strong className={dueAmt > 0 ? "text-red-700" : "text-emerald-700"}>
                          Due: {formatCurrency(dueAmt, sym)}
                        </strong>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {dueAmt > 0 && !isCancelled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setNoticeOrder({
                              id: o.id,
                              order_number: o.order_number,
                              total_amount: Number(o.total_amount),
                              paid_amount: paidAmt,
                              due_amount: dueAmt,
                            })
                          }
                        >
                          <IndianRupee className="h-3.5 w-3.5" />
                          Notify Payment
                        </Button>
                      )}
                      <Link
                        to={`/customer/orders/${o.id}`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        View Details &amp; Invoice
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>

                  {isCancelled ? (
                    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
                      <XCircle className="h-4 w-4 shrink-0" />
                      Order cancelled — reserved stock has been released.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4 lg:grid-cols-8">
                      {ORDER_STATUS_FLOW.map((step, idx) => {
                        const completed = currentIdx >= idx;
                        const active = currentIdx === idx;
                        return (
                          <div key={step} className="space-y-1.5">
                            <div
                              className={cn(
                                "h-2 rounded-full transition-colors",
                                completed ? (active ? "bg-blue-600" : "bg-emerald-500") : "bg-slate-200"
                              )}
                            />
                            <p
                              className={cn(
                                "text-[10px] leading-tight",
                                active
                                  ? "font-bold text-blue-700"
                                  : completed
                                  ? "font-medium text-emerald-700"
                                  : "text-slate-400"
                              )}
                            >
                              {step}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
                    {items.slice(0, 4).map((it) => (
                      <span key={it.id} className="rounded bg-slate-100 px-2 py-0.5">
                        {it.product_name_snapshot} &times; {formatQty(it.quantity)} {it.unit_snapshot}
                      </span>
                    ))}
                    {items.length > 4 && (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-500">+{items.length - 4} more</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Order History ({filtered.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-100 md:hidden">
              {filtered.map((o) => {
                const items = o.order_items ?? [];
                const totalQty = items.reduce((s, it) => s + Number(it.quantity), 0);
                const previewNames = items.slice(0, 2).map((it) => it.product_name_snapshot).join(", ");
                const paidAmt = Number(o.paid_amount ?? 0);
                const dueAmt =
                  o.order_status === "Cancelled"
                    ? 0
                    : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));

                return (
                  <div key={o.id} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Link to={`/customer/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                          {o.order_number}
                        </Link>
                        <p className="text-xs text-slate-500">{formatDateTime(o.placed_at)}</p>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        <StatusBadge status={o.order_status} />
                        <StatusBadge status={o.payment_status} />
                      </div>
                    </div>

                    <div className="text-xs text-slate-600">
                      <p className="truncate font-medium text-slate-800">{previewNames || "—"}</p>
                      <p>
                        {items.length} SKU(s) &bull; {formatQty(totalQty)} units
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                      <div className="text-xs">
                        <span className="font-semibold text-slate-900">{formatCurrency(o.total_amount, sym)}</span>
                        <span className="mx-1.5 text-slate-300">|</span>
                        <span className="text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</span>
                        {o.order_status !== "Cancelled" && (
                          <>
                            <span className="mx-1.5 text-slate-300">|</span>
                            <span className={cn("font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                              Due: {formatCurrency(dueAmt, sym)}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {dueAmt > 0 && o.order_status !== "Cancelled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setNoticeOrder({
                                id: o.id,
                                order_number: o.order_number,
                                total_amount: Number(o.total_amount),
                                paid_amount: paidAmt,
                                due_amount: dueAmt,
                              })
                            }
                          >
                            Notify Payment
                          </Button>
                        )}
                        <Link
                          to={`/customer/orders/${o.id}`}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order ID</TableHead>
                    <TableHead>Order Date</TableHead>
                    <TableHead>Product Details</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Total / Paid</TableHead>
                    <TableHead>Amount Due</TableHead>
                    <TableHead>Order Status</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((o) => {
                    const items = o.order_items ?? [];
                    const totalQty = items.reduce((s, it) => s + Number(it.quantity), 0);
                    const previewNames = items.slice(0, 2).map((it) => it.product_name_snapshot).join(", ");
                    const paidAmt = Number(o.paid_amount ?? 0);
                    const dueAmt =
                      o.order_status === "Cancelled"
                        ? 0
                        : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));

                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Link to={`/customer/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                            {o.order_number}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{formatDateTime(o.placed_at)}</TableCell>
                        <TableCell className="max-w-xs">
                          <p className="truncate text-sm font-medium text-slate-900">{previewNames || "—"}</p>
                          <p className="text-xs text-slate-500">{items.length} SKU(s)</p>
                        </TableCell>
                        <TableCell className="text-xs font-medium text-slate-700">{formatQty(totalQty)} units</TableCell>
                        <TableCell>
                          <p className="font-semibold text-slate-900">{formatCurrency(o.total_amount, sym)}</p>
                          <p className="text-xs text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</p>
                        </TableCell>
                        <TableCell className={cn("text-xs font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                          {o.order_status === "Cancelled" ? "—" : formatCurrency(dueAmt, sym)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={o.order_status} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={o.payment_status} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {dueAmt > 0 && o.order_status !== "Cancelled" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setNoticeOrder({
                                    id: o.id,
                                    order_number: o.order_number,
                                    total_amount: Number(o.total_amount),
                                    paid_amount: paidAmt,
                                    due_amount: dueAmt,
                                  })
                                }
                              >
                                Notify Payment
                              </Button>
                            )}
                            <Link
                              to={`/customer/orders/${o.id}`}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              {o.order_status === "Delivered" ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              ) : (
                                <Truck className="h-3.5 w-3.5 text-blue-600" />
                              )}
                              Track / View
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <CustomerPaymentNoticeDialog order={noticeOrder} onClose={() => setNoticeOrder(null)} />
    </div>
  );
}
