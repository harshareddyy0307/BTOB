import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ShoppingBag, Search, Eye, ArrowRight, IndianRupee } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatSignedCurrency } from "@/lib/pricing";
import { cn, formatCurrency, formatDateTime, formatQty } from "@/lib/utils";
import { ALL_ORDER_STATUSES, type OrderStatus, type PaymentStatus } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { OrderPaymentModal, type OrderPaymentTarget } from "@/components/admin/OrderPaymentModal";

interface AdminOrderListItem {
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
  customers: { id: string; business_name: string; gst_number: string | null } | null;
  order_items: {
    id: string;
    quantity: number;
    product_name_snapshot: string;
    order_item_financials:
      | { manufacturer_name_snapshot: string; margin_amount_total: number }
      | { manufacturer_name_snapshot: string; margin_amount_total: number }[]
      | null;
  }[];
  invoices: { id: string; invoice_number: string }[] | { id: string; invoice_number: string } | null;
  purchase_orders: { id: string; po_number: string }[];
}

export function AdminOrdersPage() {
  const { branding } = useAuth();
  const sym = branding.currency_symbol || "₹";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [paymentOrder, setPaymentOrder] = useState<OrderPaymentTarget | null>(null);

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["admin-orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select(
          "id, order_number, customer_id, subtotal, tax_total, total_amount, paid_amount, due_amount, order_status, payment_status, placed_at, customers(id, business_name, gst_number), order_items(id, quantity, product_name_snapshot, order_item_financials(manufacturer_name_snapshot, margin_amount_total)), invoices(id, invoice_number), purchase_orders(id, po_number)"
        )
        .order("placed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AdminOrderListItem[];
    },
  });

  const activeOrders = orders.filter((o) => o.order_status !== "Cancelled");
  const totalOrderValue = activeOrders.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const totalPaidAmount = activeOrders.reduce((s, o) => s + Number(o.paid_amount || 0), 0);
  const totalDueAmount = activeOrders.reduce((s, o) => s + Number(o.due_amount || 0), 0);
  const unpaidOrPartialCount = activeOrders.filter((o) => o.payment_status !== "paid").length;

  const filtered = orders.filter((o) => {
    if (statusFilter !== "all" && o.order_status !== statusFilter) return false;
    if (paymentFilter !== "all" && o.payment_status !== paymentFilter) return false;
    const dStr = o.placed_at.slice(0, 10);
    if (fromDate && dStr < fromDate) return false;
    if (toDate && dStr > toDate) return false;

    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      o.order_number.toLowerCase().includes(q) ||
      (o.customers?.business_name || "").toLowerCase().includes(q) ||
      o.order_items.some((i) => i.product_name_snapshot.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Order Management</h1>
          <p className="text-sm text-slate-500">
            Track customer orders, mark payments as Paid / Unpaid / Partially Paid, and monitor exact Amount Due.
          </p>
        </div>
        <Link
          to="/admin/operations"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
        >
          Daily Operations Queue
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {/* Receivables & Collections Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Active Order Value</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(totalOrderValue, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Paid Collected</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{formatCurrency(totalPaidAmount, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Amount Due</p>
            <p className={cn("mt-1 text-2xl font-bold", totalDueAmount > 0 ? "text-red-700" : "text-emerald-700")}>
              {formatCurrency(totalDueAmount, sym)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Unpaid / Partial Orders</p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{unpaidOrPartialCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search order #, customer business, product..."
              className="pl-9"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Order Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Order Statuses</SelectItem>
              {ALL_ORDER_STATUSES.map((st) => (
                <SelectItem key={st} value={st}>
                  {st}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={paymentFilter} onValueChange={setPaymentFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Payment Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Payment Statuses</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
              <SelectItem value="partially_paid">Partially Paid</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
            </SelectContent>
          </Select>

          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} title="From date" />
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} title="To date" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-blue-700" />
            Customer Orders ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Items / Qty</TableHead>
                <TableHead>Total / Margin</TableHead>
                <TableHead>Paid / Amount Due</TableHead>
                <TableHead>POs / Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                    Loading orders...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                    No customer orders match your filters.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((o) => {
                  const totalQty = o.order_items.reduce((s, i) => s + Number(i.quantity), 0);
                  const totalMargin = o.order_items.reduce((s, i) => {
                    const fin = Array.isArray(i.order_item_financials)
                      ? i.order_item_financials[0]
                      : i.order_item_financials;
                    return s + Number(fin?.margin_amount_total ?? 0);
                  }, 0);
                  const inv = Array.isArray(o.invoices) ? o.invoices[0] : o.invoices;
                  const paidAmt = Number(o.paid_amount ?? 0);
                  const dueAmt = o.order_status === "Cancelled" ? 0 : Math.max(0, Number(o.due_amount ?? o.total_amount - paidAmt));

                  return (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link to={`/admin/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                          {o.order_number}
                        </Link>
                        <p className="text-xs text-slate-500">{formatDateTime(o.placed_at)}</p>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/admin/customers/${o.customer_id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {o.customers?.business_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {o.order_items.length} line(s) &bull; {formatQty(totalQty)} units
                      </TableCell>
                      <TableCell>
                        <p className="font-semibold text-slate-900">{formatCurrency(o.total_amount, sym)}</p>
                        <p className={cn("text-xs font-semibold", totalMargin < 0 ? "text-red-700" : "text-emerald-700")}>
                          {formatSignedCurrency(totalMargin, sym)} margin
                        </p>
                      </TableCell>
                      <TableCell>
                        <p className="text-xs font-medium text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</p>
                        <p className={cn("text-xs font-bold", dueAmt > 0 ? "text-red-700" : "text-slate-500")}>
                          {o.order_status === "Cancelled" ? "Cancelled" : `Due: ${formatCurrency(dueAmt, sym)}`}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs">
                        <p className="text-slate-700">{o.purchase_orders?.length ?? 0} PO(s)</p>
                        <p className="text-slate-500">{inv ? inv.invoice_number : "No invoice"}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={o.order_status} />
                          <StatusBadge status={o.payment_status} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {o.order_status !== "Cancelled" && (
                            <Button
                              size="sm"
                              variant={dueAmt > 0 ? "default" : "outline"}
                              onClick={() =>
                                setPaymentOrder({
                                  id: o.id,
                                  order_number: o.order_number,
                                  customer_name: o.customers?.business_name || "Customer",
                                  total_amount: Number(o.total_amount),
                                  paid_amount: paidAmt,
                                  due_amount: dueAmt,
                                  payment_status: o.payment_status,
                                  order_status: o.order_status,
                                })
                              }
                            >
                              <IndianRupee className="h-3.5 w-3.5" />
                              Payment
                            </Button>
                          )}
                          <Link
                            to={`/admin/orders/${o.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Manage
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

      <OrderPaymentModal order={paymentOrder} onClose={() => setPaymentOrder(null)} />
    </div>
  );
}
