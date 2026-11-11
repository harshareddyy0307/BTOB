import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReceiptIndianRupee,
  FileDown,
  IndianRupee,
  History,
  Plus,
  Loader2,
  Search,
  ExternalLink,
} from "lucide-react";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { getManufacturerAssetSignedUrl } from "@/lib/storage";
import { generateCustomerInvoicePdf } from "@/lib/pdfGenerator";
import { formatCurrency, formatDate, toLocalDateString } from "@/lib/utils";
import {
  PAYMENT_METHODS,
  type AgencySettings,
  type CustomerProfile,
  type InvoiceRecord,
  type OrderItemRecord,
  type OrderRecord,
  type PaymentMethod,
  type PaymentRecord,
  type PurchaseOrderRecord,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

interface InvoiceWithRelations extends InvoiceRecord {
  customers: CustomerProfile;
  orders: OrderRecord;
}

export function InvoicesPage() {
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [generatingOrderId, setGeneratingOrderId] = useState<string | null>(null);

  // Payment Recording Modal
  const [payInvoice, setPayInvoice] = useState<InvoiceWithRelations | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PaymentMethod>("Bank Transfer");
  const [payRef, setPayRef] = useState("");
  const [payDate, setPayDate] = useState(toLocalDateString());
  const [payNotes, setPayNotes] = useState("");
  const [recordingPay, setRecordingPay] = useState(false);

  // Payment History Modal
  const [historyInvoice, setHistoryInvoice] = useState<InvoiceWithRelations | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["admin-invoices"],
    queryFn: async () =>
      fetchAllRows<InvoiceWithRelations>((from, to) =>
        supabase
          .from("invoices")
          .select("*, customers(*), orders(*)")
          .order("invoice_date", { ascending: false })
          .range(from, to)
      ),
  });

  const { data: ordersWithoutInvoice = [] } = useQuery({
    queryKey: ["admin-orders-needing-invoice"],
    queryFn: async () => {
      const rows = await fetchAllRows<{
        id: string;
        order_number: string;
        total_amount: number;
        order_status: string;
        placed_at: string;
        customers: { business_name: string } | null;
        invoices: { id: string }[] | { id: string } | null;
      }>((from, to) =>
        supabase
          .from("orders")
          .select("id, order_number, total_amount, order_status, placed_at, customers(business_name), invoices(id)")
          .neq("order_status", "Cancelled")
          .order("placed_at", { ascending: false })
          .range(from, to)
      );
      return rows.filter((o) => {
        const inv = o.invoices;
        return Array.isArray(inv) ? inv.length === 0 : !inv;
      });
    },
  });

  const { data: mfgPos = [] } = useQuery({
    queryKey: ["admin-mfg-purchase-invoices"],
    queryFn: async () =>
      fetchAllRows<PurchaseOrderRecord>((from, to) =>
        supabase
          .from("purchase_orders")
          .select("*, manufacturers(*), orders(id, order_number, order_status)")
          .order("created_at", { ascending: false })
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

  const { data: selectedInvoicePayments = [], isLoading: loadingPayHistory } = useQuery({
    queryKey: ["admin-invoice-payments-modal", historyInvoice?.id],
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

  const handleGenerateInvoice = async (orderId: string) => {
    setGeneratingOrderId(orderId);
    try {
      const { error } = await supabase.rpc("generate_customer_invoice", { p_order_id: orderId, p_due_days: 15 });
      if (error) throw error;
      toast({ title: "Customer GST Invoice generated", type: "success" });
      queryClient.invalidateQueries({ queryKey: ["admin-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders-needing-invoice"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-daily-operations"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-detail"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-invoices"] });
    } catch (err) {
      toast({ title: "Could not generate invoice", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setGeneratingOrderId(null);
    }
  };

  const openPaymentModal = (inv: InvoiceWithRelations) => {
    const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
    setPayInvoice(inv);
    setPayAmount(balance.toFixed(2));
    setPayMethod("Bank Transfer");
    setPayRef("");
    setPayDate(toLocalDateString());
    setPayNotes("");
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payInvoice) return;
    setRecordingPay(true);
    try {
      const { error } = await supabase.rpc("record_invoice_payment", {
        p_invoice_id: payInvoice.id,
        p_amount: Number(payAmount),
        p_payment_method: payMethod,
        p_reference_number: payRef.trim() || null,
        p_payment_date: payDate,
        p_notes: payNotes.trim() || null,
      });
      if (error) throw error;
      toast({ title: "Payment recorded successfully", type: "success" });
      setPayInvoice(null);
      queryClient.invalidateQueries({ queryKey: ["admin-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-daily-operations"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-detail"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-invoice"] });
      queryClient.invalidateQueries({ queryKey: ["admin-invoice-payments"] });
      queryClient.invalidateQueries({ queryKey: ["admin-invoice-payments-modal"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["admin-reports-dataset"] });
      queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-payment-claims"] });
    } catch (err) {
      toast({ title: "Failed to record payment", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setRecordingPay(false);
    }
  };

  const handleDownloadPdf = async (inv: InvoiceWithRelations) => {
    if (!agency) {
      toast({ title: "Cannot generate Invoice PDF", description: "Agency settings are still loading.", type: "error" });
      return;
    }
    const [{ data: orderItems }, { data: payments }] = await Promise.all([
      supabase.from("order_items").select("*").eq("order_id", inv.order_id).order("created_at"),
      supabase.from("payments").select("*").eq("invoice_id", inv.id).order("payment_date"),
    ]);

    generateCustomerInvoicePdf({
      agency,
      invoice: inv,
      customer: inv.customers,
      order: inv.orders,
      items: (orderItems ?? []) as OrderItemRecord[],
      payments: ((payments ?? []) as PaymentRecord[]).filter((p) => p.status !== "voided"),
    });
  };

  const openSignedMfgDoc = async (path: string) => {
    const url = await getManufacturerAssetSignedUrl(path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const activeInvoices = invoices.filter((i) => i.orders?.order_status !== "Cancelled");
  const totalBilled = activeInvoices.reduce((s, i) => s + Number(i.total_amount), 0);
  const totalCollected = activeInvoices.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalOutstanding = Math.max(0, totalBilled - totalCollected);

  const filteredInvoices = invoices.filter((i) => {
    const effectiveStatus = i.orders?.order_status === "Cancelled" ? "cancelled" : i.payment_status;
    if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      i.invoice_number.toLowerCase().includes(q) ||
      (i.customers?.business_name || "").toLowerCase().includes(q) ||
      (i.orders?.order_number || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">Invoices &amp; Payments</h1>
        <p className="text-sm text-slate-500">
          Generate Indian GST invoices (CGST+SGST / IGST), track customer receivables, record payments, and audit manufacturer bills.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Billed (Receivables)</p>
            <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{formatCurrency(totalBilled, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Payments Collected</p>
            <p className="mt-1 text-xl font-bold text-emerald-700 sm:text-2xl">{formatCurrency(totalCollected, sym)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-slate-500">Total Outstanding Balance</p>
            <p className="mt-1 text-xl font-bold text-red-700 sm:text-2xl">{formatCurrency(totalOutstanding, sym)}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="customer">
        <TabsList>
          <TabsTrigger value="customer">Customer Tax Invoices ({invoices.length})</TabsTrigger>
          <TabsTrigger value="awaiting">Orders Needing Invoice ({ordersWithoutInvoice.length})</TabsTrigger>
          <TabsTrigger value="manufacturer">Manufacturer Purchase Documents ({mfgPos.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="customer" className="space-y-4">
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search invoice #, customer, order #..."
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Payment Statuses</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                  <SelectItem value="partially_paid">Partially Paid</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="cancelled">Void (Cancelled Order)</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {isLoading ? (
                  <p className="py-10 text-center text-sm text-slate-500">Loading invoices...</p>
                ) : filteredInvoices.length === 0 ? (
                  <p className="py-10 text-center text-sm text-slate-500">No invoices found.</p>
                ) : (
                  filteredInvoices.map((inv) => {
                    const isOrderCancelled = inv.orders?.order_status === "Cancelled";
                    const balance = isOrderCancelled
                      ? 0
                      : Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                    return (
                      <div key={inv.id} className={isOrderCancelled ? "space-y-2.5 bg-slate-50/70 p-4 text-xs" : "space-y-2.5 p-4 text-xs"}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900">{inv.invoice_number}</p>
                            <p className="text-slate-500">
                              {formatDate(inv.invoice_date)} &bull; Due {formatDate(inv.due_date)}
                            </p>
                          </div>
                          <StatusBadge status={isOrderCancelled ? "cancelled" : inv.payment_status} />
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link
                            to={`/admin/customers/${inv.customer_id}`}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {inv.customers?.business_name}
                          </Link>
                          <Link
                            to={`/admin/orders/${inv.order_id}`}
                            className="font-mono font-semibold text-blue-700 hover:underline"
                          >
                            {inv.orders?.order_number}
                          </Link>
                        </div>

                        <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-100 bg-slate-50 p-2.5">
                          <div>
                            <span className="text-slate-500">Total: </span>
                            <strong className="text-slate-900">{formatCurrency(inv.total_amount, sym)}</strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Paid: </span>
                            <strong className="text-emerald-700">{formatCurrency(inv.paid_amount, sym)}</strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Due: </span>
                            <strong className={isOrderCancelled ? "text-slate-500" : "text-red-700"}>
                              {isOrderCancelled ? "Void" : formatCurrency(balance, sym)}
                            </strong>
                          </div>
                          <div className="text-slate-600">
                            {inv.is_inter_state
                              ? `IGST: ${formatCurrency(inv.igst_amount, sym)}`
                              : `CGST+SGST: ${formatCurrency(Number(inv.cgst_amount) + Number(inv.sgst_amount), sym)}`}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {!isOrderCancelled && inv.payment_status !== "paid" && (
                            <Button size="sm" onClick={() => openPaymentModal(inv)}>
                              <IndianRupee className="h-3.5 w-3.5" />
                              Pay
                            </Button>
                          )}
                          <Button variant="outline" size="sm" onClick={() => setHistoryInvoice(inv)}>
                            <History className="h-3.5 w-3.5" />
                            History
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => handleDownloadPdf(inv)}>
                            <FileDown className="h-3.5 w-3.5 text-blue-700" />
                            PDF
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Customer Business</TableHead>
                      <TableHead>Order Ref</TableHead>
                      <TableHead>GST Breakdown</TableHead>
                      <TableHead>Total / Paid</TableHead>
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
                    ) : filteredInvoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-10 text-center text-slate-500">
                          No invoices found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredInvoices.map((inv) => {
                        const isOrderCancelled = inv.orders?.order_status === "Cancelled";
                        const balance = isOrderCancelled
                          ? 0
                          : Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                        return (
                          <TableRow key={inv.id} className={isOrderCancelled ? "bg-slate-50/70" : undefined}>
                            <TableCell>
                              <p className="font-semibold text-slate-900">{inv.invoice_number}</p>
                              <p className="text-xs text-slate-500">
                                {formatDate(inv.invoice_date)} &bull; Due {formatDate(inv.due_date)}
                              </p>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/admin/customers/${inv.customer_id}`}
                                className="font-medium text-slate-900 hover:underline"
                              >
                                {inv.customers?.business_name}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/admin/orders/${inv.order_id}`}
                                className="font-mono text-xs font-semibold text-blue-700 hover:underline"
                              >
                                {inv.orders?.order_number}
                              </Link>
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              {inv.is_inter_state ? (
                                <span>IGST: {formatCurrency(inv.igst_amount, sym)}</span>
                              ) : (
                                <span>
                                  CGST {formatCurrency(inv.cgst_amount, sym)} + SGST {formatCurrency(inv.sgst_amount, sym)}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <p className="font-semibold text-slate-900">{formatCurrency(inv.total_amount, sym)}</p>
                              <p className="text-xs text-emerald-700">Paid: {formatCurrency(inv.paid_amount, sym)}</p>
                            </TableCell>
                            <TableCell className={isOrderCancelled ? "text-xs font-medium text-slate-500" : "font-semibold text-red-700"}>
                              {isOrderCancelled ? "Void" : formatCurrency(balance, sym)}
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={isOrderCancelled ? "cancelled" : inv.payment_status} />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="inline-flex items-center gap-1">
                                {!isOrderCancelled && inv.payment_status !== "paid" && (
                                  <Button size="sm" onClick={() => openPaymentModal(inv)}>
                                    <IndianRupee className="h-3.5 w-3.5" />
                                    Pay
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setHistoryInvoice(inv)}
                                  title="Payment History"
                                >
                                  <History className="h-4 w-4 text-slate-600" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDownloadPdf(inv)}
                                  title="Download Tax Invoice PDF"
                                >
                                  <FileDown className="h-4 w-4 text-blue-700" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="awaiting">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ReceiptIndianRupee className="h-4 w-4 text-blue-700" />
                Orders Ready for GST Invoice Generation
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {ordersWithoutInvoice.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">All active orders already have invoices generated.</p>
                ) : (
                  ordersWithoutInvoice.map((o) => {
                    const custName = (o.customers as unknown as { business_name: string })?.business_name;
                    return (
                      <div key={o.id} className="space-y-2.5 p-4 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link to={`/admin/orders/${o.id}`} className="text-sm font-semibold text-blue-700 hover:underline">
                              {o.order_number}
                            </Link>
                            <p className="text-slate-500">{formatDate(o.placed_at)}</p>
                          </div>
                          <StatusBadge status={o.order_status} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-900">{custName}</span>
                          <span className="text-sm font-bold text-slate-900">{formatCurrency(o.total_amount, sym)}</span>
                        </div>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            disabled={generatingOrderId === o.id}
                            onClick={() => handleGenerateInvoice(o.id)}
                          >
                            {generatingOrderId === o.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                            Generate GST Invoice
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Order Status</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordersWithoutInvoice.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                          All active orders already have invoices generated.
                        </TableCell>
                      </TableRow>
                    ) : (
                      ordersWithoutInvoice.map((o) => {
                        const custName = (o.customers as unknown as { business_name: string })?.business_name;
                        return (
                          <TableRow key={o.id}>
                            <TableCell>
                              <Link to={`/admin/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                                {o.order_number}
                              </Link>
                            </TableCell>
                            <TableCell className="font-medium">{custName}</TableCell>
                            <TableCell className="text-xs text-slate-500">{formatDate(o.placed_at)}</TableCell>
                            <TableCell>
                              <StatusBadge status={o.order_status} />
                            </TableCell>
                            <TableCell className="font-semibold">{formatCurrency(o.total_amount, sym)}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                disabled={generatingOrderId === o.id}
                                onClick={() => handleGenerateInvoice(o.id)}
                              >
                                {generatingOrderId === o.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Plus className="h-3.5 w-3.5" />
                                )}
                                Generate GST Invoice
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manufacturer">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manufacturer Purchase Documents &amp; Recorded Bills</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 md:hidden">
                {mfgPos.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">No purchase orders recorded yet.</p>
                ) : (
                  mfgPos.map((po) => (
                    <div key={po.id} className="space-y-2.5 p-4 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            to={`/admin/purchase-orders/${po.id}`}
                            className="text-sm font-semibold text-blue-700 hover:underline"
                          >
                            {po.po_number}
                          </Link>
                          <p className="font-medium text-slate-900">{po.manufacturers?.company_name}</p>
                        </div>
                        <StatusBadge status={po.status} />
                      </div>
                      <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-100 bg-slate-50 p-2.5">
                        <div>
                          <span className="text-slate-500">Mfg Inv #: </span>
                          <strong className="font-mono">{po.manufacturer_invoice_number || "Not logged"}</strong>
                        </div>
                        <div>
                          <span className="text-slate-500">PO Total: </span>
                          <strong className="text-slate-900">{formatCurrency(po.total_amount, sym)}</strong>
                        </div>
                        {po.manufacturer_invoice_date && (
                          <div className="col-span-2 text-slate-500">
                            Inv Date: {formatDate(po.manufacturer_invoice_date)}
                          </div>
                        )}
                      </div>
                      <div className="flex justify-end">
                        {po.manufacturer_invoice_url ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openSignedMfgDoc(po.manufacturer_invoice_url!)}
                          >
                            View Mfg Bill <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Link
                            to={`/admin/purchase-orders/${po.id}`}
                            className="text-xs font-medium text-blue-700 hover:underline"
                          >
                            Upload in PO
                          </Link>
                        )}
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
                      <TableHead>Mfg Invoice #</TableHead>
                      <TableHead>Mfg Inv Date</TableHead>
                      <TableHead>PO Total</TableHead>
                      <TableHead>PO Status</TableHead>
                      <TableHead className="text-right">Document</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mfgPos.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                          No purchase orders recorded yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      mfgPos.map((po) => (
                        <TableRow key={po.id}>
                          <TableCell>
                            <Link
                              to={`/admin/purchase-orders/${po.id}`}
                              className="font-semibold text-blue-700 hover:underline"
                            >
                              {po.po_number}
                            </Link>
                          </TableCell>
                          <TableCell className="font-medium text-slate-900">{po.manufacturers?.company_name}</TableCell>
                          <TableCell className="font-mono text-xs">{po.manufacturer_invoice_number || "Not logged"}</TableCell>
                          <TableCell className="text-xs text-slate-500">
                            {po.manufacturer_invoice_date ? formatDate(po.manufacturer_invoice_date) : "—"}
                          </TableCell>
                          <TableCell className="font-semibold">{formatCurrency(po.total_amount, sym)}</TableCell>
                          <TableCell>
                            <StatusBadge status={po.status} />
                          </TableCell>
                          <TableCell className="text-right">
                            {po.manufacturer_invoice_url ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openSignedMfgDoc(po.manufacturer_invoice_url!)}
                              >
                                View Mfg Bill <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Link
                                to={`/admin/purchase-orders/${po.id}`}
                                className="text-xs font-medium text-blue-700 hover:underline"
                              >
                                Upload in PO
                              </Link>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Record Payment Modal */}
      <Dialog open={Boolean(payInvoice)} onOpenChange={(o) => !o && setPayInvoice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment — {payInvoice?.invoice_number}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRecordPayment} className="space-y-4">
            {payInvoice && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                Customer: <strong>{payInvoice.customers?.business_name}</strong> &bull; Remaining Balance:{" "}
                <strong className="text-red-700">
                  {formatCurrency(Math.max(0, Number(payInvoice.total_amount) - Number(payInvoice.paid_amount)), sym)}
                </strong>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Payment Amount ({sym}) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Payment Method *</Label>
                <Select value={payMethod} onValueChange={(v) => setPayMethod(v as PaymentMethod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((pm) => (
                      <SelectItem key={pm} value={pm}>
                        {pm}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>UTR / Reference / Cheque No.</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="e.g. UTR12345678" />
              </div>
              <div className="space-y-1.5">
                <Label>Payment Date *</Label>
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="Settlement remark..." />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPayInvoice(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={recordingPay}>
                {recordingPay && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Payment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Payment History Modal */}
      <Dialog open={Boolean(historyInvoice)} onOpenChange={(o) => !o && setHistoryInvoice(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Payment History — {historyInvoice?.invoice_number}</DialogTitle>
          </DialogHeader>
          {loadingPayHistory ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading payments...</p>
          ) : selectedInvoicePayments.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No payments recorded for this invoice yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedInvoicePayments.map((p) => (
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
