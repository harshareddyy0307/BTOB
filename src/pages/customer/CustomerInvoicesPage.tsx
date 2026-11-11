import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, FileDown, History } from "lucide-react";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { generateCustomerInvoicePdf } from "@/lib/pdfGenerator";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type {
  AgencySettings,
  InvoiceRecord,
  OrderItemRecord,
  OrderRecord,
  PaymentRecord,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

type CustomerInvoiceRow = InvoiceRecord & {
  orders: OrderRecord;
};

export function CustomerInvoicesPage() {
  const { customerProfile, branding } = useAuth();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";
  const [historyInvoice, setHistoryInvoice] = useState<CustomerInvoiceRow | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["customer-invoices", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () =>
      fetchAllRows<CustomerInvoiceRow>((from, to) =>
        supabase
          .from("invoices")
          .select("*, orders(*)")
          .eq("customer_id", customerProfile!.id)
          .order("invoice_date", { ascending: false })
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

  const { data: paymentHistory = [], isLoading: loadingHistory } = useQuery({
    queryKey: ["customer-invoice-payments-list", historyInvoice?.id],
    enabled: Boolean(historyInvoice?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("invoice_id", historyInvoice!.id)
        .order("payment_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PaymentRecord[];
    },
  });

  const handleDownloadPdf = async (inv: CustomerInvoiceRow) => {
    if (!agency || !customerProfile) {
      toast({
        title: "Cannot generate Invoice PDF",
        description: "Agency or customer details are still loading.",
        type: "error",
      });
      return;
    }
    const [{ data: items }, { data: payments }] = await Promise.all([
      supabase.from("order_items").select("*").eq("order_id", inv.order_id).order("created_at"),
      supabase.from("payments").select("*").eq("invoice_id", inv.id).order("payment_date"),
    ]);

    generateCustomerInvoicePdf({
      agency,
      invoice: inv,
      customer: customerProfile,
      order: inv.orders,
      items: (items ?? []) as OrderItemRecord[],
      payments: ((payments ?? []) as PaymentRecord[]).filter((p) => p.status !== "voided"),
    });
  };

  const activeInvoices = invoices.filter((i) => i.orders?.order_status !== "Cancelled");
  const totalBilled = activeInvoices.reduce((s, i) => s + Number(i.total_amount), 0);
  const totalPaid = activeInvoices.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalDue = Math.max(0, totalBilled - totalPaid);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          <FileText className="h-5 w-5 text-blue-700" />
          Tax Invoices &amp; Payments
        </h1>
        <p className="text-sm text-slate-500">
          Download GST tax invoices and review payment settlements for your business orders.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Invoiced</p>
            <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{formatCurrency(totalBilled, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Paid</p>
            <p className="mt-1 text-xl font-bold text-emerald-700 sm:text-2xl">{formatCurrency(totalPaid, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Outstanding Dues</p>
            <p className="mt-1 text-xl font-bold text-red-700 sm:text-2xl">{formatCurrency(totalDue, sym)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your Invoices ({invoices.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-slate-500">Loading invoices...</div>
          ) : invoices.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              No tax invoices have been generated for your account yet.
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100 md:hidden">
                {invoices.map((inv) => {
                  const isOrderCancelled = inv.orders?.order_status === "Cancelled";
                  const balance = isOrderCancelled
                    ? 0
                    : Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                  return (
                    <div key={inv.id} className={cn("space-y-2.5 p-4", isOrderCancelled && "bg-slate-50/70")}>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-900">{inv.invoice_number}</p>
                          <Link
                            to={`/customer/orders/${inv.order_id}`}
                            className="font-mono text-xs font-semibold text-blue-700 hover:underline"
                          >
                            {inv.orders?.order_number}
                          </Link>
                        </div>
                        <StatusBadge status={isOrderCancelled ? "cancelled" : inv.payment_status} />
                      </div>
                      <p className="text-xs text-slate-500">
                        {formatDate(inv.invoice_date)} &rarr; Due {formatDate(inv.due_date)}
                      </p>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
                        <div className="text-xs">
                          <span className="font-semibold text-slate-900">{formatCurrency(inv.total_amount, sym)}</span>
                          <span className="mx-1.5 text-slate-300">|</span>
                          <span className="text-emerald-700">Paid: {formatCurrency(inv.paid_amount, sym)}</span>
                          <span className="mx-1.5 text-slate-300">|</span>
                          <span className={isOrderCancelled ? "text-slate-500" : "font-semibold text-red-700"}>
                            {isOrderCancelled ? "Void" : `Due: ${formatCurrency(balance, sym)}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => setHistoryInvoice(inv)}>
                            <History className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" onClick={() => handleDownloadPdf(inv)}>
                            <FileDown className="h-3.5 w-3.5" />
                            PDF
                          </Button>
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
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Order Ref</TableHead>
                      <TableHead>Invoice / Due Date</TableHead>
                      <TableHead>GST Details</TableHead>
                      <TableHead>Total Amount</TableHead>
                      <TableHead>Balance Due</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => {
                      const isOrderCancelled = inv.orders?.order_status === "Cancelled";
                      const balance = isOrderCancelled
                        ? 0
                        : Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                      return (
                        <TableRow key={inv.id} className={isOrderCancelled ? "bg-slate-50/70" : undefined}>
                          <TableCell className="font-semibold text-slate-900">{inv.invoice_number}</TableCell>
                          <TableCell>
                            <Link
                              to={`/customer/orders/${inv.order_id}`}
                              className="font-mono text-xs font-semibold text-blue-700 hover:underline"
                            >
                              {inv.orders?.order_number}
                            </Link>
                          </TableCell>
                          <TableCell className="text-xs text-slate-600">
                            {formatDate(inv.invoice_date)} &rarr; {formatDate(inv.due_date)}
                          </TableCell>
                          <TableCell className="text-xs text-slate-600">
                            {inv.is_inter_state
                              ? `IGST ${formatCurrency(inv.igst_amount, sym)}`
                              : `CGST ${formatCurrency(inv.cgst_amount, sym)} + SGST ${formatCurrency(inv.sgst_amount, sym)}`}
                          </TableCell>
                          <TableCell>
                            <p className="font-semibold text-slate-900">{formatCurrency(inv.total_amount, sym)}</p>
                            <p className="text-xs text-emerald-700">Paid: {formatCurrency(inv.paid_amount, sym)}</p>
                          </TableCell>
                          <TableCell className={isOrderCancelled ? "text-xs text-slate-500" : "font-semibold text-red-700"}>
                            {isOrderCancelled ? "Void" : formatCurrency(balance, sym)}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={isOrderCancelled ? "cancelled" : inv.payment_status} />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setHistoryInvoice(inv)}
                                title="View Payment History"
                              >
                                <History className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" onClick={() => handleDownloadPdf(inv)}>
                                <FileDown className="h-3.5 w-3.5" />
                                PDF
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(historyInvoice)} onOpenChange={(o) => !o && setHistoryInvoice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payment History — {historyInvoice?.invoice_number}</DialogTitle>
          </DialogHeader>
          {loadingHistory ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading payments...</p>
          ) : paymentHistory.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No payments recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Ref #</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentHistory.map((p) => (
                  <TableRow key={p.id} className={p.status === "voided" ? "bg-slate-50 opacity-60 line-through" : undefined}>
                    <TableCell className="text-xs">{formatDate(p.payment_date)}</TableCell>
                    <TableCell className="text-xs font-medium">{p.payment_method}</TableCell>
                    <TableCell className="font-mono text-xs text-slate-600">{p.reference_number || "—"}</TableCell>
                    <TableCell className="text-right font-semibold text-emerald-700">
                      {p.status === "voided" ? "Voided" : formatCurrency(p.amount, sym)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
