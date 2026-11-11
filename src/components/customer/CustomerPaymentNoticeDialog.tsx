import React, { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency } from "@/lib/utils";
import { PAYMENT_METHODS, type PaymentMethod } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

export interface CustomerNoticeOrderTarget {
  id: string;
  order_number: string;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
}

interface CustomerPaymentNoticeDialogProps {
  order: CustomerNoticeOrderTarget | null;
  onClose: () => void;
}

export function CustomerPaymentNoticeDialog({ order, onClose }: CustomerPaymentNoticeDialogProps) {
  const { branding } = useAuth();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("UPI");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const dueAmount = Math.max(0, Number(order?.due_amount ?? 0));

  useEffect(() => {
    if (!order) return;
    setAmount(dueAmount.toFixed(2));
    setMethod("UPI");
    setReference("");
    setNotes("");
  }, [order, dueAmount]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;

    const numAmt = Number(amount);
    if (!Number.isFinite(numAmt) || numAmt <= 0 || numAmt > dueAmount + 0.01) {
      toast({
        title: "Invalid payment amount",
        description: `Please enter an amount up to remaining due (${formatCurrency(dueAmount, sym)}).`,
        type: "error",
      });
      return;
    }

    if (reference.trim().length < 2) {
      toast({ title: "Transaction reference / UTR number is required", type: "error" });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("submit_customer_payment_notice", {
        p_order_id: order.id,
        p_amount: Number(numAmt.toFixed(2)),
        p_payment_method: method,
        p_reference_number: reference.trim(),
        p_notes: notes.trim() || null,
      });
      if (error) throw error;

      toast({
        title: `Payment notice sent for ${order.order_number}`,
        description: "The agency admin has been notified to verify your transfer and update your due balance.",
        type: "success",
      });
      onClose();
    } catch (err) {
      toast({
        title: "Could not send payment notice",
        description: err instanceof Error ? err.message : "Submission failed",
        type: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(order)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Report Payment Made — {order?.order_number}</DialogTitle>
        </DialogHeader>

        {order && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-3">
              <div>
                <p className="text-slate-500">Order Total</p>
                <p className="font-bold text-slate-900">{formatCurrency(order.total_amount, sym)}</p>
              </div>
              <div>
                <p className="text-slate-500">Paid</p>
                <p className="font-bold text-emerald-700">{formatCurrency(order.paid_amount, sym)}</p>
              </div>
              <div>
                <p className="text-slate-500">Amount Due</p>
                <p className="font-bold text-red-700">{formatCurrency(dueAmount, sym)}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Amount Paid ({sym}) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={dueAmount.toFixed(2)}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
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
            </div>

            <div className="space-y-1.5">
              <Label>UTR / Transaction / Cheque Reference # *</Label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. UTR42918273645"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Payment Remark (Optional)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Bank name, partial installment note..."
              />
            </div>

            <p className="text-[11px] text-slate-500">
              Submitting sends an instant payment notification to the agency so they can verify and mark your order Paid / Partially Paid.
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Notify Agency
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
