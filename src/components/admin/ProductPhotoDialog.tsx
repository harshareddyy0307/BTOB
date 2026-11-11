import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type { AdminProduct } from "@/types/database";
import { ProductPhotoEditor, type ProductPhotoDraft } from "@/components/admin/ProductPhotoEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

interface ProductPhotoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: AdminProduct | null;
  onSaved?: () => void;
}

export function sortProductImages(images?: AdminProduct["product_images"]): ProductPhotoDraft[] {
  if (!images || images.length === 0) return [];
  const sorted = [...images].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
  return sorted.map((img, idx) => ({
    image_url: img.image_url,
    is_primary: idx === 0 ? true : Boolean(img.is_primary),
  }));
}

export function ProductPhotoDialog({ open, onOpenChange, product, onSaved }: ProductPhotoDialogProps) {
  const { userProfile } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [photos, setPhotos] = useState<ProductPhotoDraft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !product) return;
    setPhotos(sortProductImages(product.product_images));
  }, [open, product]);

  const handleSave = async () => {
    if (!product) return;
    setSaving(true);
    try {
      const { error: delErr } = await supabase
        .from("product_images")
        .delete()
        .eq("product_id", product.id);
      if (delErr) throw delErr;

      if (photos.length > 0) {
        const hasPrimary = photos.some((p) => p.is_primary);
        const rows = photos.map((p, i) => ({
          product_id: product.id,
          image_url: p.image_url,
          is_primary: hasPrimary ? p.is_primary : i === 0,
          sort_order: i,
        }));
        const { error: insErr } = await supabase.from("product_images").insert(rows);
        if (insErr) throw insErr;
      }

      if (userProfile?.id) {
        await supabase.from("audit_logs").insert({
          actor_user_id: userProfile.id,
          action: "update_product_photos",
          entity_type: "products",
          entity_id: product.id,
          new_data: {
            product_name: product.name,
            photo_count: photos.length,
          },
        });
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-all-products"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products"] }),
        queryClient.invalidateQueries({ queryKey: ["customer-home-catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["customer-all-products"] }),
        queryClient.invalidateQueries({ queryKey: ["customer-category-products"] }),
        queryClient.invalidateQueries({ queryKey: ["customer-product-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["customer-cart"] }),
      ]);

      toast({
        title: "Product photos saved",
        description:
          photos.length > 0
            ? `${photos.length} photo${photos.length > 1 ? "s" : ""} updated for "${product.name}".`
            : `All photos removed from "${product.name}".`,
        type: "success",
      });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Failed to save product photos",
        description: err instanceof Error ? err.message : "Database error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-blue-700" />
            Product Photos{product ? ` — ${product.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            {product?.sku ? `SKU: ${product.sku} • ` : ""}
            {product?.is_published
              ? "Published product: saved cover and gallery photos appear immediately in the Customer Portal."
              : "Draft product: saved photos are stored now and will appear to customers once published."}
          </DialogDescription>
        </DialogHeader>

        <ProductPhotoEditor
          photos={photos}
          onChange={setPhotos}
          storageFolder={product ? `catalog/${product.id}` : "catalog"}
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save Product Photos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
