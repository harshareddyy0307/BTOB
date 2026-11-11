import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Package, ShoppingCart, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { CustomerCatalogProduct } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function CustomerProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { customerProfile } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [qty, setQty] = useState("1");
  const [selectedImg, setSelectedImg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setSelectedImg(null);
  }, [id]);

  const { data: product, isLoading } = useQuery({
    queryKey: ["customer-product-detail", id, customerProfile?.id],
    enabled: Boolean(id && customerProfile?.id),
    queryFn: async () => {
      const { data, error } = await supabase.from("v_customer_catalog").select("*").eq("id", id!).single();
      if (error) throw error;
      const item = data as CustomerCatalogProduct;
      setQty(String(Math.max(1, Number(item.min_order_quantity) || 1)));
      return item;
    },
  });

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-500">Loading product...</div>;
  if (!product) return <div className="py-12 text-center text-sm text-red-600">Product not found or unavailable.</div>;

  const images = Array.isArray(product.image_urls) && product.image_urls.length > 0 ? product.image_urls : [];
  const mainImg = selectedImg || product.primary_image_url || images[0] || null;
  const minQty = Math.max(1, Number(product.min_order_quantity) || 1);
  const outOfStock = product.stock_status === "out_of_stock" || product.available_quantity < minQty;

  const handleAdd = async () => {
    if (!customerProfile) return;
    const requested = Number(qty);
    if (Number.isNaN(requested) || requested < minQty) {
      toast({ title: `Minimum order quantity is ${formatQty(minQty)}`, type: "error" });
      return;
    }
    if (requested > Number(product.available_quantity)) {
      toast({ title: `Only ${formatQty(product.available_quantity)} available in stock`, type: "error" });
      return;
    }
    setAdding(true);
    try {
      const { error } = await supabase.rpc("add_to_cart", {
        p_product_id: product.id,
        p_quantity: requested,
      });
      if (error) throw error;
      toast({ title: "Added to cart", type: "success" });
      queryClient.invalidateQueries({ queryKey: ["customer-cart-count"] });
      queryClient.invalidateQueries({ queryKey: ["customer-cart"] });
    } catch (err) {
      toast({ title: "Could not add to cart", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link to="/customer/products" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" />
        Back to Products
      </Link>

      <Card>
        <CardContent className="grid gap-8 p-6 md:grid-cols-2">
          <div className="space-y-3">
            <div className="aspect-square overflow-hidden rounded-lg border bg-slate-100">
              {mainImg ? (
                <img src={mainImg} alt={product.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-400">
                  <Package className="h-14 w-14" />
                </div>
              )}
            </div>
            {images.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {images.map((url) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setSelectedImg(url)}
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded border transition-all ${
                      mainImg === url ? "border-blue-600 ring-2 ring-blue-200" : "hover:border-blue-400"
                    }`}
                  >
                    <img src={url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                  {product.category_name}
                </span>
                <StatusBadge status={product.stock_status} />
              </div>
              <h1 className="mt-2 text-2xl font-bold text-slate-900">{product.name}</h1>
              <p className="mt-1 font-mono text-xs text-slate-500">SKU: {product.sku}</p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-3xl font-bold text-slate-900">
                  {formatCurrency(product.selling_price)}
                  <span className="text-sm font-normal text-slate-500"> / {product.unit_of_measurement}</span>
                </p>
                {product.has_custom_price && (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    Contract Price
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Applicable GST: {product.gst_rate}% {product.hsn_code ? `• HSN: ${product.hsn_code}` : ""}
              </p>
            </div>

            <p className="text-sm leading-relaxed text-slate-600">
              {product.description || "Standard commercial B2B specification."}
            </p>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded border p-3">
                <p className="text-slate-500">Minimum Order Quantity</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">
                  {formatQty(minQty)} {product.unit_of_measurement}
                </p>
              </div>
              <div className="rounded border p-3">
                <p className="text-slate-500">Available Stock</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">
                  {formatQty(product.available_quantity)} {product.unit_of_measurement}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Input
                type="number"
                min={minQty}
                max={Math.max(minQty, Number(product.available_quantity))}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-28"
                disabled={outOfStock}
              />
              <Button className="flex-1" disabled={outOfStock || adding} onClick={handleAdd}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                {outOfStock ? "Out of Stock" : "Add to Cart"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
