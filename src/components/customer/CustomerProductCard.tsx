import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Package, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { CustomerCatalogProduct } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function CustomerProductCard({ product }: { product: CustomerCatalogProduct }) {
  const { customerProfile, branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const minQty = Math.max(1, Number(product.min_order_quantity) || 1);
  const [qty, setQty] = useState<string>(String(minQty));
  const [adding, setAdding] = useState(false);

  const outOfStock = product.stock_status === "out_of_stock" || product.available_quantity < minQty;

  const handleAddToCart = async () => {
    if (!customerProfile) return;
    const requested = Number(qty);
    if (Number.isNaN(requested) || requested < minQty) {
      toast({
        title: `Minimum order quantity is ${formatQty(minQty)} ${product.unit_of_measurement}`,
        type: "error",
      });
      return;
    }

    setAdding(true);
    try {
      const { error } = await supabase.rpc("add_to_cart", {
        p_product_id: product.id,
        p_quantity: requested,
      });
      if (error) throw error;

      toast({
        title: "Added to cart",
        description: `${formatQty(requested)} × ${product.name}`,
        type: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["customer-cart-count"] });
      queryClient.invalidateQueries({ queryKey: ["customer-cart"] });
    } catch (err) {
      toast({ title: "Could not add to cart", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Card className="flex flex-col overflow-hidden transition-colors hover:border-blue-300">
      <Link to={`/customer/products/${product.id}`} className="block aspect-[4/3] bg-slate-100 overflow-hidden">
        {product.primary_image_url ? (
          <img
            src={product.primary_image_url}
            alt={product.name}
            className="h-full w-full object-cover transition-transform hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            <Package className="h-10 w-10" />
          </div>
        )}
      </Link>

      <CardContent className="flex flex-1 flex-col justify-between p-4 space-y-3">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-blue-700">
              {product.category_name}
            </span>
            <StatusBadge status={product.stock_status} />
          </div>

          <Link to={`/customer/products/${product.id}`} className="mt-1 block font-semibold text-slate-900 hover:underline">
            {product.name}
          </Link>
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">{product.description || `SKU: ${product.sku}`}</p>
        </div>

        <div className="space-y-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-lg font-bold text-slate-900">
                {formatCurrency(product.selling_price, sym)}
                <span className="text-xs font-normal text-slate-500"> / {product.unit_of_measurement}</span>
              </p>
              <p className="text-[11px] text-slate-500">
                MOQ: {formatQty(minQty)} {product.unit_of_measurement} &bull; +{product.gst_rate}% GST
              </p>
            </div>
            {product.has_custom_price && (
              <span className="shrink-0 rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                Contract Price
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={minQty}
              max={Math.max(minQty, Number(product.available_quantity))}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="h-8 w-20 text-xs"
              disabled={outOfStock}
            />
            <Button size="sm" className="flex-1 h-8 text-xs" disabled={outOfStock || adding} onClick={handleAddToCart}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShoppingCart className="h-3.5 w-3.5" />}
              {outOfStock ? "Out of Stock" : "Add to Cart"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
