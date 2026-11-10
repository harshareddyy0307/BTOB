import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, FileDown, History } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { generateCustomerInvoicePdf } from "@/lib/pdfGenerator";
import { formatCurrency, formatDate } from "@/lib/utils";
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

type CustomerInvoiceRow = InvoiceRecord & {
  orders: OrderRecord;
};

export function CustomerInvoicesPage() {
  const { customerProfile, branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const [historyInvoice, setHistoryInvoice] = useState<CustomerInvoiceRow | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["customer-invoices", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("*, orders(*)")
        .eq("customer_id", customerProfile!.id)
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CustomerInvoiceRow[];
    },
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
    if (!agency || !customerProfile) return;
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

  const totalBilled = invoices.reduce((s, i) => s + Number(i.total_amount), 0);
  const totalPaid = invoices.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalDue = Math.max(0, totalBilled - totalPaid);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
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
            <p className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(totalBilled, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Paid</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{formatCurrency(totalPaid, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Outstanding Dues</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{formatCurrency(totalDue, sym)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your Invoices ({invoices.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
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
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                    Loading invoices...
                  </TableCell>
                </TableRow>
              ) : invoices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                    No tax invoices have been generated for your account yet.
                  </TableCell>
                </TableRow>
              ) : (
                invoices.map((inv) => {
                  const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                  return (
                    <TableRow key={inv.id}>
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
                      <TableCell className="font-semibold text-red-700">{formatCurrency(balance, sym)}</TableCell>
                      <TableCell>
                        <StatusBadge status={inv.payment_status} />
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
                })
              )}
            </TableBody>
          </Table>
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
