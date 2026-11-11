import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Loader2, RotateCcw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { cn, formatCurrency, toLocalDateString } from "@/lib/utils";
import {
  PAYMENT_METHODS,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export interface OrderPaymentTarget {
  id: string;
  order_number: string;
  customer_name: string;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
  payment_status: PaymentStatus;
  order_status: OrderStatus;
}

export interface PaymentPrefill {
  amount?: number;
  method?: PaymentMethod;
  reference?: string;
  notes?: string;
}

type PayAction = "mark_paid" | "partial_payment" | "mark_unpaid";

export function parsePaymentClaimNotification(message: string): PaymentPrefill {
  const match = message.match(/reported payment of ₹([\d,.]+)\s+via\s+([^()]+?)\s+\(Ref:\s*([^)]+)\)/i);
  if (!match) return {};
  const parsedAmount = Number(match[1].replace(/,/g, ""));
  const rawMethod = match[2].trim() as PaymentMethod;
  const method = PAYMENT_METHODS.includes(rawMethod) ? rawMethod : "Bank Transfer";
  const reference = match[3].trim();
  return {
    amount: Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : undefined,
    method,
    reference,
  };
}

interface OrderPaymentModalProps {
  order: OrderPaymentTarget | null;
  prefill?: PaymentPrefill | null;
  onClose: () => void;
}

export function OrderPaymentModal({ order, prefill, onClose }: OrderPaymentModalProps) {
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [action, setAction] = useState<PayAction>("mark_paid");
  const [partialAmount, setPartialAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("Bank Transfer");
  const [reference, setReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(toLocalDateString());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const totalAmount = Number(order?.total_amount ?? 0);
  const currentPaid = Number(order?.paid_amount ?? 0);
  const currentDue = Math.max(0, Number(order?.due_amount ?? totalAmount - currentPaid));

  useEffect(() => {
    if (!order) return;
    const due = Math.max(0, Number(order.due_amount ?? Number(order.total_amount) - Number(order.paid_amount)));
    const paid = Number(order.paid_amount ?? 0);

    if (due <= 0) {
      setAction("mark_unpaid");
      setPartialAmount("");
    } else if (prefill?.amount && prefill.amount < due - 0.01) {
      setAction("partial_payment");
      setPartialAmount(prefill.amount.toFixed(2));
    } else {
      setAction("mark_paid");
      setPartialAmount(due > 0 ? (Math.round((due / 2) * 100) / 100).toFixed(2) : "");
    }

    setMethod(prefill?.method ?? "Bank Transfer");
    setReference(prefill?.reference ?? "");
    setPaymentDate(toLocalDateString());
    setNotes(prefill?.notes ?? (paid > 0 && due <= 0 ? "" : ""));
  }, [order, prefill]);

  const parsedPartial = Number(partialAmount || 0);
  const partialValid = Number.isFinite(parsedPartial) && parsedPartial > 0 && parsedPartial <= currentDue + 0.01;
  const previewPaidAfterPartial = partialValid ? Math.min(totalAmount, currentPaid + parsedPartial) : currentPaid;
  const previewDueAfterPartial = Math.max(0, totalAmount - previewPaidAfterPartial);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;

    if (action === "partial_payment" && !partialValid) {
      toast({
        title: "Enter a valid partial payment amount",
        description: `Must be between 0.01 and ${formatCurrency(currentDue, sym)}.`,
        type: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("update_order_payment_admin", {
        p_order_id: order.id,
        p_action: action,
        p_amount: action === "partial_payment" ? Number(parsedPartial.toFixed(2)) : null,
        p_payment_method: method,
        p_reference_number: reference.trim() || null,
        p_payment_date: paymentDate,
        p_notes: notes.trim() || null,
      });
      if (error) throw error;

      const res = (data ?? {}) as { paid_amount?: number; due_amount?: number; payment_status?: string };
      const label =
        res.payment_status === "paid"
          ? "Order marked Paid"
          : res.payment_status === "partially_paid"
          ? "Partial payment recorded"
          : "Order marked Unpaid";

      toast({
        title: `${label} — ${order.order_number}`,
        description: `Paid: ${formatCurrency(res.paid_amount ?? 0, sym)} • Remaining Due: ${formatCurrency(
          res.due_amount ?? 0,
          sym
        )}`,
        type: "success",
      });

      queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-detail", order.id] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-invoice", order.id] });
      queryClient.invalidateQueries({ queryKey: ["admin-invoice-payments"] });
      queryClient.invalidateQueries({ queryKey: ["admin-daily-operations"] });
      queryClient.invalidateQueries({ queryKey: ["admin-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders-needing-invoice"] });
      queryClient.invalidateQueries({ queryKey: ["admin-invoice-payments-modal"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-customer-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["admin-reports-dataset"] });
      queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
      queryClient.invalidateQueries({ queryKey: ["admin-order-payment-claims"] });
      onClose();
    } catch (err) {
      toast({
        title: "Payment update failed",
        description: err instanceof Error ? err.message : "Could not update order payment status",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const isCancelled = order?.order_status === "Cancelled";

  return (
    <Dialog open={Boolean(order)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Update Order Payment — {order?.order_number}</DialogTitle>
        </DialogHeader>

        {order && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Financial Summary Strip */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-xs font-medium text-slate-600">
                  Customer: <strong className="text-slate-900">{order.customer_name}</strong>
                </p>
                <StatusBadge status={order.payment_status} />
              </div>
              <div className="grid grid-cols-1 gap-2 border-t border-slate-200 pt-2.5 text-xs sm:grid-cols-3">
                <div>
                  <p className="text-slate-500">Order Total</p>
                  <p className="font-bold text-slate-900">{formatCurrency(totalAmount, sym)}</p>
                </div>
                <div>
                  <p className="text-slate-500">Paid So Far</p>
                  <p className="font-bold text-emerald-700">{formatCurrency(currentPaid, sym)}</p>
                </div>
                <div>
                  <p className="text-slate-500">Amount Due</p>
                  <p className={cn("font-bold", currentDue > 0 ? "text-red-700" : "text-emerald-700")}>
                    {formatCurrency(currentDue, sym)}
                  </p>
                </div>
              </div>
            </div>

            {isCancelled ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800">
                This order is Cancelled. Cancelled orders cannot receive or modify payments.
              </div>
            ) : (
              <>
                {/* 3 Payment Action Selector */}
                <div className="space-y-1.5">
                  <Label className="text-xs uppercase tracking-wider text-slate-500">Select Payment Status / Action</Label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <button
                      type="button"
                      disabled={currentDue <= 0}
                      onClick={() => setAction("mark_paid")}
                      className={cn(
                        "flex flex-col items-start rounded-md border p-2.5 text-left transition-all",
                        currentDue <= 0
                          ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-50"
                          : action === "mark_paid"
                          ? "border-emerald-600 bg-emerald-50 text-emerald-900 ring-1 ring-emerald-600"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      )}
                    >
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span className="mt-1 text-xs font-bold">Paid</span>
                      <span className="text-[11px] text-slate-500">Settle full due</span>
                    </button>

                    <button
                      type="button"
                      disabled={currentDue <= 0}
                      onClick={() => setAction("partial_payment")}
                      className={cn(
                        "flex flex-col items-start rounded-md border p-2.5 text-left transition-all",
                        currentDue <= 0
                          ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-50"
                          : action === "partial_payment"
                          ? "border-amber-600 bg-amber-50 text-amber-900 ring-1 ring-amber-600"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      )}
                    >
                      <Clock className="h-4 w-4 text-amber-600" />
                      <span className="mt-1 text-xs font-bold">Partially Paid</span>
                      <span className="text-[11px] text-slate-500">Custom amount</span>
                    </button>

                    <button
                      type="button"
                      disabled={currentPaid <= 0 && order.payment_status === "unpaid"}
                      onClick={() => setAction("mark_unpaid")}
                      className={cn(
                        "flex flex-col items-start rounded-md border p-2.5 text-left transition-all",
                        currentPaid <= 0 && order.payment_status === "unpaid"
                          ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-50"
                          : action === "mark_unpaid"
                          ? "border-red-600 bg-red-50 text-red-900 ring-1 ring-red-600"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      )}
                    >
                      <RotateCcw className="h-4 w-4 text-red-600" />
                      <span className="mt-1 text-xs font-bold">Unpaid</span>
                      <span className="text-[11px] text-slate-500">Reset due balance</span>
                    </button>
                  </div>
                </div>

                {action === "mark_unpaid" ? (
                  <div className="space-y-3 rounded-md border border-red-200 bg-red-50/70 p-3">
                    <p className="text-xs font-medium text-red-800">
                      This will void recorded receipt(s) for this order and restore{" "}
                      <strong>{formatCurrency(totalAmount, sym)}</strong> as Amount Due. Audit history is preserved.
                    </p>
                    <div className="space-y-1.5">
                      <Label>Reason / Adjustment Note</Label>
                      <Input
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="e.g. Cheque returned / wrong entry corrected..."
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {action === "partial_payment" ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label>Amount Received ({sym}) *</Label>
                          <span className="text-[11px] text-slate-500">
                            Max due: {formatCurrency(currentDue, sym)}
                          </span>
                        </div>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={currentDue.toFixed(2)}
                          value={partialAmount}
                          onChange={(e) => setPartialAmount(e.target.value)}
                          required
                        />
                        {partialValid && (
                          <div className="flex items-center justify-between rounded bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                            <span>New Paid: {formatCurrency(previewPaidAfterPartial, sym)}</span>
                            <span className="font-semibold">
                              New Due: {formatCurrency(previewDueAfterPartial, sym)}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                        <span>Recording full remaining due balance:</span>
                        <strong className="text-sm">{formatCurrency(currentDue, sym)}</strong>
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Payment Method *</Label>
                        <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
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
                      <div className="space-y-1.5">
                        <Label>Payment Date *</Label>
                        <Input
                          type="date"
                          value={paymentDate}
                          onChange={(e) => setPaymentDate(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>UTR / Cheque / Ref #</Label>
                        <Input
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          placeholder="e.g. UTR40129988"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Notes</Label>
                        <Input
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder="Optional note..."
                        />
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-500">
                      Automatically syncs customer GST invoice &amp; notifies the customer portal immediately.
                    </p>
                  </div>
                )}
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {!isCancelled && (
                <Button
                  type="submit"
                  variant={action === "mark_unpaid" ? "destructive" : "default"}
                  disabled={saving}
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {action === "mark_paid"
                    ? "Confirm Paid"
                    : action === "partial_payment"
                    ? "Record Partial Payment"
                    : "Reset to Unpaid"}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
