import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Trash2, CheckCircle2, ArrowRight, Loader2, Package } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { CustomerAddress, CustomerCatalogProduct } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

interface CartRow {
  id: string;
  product_id: string;
  quantity: number;
  product?: CustomerCatalogProduct;
}

export function CustomerCartPage() {
  const { customerProfile } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [selectedAddressId, setSelectedAddressId] = useState<string>("custom");
  const [contactName, setContactName] = useState(customerProfile?.owner_name || "");
  const [contactPhone, setContactPhone] = useState(customerProfile?.phone || "");
  const [addressLine, setAddressLine] = useState(customerProfile?.business_address || "");
  const [city, setCity] = useState(customerProfile?.city || "");
  const [stateVal, setStateVal] = useState(customerProfile?.state || "Telangana");
  const [pincode, setPincode] = useState(customerProfile?.pincode || "");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);

  const [confirmedOrder, setConfirmedOrder] = useState<{
    order_id: string;
    order_number: string;
    total_amount: number;
  } | null>(null);

  const { data: addresses = [] } = useQuery({
    queryKey: ["customer-addresses", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("customer_addresses")
        .select("*")
        .eq("customer_id", customerProfile!.id)
        .order("is_default", { ascending: false });
      return (data ?? []) as CustomerAddress[];
    },
  });

  useEffect(() => {
    if (addresses.length > 0 && selectedAddressId === "custom") {
      const def = addresses.find((a) => a.is_default) || addresses[0];
      setSelectedAddressId(def.id);
      setContactName(def.contact_name || customerProfile?.owner_name || "");
      setContactPhone(def.contact_phone || customerProfile?.phone || "");
      setAddressLine(def.address_line);
      setCity(def.city);
      setStateVal(def.state);
      setPincode(def.pincode);
    }
  }, [addresses, selectedAddressId, customerProfile]);

  const { data: cartRows = [], isLoading } = useQuery({
    queryKey: ["customer-cart", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data: items, error } = await supabase
        .from("cart_items")
        .select("*")
        .eq("customer_id", customerProfile!.id)
        .eq("cart_status", "active")
        .order("created_at");
      if (error) throw error;
      if (!items || items.length === 0) return [];

      const productIds = items.map((i) => i.product_id);
      const { data: catalogItems } = await supabase
        .from("v_customer_catalog")
        .select("*")
        .in("id", productIds);

      const catMap = new Map((catalogItems ?? []).map((p) => [p.id, p as CustomerCatalogProduct]));
      return items.map((i) => ({
        ...i,
        product: catMap.get(i.product_id),
      })) as CartRow[];
    },
  });

  const handleSelectAddress = (addrId: string) => {
    setSelectedAddressId(addrId);
    const found = addresses.find((a) => a.id === addrId);
    if (found) {
      setContactName(found.contact_name || customerProfile?.owner_name || "");
      setContactPhone(found.contact_phone || customerProfile?.phone || "");
      setAddressLine(found.address_line);
      setCity(found.city);
      setStateVal(found.state);
      setPincode(found.pincode);
    }
  };

  const updateQty = async (row: CartRow, nextQty: number) => {
    const moq = Number(row.product?.min_order_quantity ?? 1);
    const maxAvail = Number(row.product?.available_quantity ?? 0);
    if (nextQty < moq) {
      toast({ title: `Minimum order quantity is ${formatQty(moq)}`, type: "error" });
      return;
    }
    if (nextQty > maxAvail) {
      toast({ title: `Only ${formatQty(maxAvail)} available in stock`, type: "error" });
      return;
    }
    await supabase.from("cart_items").update({ quantity: nextQty }).eq("id", row.id);
    queryClient.invalidateQueries({ queryKey: ["customer-cart"] });
  };

  const removeItem = async (rowId: string) => {
    await supabase.from("cart_items").delete().eq("id", rowId);
    queryClient.invalidateQueries({ queryKey: ["customer-cart"] });
    queryClient.invalidateQueries({ queryKey: ["customer-cart-count"] });
  };

  const subtotal = cartRows.reduce((acc, r) => {
    const unit = Number(r.product?.selling_price ?? 0);
    return acc + Math.round(unit * Number(r.quantity) * 100) / 100;
  }, 0);

  const taxTotal = cartRows.reduce((acc, r) => {
    const unit = Number(r.product?.selling_price ?? 0);
    const lineSub = Math.round(unit * Number(r.quantity) * 100) / 100;
    const gst = Number(r.product?.gst_rate ?? 0);
    return acc + Math.round((lineSub * gst) / 100 * 100) / 100;
  }, 0);

  const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

  const hasValidationErrors = cartRows.some((r) => {
    if (!r.product) return true;
    const q = Number(r.quantity);
    return q < Number(r.product.min_order_quantity) || q > Number(r.product.available_quantity);
  });

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addressLine.trim() || !city.trim() || !stateVal.trim() || !pincode.trim()) {
      toast({ title: "Complete delivery address details are required", type: "error" });
      return;
    }
    setPlacing(true);
    try {
      const { data, error } = await supabase.rpc("place_customer_order", {
        p_delivery_address: {
          contact_name: contactName.trim(),
          contact_phone: contactPhone.trim(),
          address_line: addressLine.trim(),
          city: city.trim(),
          state: stateVal.trim(),
          pincode: pincode.trim(),
        },
        p_notes: notes.trim() || null,
      });
      if (error) throw error;

      setConfirmedOrder(data as { order_id: string; order_number: string; total_amount: number });
      queryClient.invalidateQueries({ queryKey: ["customer-cart"] });
      queryClient.invalidateQueries({ queryKey: ["customer-cart-count"] });
      queryClient.invalidateQueries({ queryKey: ["customer-active-orders"] });
      toast({ title: "Order placed successfully!", type: "success" });
    } catch (err) {
      toast({
        title: "Could not place order",
        description: err instanceof Error ? err.message : "Validation error",
        type: "error",
      });
    } finally {
      setPlacing(false);
    }
  };

  if (confirmedOrder) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="p-8 text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Order Confirmed!</h1>
          <p className="text-sm text-slate-600">
            Your wholesale order <strong>{confirmedOrder.order_number}</strong> totaling{" "}
            <strong>{formatCurrency(confirmedOrder.total_amount)}</strong> has been received and sent to our operations
            team.
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <Button onClick={() => navigate(`/customer/orders/${confirmedOrder.order_id}`)}>
              Track Order
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={() => navigate("/customer/products")}>
              Continue Browsing
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <ShoppingCart className="h-5 w-5 text-blue-700" />
          Shopping Cart &amp; Checkout
        </h1>
        <p className="text-sm text-slate-500">Review quantities, verify minimum order requirements, and confirm delivery.</p>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">Loading your cart...</div>
      ) : cartRows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-sm text-slate-500">Your cart is currently empty.</p>
            <Link to="/customer/products" className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline">
              Browse Wholesale Catalog <ArrowRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Cart Items ({cartRows.length})</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-slate-100 p-0">
                {cartRows.map((row) => {
                  const p = row.product;
                  const unitPrice = Number(p?.selling_price ?? 0);
                  const lineSub = unitPrice * Number(row.quantity);
                  return (
                    <div key={row.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        {p?.primary_image_url ? (
                          <img src={p.primary_image_url} alt={p.name} className="h-14 w-14 rounded border object-cover" />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded border bg-slate-100 text-slate-400">
                            <Package className="h-5 w-5" />
                          </div>
                        )}
                        <div>
                          <p className="font-semibold text-slate-900">{p?.name || "Unavailable product"}</p>
                          <p className="text-xs text-slate-500">
                            {formatCurrency(unitPrice)} / {p?.unit_of_measurement} &bull; MOQ:{" "}
                            {formatQty(p?.min_order_quantity)} &bull; Stock: {formatQty(p?.available_quantity)} &bull;{" "}
                            {p?.gst_rate}% GST
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-4 sm:justify-end">
                        <Input
                          type="number"
                          min={Number(p?.min_order_quantity ?? 1)}
                          max={Number(p?.available_quantity ?? 999999)}
                          value={row.quantity}
                          onChange={(e) => updateQty(row, Number(e.target.value))}
                          className="h-8 w-24 text-sm"
                        />
                        <p className="w-24 text-right text-sm font-semibold text-slate-900">{formatCurrency(lineSub)}</p>
                        <Button variant="ghost" size="icon" className="text-red-600" onClick={() => removeItem(row.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          <div>
            <Card>
              <CardHeader>
                <CardTitle>Delivery &amp; Order Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCheckout} className="space-y-4">
                  {addresses.length > 0 && (
                    <div className="space-y-1.5">
                      <Label>Saved Delivery Address</Label>
                      <select
                        value={selectedAddressId}
                        onChange={(e) => handleSelectAddress(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-white px-3 py-1 text-sm shadow-sm"
                      >
                        {addresses.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label} — {a.city}
                          </option>
                        ))}
                        <option value="custom">Enter Different Delivery Address</option>
                      </select>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Receiving Contact</Label>
                      <Input value={contactName} onChange={(e) => setContactName(e.target.value)} required />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Phone</Label>
                      <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} required />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Delivery Address *</Label>
                    <Input value={addressLine} onChange={(e) => setAddressLine(e.target.value)} required />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} required />
                    <Input placeholder="State" value={stateVal} onChange={(e) => setStateVal(e.target.value)} required />
                    <Input placeholder="Pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} required />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Order Notes (Optional)</Label>
                    <Textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={2}
                      placeholder="Delivery timing or unloading instructions..."
                    />
                  </div>

                  <div className="space-y-2 border-t border-slate-200 pt-3 text-sm">
                    <div className="flex justify-between text-slate-600">
                      <span>Subtotal</span>
                      <span>{formatCurrency(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>Applicable GST</span>
                      <span>{formatCurrency(taxTotal)}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                      <span>Total Amount</span>
                      <span>{formatCurrency(grandTotal)}</span>
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={placing || hasValidationErrors}>
                    {placing && <Loader2 className="h-4 w-4 animate-spin" />}
                    Confirm &amp; Place Order
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
