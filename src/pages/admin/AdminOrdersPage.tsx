import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ShoppingBag, Search, Eye, ArrowRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatDateTime, formatQty } from "@/lib/utils";
import { ALL_ORDER_STATUSES, type OrderStatus } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";

interface AdminOrderListItem {
  id: string;
  order_number: string;
  customer_id: string;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  order_status: OrderStatus;
  payment_status: "unpaid" | "partially_paid" | "paid";
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

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["admin-orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select(
          "id, order_number, customer_id, subtotal, tax_total, total_amount, order_status, payment_status, placed_at, customers(id, business_name, gst_number), order_items(id, quantity, product_name_snapshot, order_item_financials(manufacturer_name_snapshot, margin_amount_total)), invoices(id, invoice_number), purchase_orders(id, po_number)"
        )
        .order("placed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AdminOrderListItem[];
    },
  });

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
            Centralized customer order ledger with manufacturer sourcing, PO splits, margin breakdown, and GST invoicing.
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
                <TableHead>Total Sales</TableHead>
                <TableHead>Est. Margin</TableHead>
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
                      <TableCell className="font-semibold text-slate-900">
                        {formatCurrency(o.total_amount, sym)}
                      </TableCell>
                      <TableCell className="text-sm font-semibold text-emerald-700">
                        +{formatCurrency(totalMargin, sym)}
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
                        <Link
                          to={`/admin/orders/${o.id}`}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Manage
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
