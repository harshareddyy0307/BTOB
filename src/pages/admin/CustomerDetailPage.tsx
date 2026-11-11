import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Loader2, IndianRupee, Power } from "lucide-react";
import { invokeAuthenticatedFunction, supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { invalidateCatalogQueries } from "@/lib/productPublishing";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { AdminProduct, CustomerProfile, InvoiceRecord, OrderRecord } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";
import { OrderPaymentModal, type OrderPaymentTarget } from "@/components/admin/OrderPaymentModal";

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { branding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sym = branding.currency_symbol || "₹";

  const [selectedProdId, setSelectedProdId] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<OrderPaymentTarget | null>(null);

  const { data: customer, isLoading } = useQuery({
    queryKey: ["admin-customer-detail", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("*").eq("id", id!).single();
      if (error) throw error;
      return data as CustomerProfile;
    },
  });

  const { data: orders = [] } = useQuery({
    queryKey: ["admin-customer-orders", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase
        .from("orders")
        .select("*")
        .eq("customer_id", id!)
        .order("placed_at", { ascending: false });
      return (data ?? []) as OrderRecord[];
    },
  });

  const { data: invoices = [] } = useQuery({
    queryKey: ["admin-customer-invoices", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase
        .from("invoices")
        .select("*")
        .eq("customer_id", id!)
        .order("invoice_date", { ascending: false });
      return (data ?? []) as InvoiceRecord[];
    },
  });

  const { data: allProducts = [] } = useQuery({
    queryKey: ["admin-all-products-mini"],
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id, name, sku, product_prices(published_selling_price)")
        .eq("is_published", true)
        .order("name");
      return (data ?? []) as unknown as AdminProduct[];
    },
  });

  const { data: customPrices = [] } = useQuery({
    queryKey: ["admin-customer-custom-prices", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await supabase
        .from("customer_product_prices")
        .select("*, products(name, sku, product_prices(published_selling_price))")
        .eq("customer_id", id!);
      return data ?? [];
    },
  });

  const addCustomPrice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !selectedProdId || !customPrice) return;
    setSavingOverride(true);
    try {
      const { error } = await supabase.from("customer_product_prices").upsert(
        {
          customer_id: id,
          product_id: selectedProdId,
          custom_selling_price: Number(customPrice),
          is_active: true,
        },
        { onConflict: "customer_id,product_id" }
      );
      if (error) throw error;
      toast({ title: "Customer-specific selling price saved", type: "success" });
      setSelectedProdId("");
      setCustomPrice("");
      queryClient.invalidateQueries({ queryKey: ["admin-customer-custom-prices", id] });
      void invalidateCatalogQueries(queryClient);
    } catch (err) {
      toast({ title: "Could not save price override", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingOverride(false);
    }
  };

  const removeCustomPrice = async (rowId: string) => {
    await supabase.from("customer_product_prices").delete().eq("id", rowId);
    queryClient.invalidateQueries({ queryKey: ["admin-customer-custom-prices", id] });
    void invalidateCatalogQueries(queryClient);
    toast({ title: "Custom price removed", type: "info" });
  };

  const toggleCustomerStatus = async () => {
    if (!customer || togglingStatus) return;
    const nextActive = customer.status !== "active";
    const nextStatus = nextActive ? "active" : "inactive";
    setTogglingStatus(true);
    try {
      if (customer.user_id) {
        await invokeAuthenticatedFunction(
          "manage-staff-user",
          {
            action: "toggle_user_status",
            user_id: customer.user_id,
            is_active: nextActive,
            customer_status: nextStatus,
          },
          "Failed to update customer status"
        );
      } else {
        const { error } = await supabase
          .from("customers")
          .update({ status: nextStatus })
          .eq("id", customer.id);
        if (error) throw error;
      }
      toast({
        title: `${customer.business_name} is now ${nextActive ? "Active" : "Inactive"}`,
        type: nextActive ? "success" : "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-customer-detail", customer.id] }),
        queryClient.invalidateQueries({ queryKey: ["admin-customers"] }),
      ]);
    } catch (err) {
      toast({ title: "Status update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setTogglingStatus(false);
    }
  };

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-500">Loading customer profile...</div>;
  if (!customer) return <div className="py-12 text-center text-sm text-red-600">Customer not found.</div>;

  const activeOrders = orders.filter((o) => o.order_status !== "Cancelled");
  const totalOrdered = activeOrders.reduce((acc, o) => acc + Number(o.total_amount), 0);
  const totalPaid = activeOrders.reduce((acc, o) => acc + Number(o.paid_amount ?? 0), 0);
  const outstandingBalance = activeOrders.reduce(
    (acc, o) => acc + Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - Number(o.paid_amount ?? 0))),
    0
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/admin/customers" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" />
          Back to Customers
        </Link>
        <div className="flex items-center gap-2">
          <StatusBadge status={customer.status} />
          <Button
            variant="outline"
            size="sm"
            onClick={toggleCustomerStatus}
            disabled={togglingStatus}
          >
            {togglingStatus ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Power className={customer.status === "active" ? "h-3.5 w-3.5 text-amber-600" : "h-3.5 w-3.5 text-emerald-600"} />
            )}
            {customer.status === "active" ? "Deactivate" : "Activate"}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-6 p-6 md:grid-cols-3">
          <div className="md:col-span-2">
            <h1 className="text-2xl font-bold text-slate-900">{customer.business_name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Owner: <strong>{customer.owner_name}</strong> &bull; {customer.business_category || "Local Business"}
            </p>
            <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
              <p>Email: {customer.email}</p>
              <p>Phone: {customer.phone}</p>
              <p>GSTIN: {customer.gst_number || "—"}</p>
              <p>Registered: {formatDate(customer.registered_at)}</p>
              <p className="sm:col-span-2">
                Address: {[customer.business_address, customer.city, customer.state, customer.pincode].filter(Boolean).join(", ")}
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Account Financial Summary</p>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">Active Orders Total</span>
              <span className="font-semibold">{formatCurrency(totalOrdered, sym)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">Paid to Date</span>
              <span className="font-semibold text-emerald-700">{formatCurrency(totalPaid, sym)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-sm">
              <span className="font-medium text-slate-800">Amount Due</span>
              <span className={cn("font-bold", outstandingBalance > 0 ? "text-red-700" : "text-emerald-700")}>
                {formatCurrency(outstandingBalance, sym)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Customer-Specific Pricing */}
      <Card>
        <CardHeader>
          <CardTitle>Customer-Specific Selling Prices (Optional)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={addCustomPrice} className="grid items-end gap-3 sm:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Published Product</Label>
              <Select value={selectedProdId} onValueChange={setSelectedProdId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose product..." />
                </SelectTrigger>
                <SelectContent>
                  {allProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.sku}) — Standard: {formatCurrency(p.product_prices?.published_selling_price ?? 0, sym)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Custom Price ({sym})</Label>
              <Input type="number" step="0.01" min="0" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} required />
            </div>
            <Button type="submit" disabled={savingOverride || !selectedProdId}>
              {savingOverride ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Assign Price
            </Button>
          </form>

          {customPrices.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Standard Catalog Price</TableHead>
                  <TableHead>Custom Customer Price</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customPrices.map((cp) => {
                  const prod = cp.products as unknown as {
                    name: string;
                    sku: string;
                    product_prices: { published_selling_price: number };
                  };
                  return (
                    <TableRow key={cp.id}>
                      <TableCell>
                        <p className="font-medium">{prod?.name}</p>
                        <p className="font-mono text-xs text-slate-500">{prod?.sku}</p>
                      </TableCell>
                      <TableCell>{formatCurrency(prod?.product_prices?.published_selling_price ?? 0, sym)}</TableCell>
                      <TableCell className="font-semibold text-blue-700">{formatCurrency(cp.custom_selling_price, sym)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="text-red-600" onClick={() => removeCustomPrice(cp.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Previous Orders & Outstanding Invoices */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Order History &amp; Payment Dues ({orders.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total / Paid</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                      No orders placed yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((o) => {
                    const paidAmt = Number(o.paid_amount ?? 0);
                    const dueAmt =
                      o.order_status === "Cancelled"
                        ? 0
                        : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Link to={`/admin/orders/${o.id}`} className="font-semibold text-blue-700 hover:underline">
                            {o.order_number}
                          </Link>
                          <p className="text-[11px] text-slate-500">{formatDate(o.placed_at)}</p>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={o.order_status} />
                            <StatusBadge status={o.payment_status} />
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <p className="font-semibold text-slate-900">{formatCurrency(o.total_amount, sym)}</p>
                          <p className="text-emerald-700">Paid: {formatCurrency(paidAmt, sym)}</p>
                        </TableCell>
                        <TableCell className={cn("text-xs font-bold", dueAmt > 0 ? "text-red-700" : "text-emerald-700")}>
                          {o.order_status === "Cancelled" ? "—" : formatCurrency(dueAmt, sym)}
                        </TableCell>
                        <TableCell className="text-right">
                          {o.order_status !== "Cancelled" && (
                            <Button
                              size="sm"
                              variant={dueAmt > 0 ? "default" : "outline"}
                              onClick={() =>
                                setPaymentOrder({
                                  id: o.id,
                                  order_number: o.order_number,
                                  customer_name: customer.business_name,
                                  total_amount: Number(o.total_amount),
                                  paid_amount: paidAmt,
                                  due_amount: dueAmt,
                                  payment_status: o.payment_status,
                                  order_status: o.order_status,
                                })
                              }
                            >
                              <IndianRupee className="h-3.5 w-3.5" />
                              Pay
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invoices ({invoices.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Balance Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-slate-500">
                      No invoices issued yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-semibold">{inv.invoice_number}</TableCell>
                      <TableCell className="text-xs text-slate-500">{formatDate(inv.due_date)}</TableCell>
                      <TableCell>
                        <StatusBadge status={inv.payment_status} />
                      </TableCell>
                      <TableCell className="text-right font-semibold text-red-700">
                        {formatCurrency(Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount)), sym)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <OrderPaymentModal order={paymentOrder} onClose={() => setPaymentOrder(null)} />
    </div>
  );
}
