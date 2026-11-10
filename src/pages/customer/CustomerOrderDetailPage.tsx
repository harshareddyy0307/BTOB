import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, FileDown, IndianRupee, MapPin, Package, Truck, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { generateCustomerInvoicePdf } from "@/lib/pdfGenerator";
import { cn, formatCurrency, formatDate, formatDateTime, formatQty } from "@/lib/utils";
import {
  ORDER_STATUS_FLOW,
  type AgencySettings,
  type InvoiceRecord,
  type OrderItemRecord,
  type OrderRecord,
  type PaymentRecord,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import {
  CustomerPaymentNoticeDialog,
  type CustomerNoticeOrderTarget,
} from "@/components/customer/CustomerPaymentNoticeDialog";

export function CustomerOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { customerProfile, branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const [noticeOrder, setNoticeOrder] = useState<CustomerNoticeOrderTarget | null>(null);

  const { data: order, isLoading } = useQuery({
    queryKey: ["customer-order-detail", id],
    enabled: Boolean(id && customerProfile?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", id!)
        .eq("customer_id", customerProfile!.id)
        .single();
      if (error) throw error;
      return data as OrderRecord;
    },
  });

  const { data: items = [] } = useQuery({
    queryKey: ["customer-order-items", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_items")
        .select("*")
        .eq("order_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as OrderItemRecord[];
    },
  });

  const { data: invoice } = useQuery({
    queryKey: ["customer-order-invoice", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase.from("invoices").select("*").eq("order_id", id!).maybeSingle();
      return (data as InvoiceRecord | null) ?? null;
    },
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["customer-invoice-payments", invoice?.id],
    enabled: Boolean(invoice?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("payments")
        .select("*")
        .eq("invoice_id", invoice!.id)
        .order("payment_date", { ascending: false });
      return (data ?? []) as PaymentRecord[];
    },
  });

  const { data: agency } = useQuery({
    queryKey: ["agency-settings-read"],
    queryFn: async () => {
      const { data } = await supabase.from("agency_settings").select("*").eq("id", 1).single();
      return data as AgencySettings;
    },
  });

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-slate-500">Loading order details...</div>;
  }

  if (!order) {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-sm text-red-600">Order not found or access denied.</p>
        <Link to="/customer/orders" className="text-sm font-medium text-blue-700 hover:underline">
          Return to My Orders
        </Link>
      </div>
    );
  }

  const currentIdx = ORDER_STATUS_FLOW.indexOf(order.order_status);
  const isCancelled = order.order_status === "Cancelled";
  const addr = order.delivery_address;
  const paidAmt = Number(order.paid_amount ?? 0);
  const dueAmt = isCancelled ? 0 : Math.max(0, Number(order.due_amount ?? Number(order.total_amount) - paidAmt));
  const recordedPayments = payments.filter((p) => p.status !== "voided");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/customer/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" />
          Back to My Orders
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.order_status} />
          <StatusBadge status={order.payment_status} />
          {dueAmt > 0 && !isCancelled && (
            <Button
              size="sm"
              onClick={() =>
                setNoticeOrder({
                  id: order.id,
                  order_number: order.order_number,
                  total_amount: Number(order.total_amount),
                  paid_amount: paidAmt,
                  due_amount: dueAmt,
                })
              }
            >
              <IndianRupee className="h-3.5 w-3.5" />
              Report Payment / UTR
            </Button>
          )}
        </div>
      </div>

      {/* Header & Order Stepper */}
      <Card>
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{order.order_number}</h1>
              <p className="mt-1 text-xs text-slate-500">
                Placed on {formatDateTime(order.placed_at)} &bull; Last updated {formatDateTime(order.updated_at)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-left sm:text-right">
              <p className="text-xs font-medium uppercase text-slate-500">Order Grand Total</p>
              <p className="text-2xl font-bold text-slate-900">{formatCurrency(order.total_amount, sym)}</p>
              <p className="text-xs font-medium text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</p>
              <p className={cn("text-xs font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                {isCancelled ? "Cancelled" : `Amount Due: ${formatCurrency(dueAmt, sym)}`}
              </p>
            </div>
          </div>

          {isCancelled ? (
            <div className="flex items-center gap-2.5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
              <XCircle className="h-5 w-5 shrink-0" />
              This order was cancelled. Any reserved inventory was released.
            </div>
          ) : (
            <div>
              <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Truck className="h-3.5 w-3.5 text-blue-700" />
                Live Fulfilment Timeline
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                {ORDER_STATUS_FLOW.map((stage, idx) => {
                  const done = currentIdx >= idx;
                  const active = currentIdx === idx;
                  return (
                    <div
                      key={stage}
                      className={cn(
                        "rounded-md border p-2.5 text-xs transition-colors",
                        active
                          ? "border-blue-600 bg-blue-50 text-blue-900"
                          : done
                          ? "border-emerald-200 bg-emerald-50/70 text-emerald-900"
                          : "border-slate-200 bg-white text-slate-400"
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-mono text-[10px]">0{idx + 1}</span>
                        {done && <CheckCircle2 className={cn("h-3.5 w-3.5", active ? "text-blue-700" : "text-emerald-600")} />}
                      </div>
                      <p className="font-semibold leading-snug">{stage}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Order Items */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-blue-700" />
            Ordered Products ({items.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Unit Selling Price</TableHead>
                <TableHead>GST</TableHead>
                <TableHead className="text-right">Line Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="font-medium text-slate-900">{item.product_name_snapshot}</p>
                    <p className="font-mono text-xs text-slate-500">{item.sku_snapshot}</p>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-slate-500">{item.hsn_snapshot || "—"}</TableCell>
                  <TableCell className="font-medium">
                    {formatQty(item.quantity)} {item.unit_snapshot}
                  </TableCell>
                  <TableCell>{formatCurrency(item.unit_selling_price, sym)}</TableCell>
                  <TableCell className="text-xs text-slate-600">
                    {item.gst_rate}% ({formatCurrency(item.tax_amount, sym)})
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900">
                    {formatCurrency(item.line_total, sym)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delivery Address + Financial & Invoice Summary */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4 text-blue-700" />
              Delivery Details &amp; Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            <div>
              <p className="font-semibold text-slate-900">{addr?.contact_name || customerProfile?.owner_name}</p>
              <p className="text-xs text-slate-500">{addr?.contact_phone || customerProfile?.phone}</p>
              <p className="mt-1.5">
                {[addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", ")}
              </p>
            </div>
            {order.notes && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
                <p className="font-semibold text-slate-700">Order Notes:</p>
                <p className="mt-0.5 text-slate-600">{order.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary, Due Balance &amp; GST Tax Invoice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Taxable Subtotal</span>
              <span>{formatCurrency(order.subtotal, sym)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Applicable GST Total</span>
              <span>{formatCurrency(order.tax_total, sym)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
              <span>Order Total</span>
              <span>{formatCurrency(order.total_amount, sym)}</span>
            </div>
            <div className="flex justify-between text-sm text-emerald-700">
              <span>Amount Paid</span>
              <span className="font-semibold">{formatCurrency(paidAmt, sym)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="font-semibold text-slate-800">Remaining Amount Due</span>
              <span className={cn("font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                {formatCurrency(dueAmt, sym)}
              </span>
            </div>

            {dueAmt > 0 && !isCancelled && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  setNoticeOrder({
                    id: order.id,
                    order_number: order.order_number,
                    total_amount: Number(order.total_amount),
                    paid_amount: paidAmt,
                    due_amount: dueAmt,
                  })
                }
              >
                <IndianRupee className="h-4 w-4" />
                Already Paid? Notify Agency with UTR / Ref #
              </Button>
            )}

            {invoice ? (
              <div className="mt-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase text-blue-800">GST Tax Invoice Issued</p>
                    <p className="font-bold text-slate-900">{invoice.invoice_number}</p>
                    <p className="text-xs text-slate-600">
                      Date: {formatDate(invoice.invoice_date)} &bull; Due: {formatDate(invoice.due_date)}
                    </p>
                  </div>
                  <StatusBadge status={invoice.payment_status} />
                </div>

                {agency && customerProfile && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      generateCustomerInvoicePdf({
                        agency,
                        invoice,
                        customer: customerProfile,
                        order,
                        items,
                        payments: recordedPayments,
                      })
                    }
                  >
                    <FileDown className="h-4 w-4" />
                    Download Tax Invoice PDF
                  </Button>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                Tax invoice has not been generated yet. Once the agency issues your invoice, you can download the PDF here or in the Invoices section.
              </div>
            )}

            {recordedPayments.length > 0 && (
              <div className="space-y-1.5 pt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Recorded Payments ({recordedPayments.length})
                </p>
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {recordedPayments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div>
                        <p className="font-medium text-slate-900">
                          {p.payment_method} {p.reference_number ? `(${p.reference_number})` : ""}
                        </p>
                        <p className="text-[11px] text-slate-500">{formatDate(p.payment_date)}</p>
                      </div>
                      <span className="font-semibold text-emerald-700">{formatCurrency(p.amount, sym)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CustomerPaymentNoticeDialog order={noticeOrder} onClose={() => setNoticeOrder(null)} />
    </div>
  );
}
